# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
AnswerKey: the quiz answer key as on chain state, with meaning ruled by consensus.

The problem
-----------
GenPrix asks short free text questions and grades them against a hard coded list
of accepted spellings. That list is a guess made once by whoever wrote the
question. A player who types "delegated proof-of-stake" when the list happens to
carry only "dpos" is marked wrong, loses the race, and has no recourse. The
grader is not wrong about the string; it is wrong about the meaning, and a
string comparison cannot tell the difference.

Note that the game is a race. Grading has to be instant, so putting a model in
the grading path would ruin the thing it is trying to fix.

What this contract does
-----------------------
It owns the answer key and rules on meaning exactly once per novel phrasing.

  * The fast path is deterministic and needs no model. `grade` normalises the
    answer and matches it against the accepted forms already stored for that
    question, with the same single edit tolerance the client uses. The client
    reads those forms and grades locally, so a race never waits on a chain.
  * The slow path is `rule`, the only nondeterministic entry point. A player
    whose answer was marked wrong can put it to the validators: does this mean
    the same thing as the canonical answer, for this question? Validators judge
    independently and must agree on the boolean.
  * A verdict of true **appends the phrasing to the accepted forms in storage**.
    So consensus is paid once per phrasing, not once per player, and from then
    on every player who types it is graded deterministically, for free, forever.

The answer key therefore learns, and the only thing that can teach it is a
consensus round that anyone can audit.

How consensus is used
---------------------
The nondeterministic step returns **one boolean** and nothing else. Validators
rerun the judgement and compare that boolean; the model's prose reason is
carried for humans and is never compared, because comparing free text would
reject honest peers forever.

A boolean is deliberate. It is the narrowest thing that can be asked, so honest
validators agree on clear cases, and a genuinely borderline phrasing makes them
disagree, which rotates the leader and ultimately refuses the write. That is the
correct outcome: a phrasing that independent validators cannot both call correct
has no business being frozen into a shared answer key.

Storage cannot be reached from inside a nondeterministic block, so everything
the judgement needs is pulled into plain Python first, and every function that
votes is at module level where tests can reach it. Nothing that votes hides in a
closure.

Scope
-----
The frontend owns the race, the timer, the leaderboard and instant grading. This
contract owns the answer key, the consensus judgement on novel phrasings, and
the permanent record of what was ruled and by whom. It decides nothing about who
won.
"""

import json
import typing
from dataclasses import dataclass

from genlayer import *


# --------------------------------------------------------------------------
# Errors. Deterministic failures must match exactly between leader and
# validator; a model failure must make validators disagree so the leader
# rotates rather than freezing a bad verdict into the key.
# --------------------------------------------------------------------------
ERROR_EXPECTED = "[EXPECTED]"
ERROR_LLM = "[LLM_ERROR]"

MAX_ID_CHARS = 64
MAX_PROMPT_CHARS = 400
MAX_ANSWER_CHARS = 120
MAX_FORMS = 40            # a key that grows without bound is a key nobody audits
MAX_SEED_FORMS = 12
EDIT_TOLERANCE_MIN_LEN = 4


def _fail(prefix: str, code: str) -> typing.NoReturn:
    raise gl.vm.UserError(prefix + " " + code)


# --------------------------------------------------------------------------
# Normalisation and matching.
#
# These two functions are mirrored character for character in
# src/game/answerkey.ts. If they ever drift, the client will believe a phrasing
# is already known when the contract does not, and players will be told their
# answer was accepted when no ruling exists. The test suite on both sides pins
# the same table of cases against the same expected output.
# --------------------------------------------------------------------------

def normalize(text: str) -> str:
    """Lowercase, strip accents and punctuation, collapse whitespace."""
    import unicodedata
    decomposed = unicodedata.normalize("NFD", str(text))
    stripped = "".join(c for c in decomposed
                       if unicodedata.category(c) != "Mn")
    out = []
    for ch in stripped.lower():
        out.append(ch if (ch.isascii() and ch.isalnum()) else " ")
    return " ".join("".join(out).split())


def edit_distance(a: str, b: str) -> int:
    """Plain Levenshtein. Small by construction: answers are capped at 120
    characters, so the quadratic cost is bounded and deterministic."""
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        curr = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            curr[j] = min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
        prev = curr
    return prev[len(b)]


def matches_form(answer_n: str, form_n: str) -> bool:
    """One normalised answer against one stored form.

    The single edit tolerance is only allowed on forms of four characters or
    more. Without that guard "gen" would accept "den", and this quiz has a three
    letter ticker as one of its answers.
    """
    if not answer_n or not form_n:
        return False
    if answer_n == form_n:
        return True
    if len(form_n) < EDIT_TOLERANCE_MIN_LEN:
        return False
    return edit_distance(answer_n, form_n) <= 1


def decide_offline(forms: list, answer_n: str) -> bool:
    """The deterministic verdict. True means the key already covers this."""
    return any(matches_form(answer_n, f) for f in forms)


def parse_forms(raw: str) -> list:
    try:
        loaded = json.loads(str(raw))
    except Exception:
        _fail(ERROR_EXPECTED, "FORMS_CORRUPT")
    if not isinstance(loaded, list):
        _fail(ERROR_EXPECTED, "FORMS_CORRUPT")
    return [str(f) for f in loaded]


def merge_form(forms: list, answer_n: str) -> list:
    """Sorted and deduplicated, so two nodes that agreed write identical bytes."""
    return sorted(set(forms) | {answer_n})


def ruling_key(question_id: str, answer_n: str) -> str:
    return str(question_id) + "::" + answer_n


# --------------------------------------------------------------------------
# The judgement. At module level so it is reachable from tests, and so the
# thing validators compare is a named function rather than a closure.
# --------------------------------------------------------------------------

def judge_prompt(prompt: str, canonical: str, forms: list, answer: str) -> str:
    return (
        "You are grading one short answer to one quiz question.\n\n"
        "Question: " + str(prompt) + "\n"
        "The canonical correct answer: " + str(canonical) + "\n"
        "Spellings already accepted: " + ", ".join(forms) + "\n"
        "The answer to grade: " + str(answer) + "\n\n"
        "Decide one thing only: does the answer to grade mean the same as the "
        "canonical answer, as an answer to this question?\n\n"
        "Be conservative. Answer false if it names a different concept, if it "
        "is a broader category that merely contains the right answer, if it is "
        "so vague that it would also fit a wrong answer, or if you are unsure. "
        "Answer true only for a different wording of the same thing, including "
        "an accepted abbreviation or its expansion.\n\n"
        'Return JSON only: {"same_meaning": true or false, "reason": "one short sentence"}'
    )


def read_verdict(raw) -> bool:
    """Pull the boolean out of whatever the model actually returned.

    Models return `true`, `"true"`, `"yes"` and occasionally a nested object.
    Anything that cannot be read as a clean boolean is a model error, not a
    false, because silently reading a malformed answer as "no" would let a
    broken model quietly decide the outcome.
    """
    if not isinstance(raw, dict):
        _fail(ERROR_LLM, "VERDICT_NOT_OBJECT")
    value = raw.get("same_meaning")
    if value is None:
        for alt in ("same", "equivalent", "correct", "verdict", "result"):
            if alt in raw:
                value = raw[alt]
                break
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        token = value.strip().lower()
        if token in ("true", "yes", "y", "1"):
            return True
        if token in ("false", "no", "n", "0"):
            return False
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    _fail(ERROR_LLM, "VERDICT_UNREADABLE")


def read_reason(raw) -> str:
    """Carried for humans, never compared between validators."""
    if not isinstance(raw, dict):
        return ""
    return str(raw.get("reason", ""))[:200]


def verdicts_agree(mine: bool, theirs: bool) -> bool:
    """The whole consensus rule, in one testable place.

    Only the boolean is compared. The reason is prose and two honest validators
    will never write the same sentence, so comparing it would reject every
    honest peer.
    """
    return mine is theirs


# --------------------------------------------------------------------------
# Storage
# --------------------------------------------------------------------------

@allow_storage
@dataclass
class Question:
    prompt: str
    canonical: str
    forms_json: str          # JSON list, sorted, of normalised accepted forms
    ruled_count: u32


@allow_storage
@dataclass
class Ruling:
    question_id: str
    answer: str              # the normalised phrasing that was ruled on
    verdict: bool
    reason: str
    asked_by: Address


class AnswerKey(gl.Contract):
    owner: Address
    questions: TreeMap[str, Question]
    question_ids: DynArray[str]
    rulings: TreeMap[str, Ruling]
    ruling_ids: DynArray[str]

    def __init__(self):
        self.owner = gl.message.sender_address

    # -- helpers ---------------------------------------------------------
    def _question(self, question_id: str) -> Question:
        key = str(question_id).strip()
        if key not in self.questions:
            _fail(ERROR_EXPECTED, "QUESTION_NOT_FOUND")
        return self.questions[key]

    # -- the answer key, owned by whoever deployed it ---------------------
    @gl.public.write
    def add_question(self, question_id: str, prompt: str, canonical: str,
                     seed_forms: str) -> None:
        """Seed one question. The seed forms are the spellings the author was
        willing to guess; everything after that is decided by consensus."""
        if gl.message.sender_address != self.owner:
            _fail(ERROR_EXPECTED, "NOT_OWNER")
        key = str(question_id).strip()
        if not key or len(key) > MAX_ID_CHARS:
            _fail(ERROR_EXPECTED, "QUESTION_ID_LENGTH")
        if key in self.questions:
            _fail(ERROR_EXPECTED, "QUESTION_ID_TAKEN")
        text = str(prompt).strip()
        if not text or len(text) > MAX_PROMPT_CHARS:
            _fail(ERROR_EXPECTED, "PROMPT_LENGTH")
        answer = str(canonical).strip()
        if not answer or len(answer) > MAX_ANSWER_CHARS:
            _fail(ERROR_EXPECTED, "CANONICAL_LENGTH")

        forms = set()
        for piece in str(seed_forms).split("|"):
            n = normalize(piece)
            if n:
                forms.add(n)
        forms.add(normalize(answer))
        if not forms:
            _fail(ERROR_EXPECTED, "SEED_FORMS_EMPTY")
        if len(forms) > MAX_SEED_FORMS:
            _fail(ERROR_EXPECTED, "SEED_FORMS_TOO_MANY")

        self.questions[key] = Question(
            prompt=text,
            canonical=answer,
            forms_json=json.dumps(sorted(forms)),
            ruled_count=u32(0),
        )
        self.question_ids.append(key)

    @gl.public.write
    def retire_seed_form(self, question_id: str, form: str) -> None:
        """Remove a spelling that was seeded by mistake.

        Owner only, and deliberately unable to touch anything consensus put
        there. A seed is a guess the author made before anyone played, and a
        guess can be wrong. A ruling is a decision independent validators
        reached, and the owner does not get to quietly undo one, because a key
        the owner can rewrite is not a record of anything.

        This exists because it was needed within an hour of the first
        deployment: a shell coerced an empty argument to the string "0", which
        seeded "0" as an accepted answer to a question about a programming
        language.
        """
        if gl.message.sender_address != self.owner:
            _fail(ERROR_EXPECTED, "NOT_OWNER")
        key = str(question_id).strip()
        question = self._question(key)
        form_n = normalize(str(form))
        if not form_n:
            _fail(ERROR_EXPECTED, "FORM_EMPTY_AFTER_NORMALIZE")
        if form_n == normalize(str(question.canonical)):
            _fail(ERROR_EXPECTED, "CANNOT_RETIRE_CANONICAL")

        rkey = ruling_key(key, form_n)
        if rkey in self.rulings and bool(self.rulings[rkey].verdict):
            _fail(ERROR_EXPECTED, "FORM_WAS_RULED")

        forms = parse_forms(str(question.forms_json))
        if form_n not in forms:
            _fail(ERROR_EXPECTED, "FORM_NOT_PRESENT")
        remaining = [f for f in forms if f != form_n]

        self.questions[key] = Question(
            prompt=str(question.prompt),
            canonical=str(question.canonical),
            forms_json=json.dumps(sorted(remaining)),
            ruled_count=u32(int(question.ruled_count)),
        )

    # -- the one nondeterministic entry point -----------------------------
    @gl.public.write
    def rule(self, question_id: str, answer: str) -> None:
        """Put a phrasing the key does not yet cover to the validators.

        Refuses, without spending a model call, anything the deterministic path
        can already answer. That is not only a cost saving: a contract that
        re-ran consensus on settled cases would let a later round contradict an
        earlier one, and the key would stop being a record of anything.
        """
        raw_answer = str(answer).strip()
        if not raw_answer or len(raw_answer) > MAX_ANSWER_CHARS:
            _fail(ERROR_EXPECTED, "ANSWER_LENGTH")
        answer_n = normalize(raw_answer)
        if not answer_n:
            _fail(ERROR_EXPECTED, "ANSWER_EMPTY_AFTER_NORMALIZE")

        question = self._question(question_id)
        key = str(question_id).strip()
        forms = parse_forms(str(question.forms_json))

        if decide_offline(forms, answer_n):
            _fail(ERROR_EXPECTED, "ALREADY_ACCEPTED")
        rkey = ruling_key(key, answer_n)
        if rkey in self.rulings:
            _fail(ERROR_EXPECTED, "ALREADY_RULED")
        if len(forms) >= MAX_FORMS:
            _fail(ERROR_EXPECTED, "KEY_FULL")

        # Storage is unreachable inside the nondeterministic block, so the
        # judgement gets plain values only.
        prompt = judge_prompt(str(question.prompt), str(question.canonical),
                              forms, raw_answer)

        def leader_fn() -> str:
            raw = gl.nondet.exec_prompt(prompt, response_format="json")
            return json.dumps({"same_meaning": read_verdict(raw),
                               "reason": read_reason(raw)}, sort_keys=True)

        def validator_fn(leaders_res: gl.vm.Result) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return _leader_errored(leaders_res, leader_fn)
            try:
                theirs = json.loads(_leader_payload(leaders_res))
                mine = json.loads(leader_fn())
            except gl.vm.UserError:
                return False
            except Exception:
                return False
            if not isinstance(theirs, dict) or "same_meaning" not in theirs:
                return False
            if not isinstance(theirs["same_meaning"], bool):
                return False
            return verdicts_agree(bool(mine["same_meaning"]),
                                  bool(theirs["same_meaning"]))

        agreed = json.loads(gl.vm.run_nondet_unsafe(leader_fn, validator_fn))
        verdict = bool(agreed["same_meaning"])

        self.rulings[rkey] = Ruling(
            question_id=key,
            answer=answer_n,
            verdict=verdict,
            reason=str(agreed.get("reason", ""))[:200],
            asked_by=gl.message.sender_address,
        )
        self.ruling_ids.append(rkey)

        if verdict:
            # Written back as a whole record rather than by mutating the one
            # read out of the map. Two nodes that agreed must produce identical
            # bytes, and json.dumps over a sorted list is the canonical form.
            self.questions[key] = Question(
                prompt=str(question.prompt),
                canonical=str(question.canonical),
                forms_json=json.dumps(merge_form(forms, answer_n)),
                ruled_count=u32(int(question.ruled_count) + 1),
            )

    # -- everything below is deterministic, and needs no model ------------
    @gl.public.view
    def grade(self, question_id: str, answer: str) -> str:
        """`correct` when the key already covers this phrasing, `unknown` when
        only consensus can say. Never `incorrect`: this contract does not claim
        an answer is wrong, only that it has not been ruled acceptable."""
        question = self._question(question_id)
        answer_n = normalize(str(answer))
        if not answer_n:
            return "unknown"
        forms = parse_forms(str(question.forms_json))
        if decide_offline(forms, answer_n):
            return "correct"
        rkey = ruling_key(str(question_id).strip(), answer_n)
        if rkey in self.rulings and not bool(self.rulings[rkey].verdict):
            return "ruled_incorrect"
        return "unknown"

    @gl.public.view
    def forms(self, question_id: str) -> str:
        """What the client caches so a race never waits on a chain."""
        return str(self._question(question_id).forms_json)

    @gl.public.view
    def get_question(self, question_id: str) -> str:
        question = self._question(question_id)
        return json.dumps({
            "prompt": str(question.prompt),
            "canonical": str(question.canonical),
            "forms": parse_forms(str(question.forms_json)),
            "ruled_count": int(question.ruled_count),
        }, sort_keys=True)

    @gl.public.view
    def all_forms(self) -> str:
        """Every question's accepted forms in one read, so the client warms its
        whole cache in a single call instead of one per question."""
        out = {}
        for qid in self.question_ids:
            out[str(qid)] = parse_forms(str(self.questions[str(qid)].forms_json))
        return json.dumps(out, sort_keys=True)

    @gl.public.view
    def question_count(self) -> int:
        return len(self.question_ids)

    @gl.public.view
    def ruling_count(self) -> int:
        return len(self.ruling_ids)

    @gl.public.view
    def get_ruling(self, question_id: str, answer: str) -> str:
        rkey = ruling_key(str(question_id).strip(), normalize(str(answer)))
        if rkey not in self.rulings:
            _fail(ERROR_EXPECTED, "RULING_NOT_FOUND")
        record = self.rulings[rkey]
        return json.dumps({
            "question_id": str(record.question_id),
            "answer": str(record.answer),
            "verdict": bool(record.verdict),
            "reason": str(record.reason),
            "asked_by": str(record.asked_by),
        }, sort_keys=True)

    @gl.public.view
    def recent_rulings(self, limit: int) -> str:
        """Newest first, so the game can show what the chain has been deciding."""
        count = len(self.ruling_ids)
        take = max(0, min(int(limit), count))
        out = []
        for i in range(count - 1, count - take - 1, -1):
            record = self.rulings[str(self.ruling_ids[i])]
            out.append({
                "question_id": str(record.question_id),
                "answer": str(record.answer),
                "verdict": bool(record.verdict),
                "reason": str(record.reason),
            })
        return json.dumps(out, sort_keys=True)


# --------------------------------------------------------------------------
# Small helpers kept at module level so tests can reach them
# --------------------------------------------------------------------------

def _leader_payload(leaders_res):
    payload = leaders_res.calldata
    if isinstance(payload, (bytes, bytearray)):
        return payload.decode("utf-8")
    return payload


def _leader_errored(leaders_res, leader_fn) -> bool:
    """Deterministic errors must match; a model error must force rotation."""
    leader_msg = getattr(leaders_res, "message", "")
    try:
        leader_fn()
        return False
    except gl.vm.UserError as exc:
        mine = getattr(exc, "message", str(exc))
        if mine.startswith(ERROR_EXPECTED):
            return mine == leader_msg
        return False
    except Exception:
        return False
