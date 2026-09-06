"""Unit tests for the deterministic layer of AnswerKey.

Everything that decides anything in this contract is a module level pure
function, so it is all reachable from plain CPython. No network, no model.

That placement is deliberate and was learned the hard way on an earlier
contract, where the agreement rule lived inside a closure, out of reach of
tests, and a consensus defect shipped because of it. Nothing that votes hides
in a closure here.

Run with:  python -m unittest discover -s tests -v
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _stub                                              # noqa: E402
_stub.install()

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "contracts"))
import answer_key as ak                                   # noqa: E402


# The client normalises answers too, so it can grade instantly without asking
# the chain. If the two implementations ever disagree, a player is told their
# answer was accepted when no ruling exists for it. This table is the contract
# between them: src/lib/answerkey.test.ts asserts the same pairs.
NORMALIZE_CASES = [
    ("Intelligent", "intelligent"),
    ("  Intelligent   Contracts  ", "intelligent contracts"),
    ("Delegated Proof-of-Stake!", "delegated proof of stake"),
    ("Ásimov", "asimov"),
    ("$GEN", "gen"),
    ("GenVM", "genvm"),
    ("Optimistic  Democracy", "optimistic democracy"),
    ("proof   of\tstake", "proof of stake"),
    ("---", ""),
    ("", ""),
    ("Niño", "nino"),
    ("LLMs", "llms"),
]


class Normalize(unittest.TestCase):
    def test_parity_table(self):
        for raw, expected in NORMALIZE_CASES:
            self.assertEqual(ak.normalize(raw), expected, repr(raw))

    def test_is_idempotent(self):
        for raw, _ in NORMALIZE_CASES:
            once = ak.normalize(raw)
            self.assertEqual(ak.normalize(once), once, repr(raw))


class EditDistance(unittest.TestCase):
    def test_identical_is_zero(self):
        self.assertEqual(ak.edit_distance("genvm", "genvm"), 0)

    def test_single_substitution(self):
        self.assertEqual(ak.edit_distance("gen", "den"), 1)

    def test_single_deletion(self):
        self.assertEqual(ak.edit_distance("democacy", "democracy"), 1)

    def test_is_symmetric(self):
        pairs = [("python", "pyhton"), ("llm", "llms"), ("", "gen"),
                 ("optimistic", "optimistic democracy")]
        for a, b in pairs:
            self.assertEqual(ak.edit_distance(a, b), ak.edit_distance(b, a))

    def test_empty_against_word(self):
        self.assertEqual(ak.edit_distance("", "gen"), 3)


class MatchesForm(unittest.TestCase):
    def test_exact_match(self):
        self.assertTrue(ak.matches_form("python", "python"))

    def test_one_typo_on_a_long_form(self):
        self.assertTrue(ak.matches_form("pyhon", "python"))

    def test_two_typos_are_too_many(self):
        self.assertFalse(ak.matches_form("pyhtn", "python"))

    def test_short_forms_get_no_tolerance(self):
        """The reason the guard exists: this quiz has a three letter ticker,
        and without the guard `den` would be accepted as `gen`."""
        self.assertFalse(ak.matches_form("den", "gen"))
        self.assertFalse(ak.matches_form("ten", "gen"))
        self.assertTrue(ak.matches_form("gen", "gen"))

    def test_empty_never_matches(self):
        self.assertFalse(ak.matches_form("", "python"))
        self.assertFalse(ak.matches_form("python", ""))


class DecideOffline(unittest.TestCase):
    def setUp(self):
        self.forms = ["dpos", "delegated proof of stake"]

    def test_known_form_is_covered(self):
        self.assertTrue(ak.decide_offline(self.forms, "dpos"))

    def test_typo_of_a_long_known_form_is_covered(self):
        self.assertTrue(ak.decide_offline(self.forms, "delegated proof of stakes"))

    def test_a_novel_phrasing_is_not_covered(self):
        """The case the whole contract exists for: right meaning, wrong string."""
        self.assertFalse(ak.decide_offline(self.forms, "proof of stake delegation"))

    def test_empty_key_covers_nothing(self):
        self.assertFalse(ak.decide_offline([], "dpos"))


class MergeForm(unittest.TestCase):
    def test_adds_the_new_form(self):
        self.assertIn("proof of stake", ak.merge_form(["dpos"], "proof of stake"))

    def test_result_is_sorted_and_deduplicated(self):
        merged = ak.merge_form(["dpos", "zeta", "alpha"], "dpos")
        self.assertEqual(merged, ["alpha", "dpos", "zeta"])

    def test_two_nodes_write_identical_bytes(self):
        """Consensus stores the result, so the serialisation must be canonical
        or two nodes that agreed would still write different state."""
        a = json.dumps(ak.merge_form(["b", "a"], "c"))
        b = json.dumps(ak.merge_form(["a", "b"], "c"))
        self.assertEqual(a, b)


class ParseForms(unittest.TestCase):
    def test_reads_a_list(self):
        self.assertEqual(ak.parse_forms('["a", "b"]'), ["a", "b"])

    def test_refuses_broken_json(self):
        with self.assertRaises(ak.gl.vm.UserError):
            ak.parse_forms("{oops")

    def test_refuses_a_non_list(self):
        with self.assertRaises(ak.gl.vm.UserError):
            ak.parse_forms('{"a": 1}')


class ReadVerdict(unittest.TestCase):
    def test_reads_a_real_boolean(self):
        self.assertTrue(ak.read_verdict({"same_meaning": True}))
        self.assertFalse(ak.read_verdict({"same_meaning": False}))

    def test_reads_the_strings_models_actually_return(self):
        for token in ("true", "TRUE", " yes ", "y", "1"):
            self.assertTrue(ak.read_verdict({"same_meaning": token}), token)
        for token in ("false", "No", "n", "0"):
            self.assertFalse(ak.read_verdict({"same_meaning": token}), token)

    def test_accepts_the_key_aliases_models_drift_to(self):
        self.assertTrue(ak.read_verdict({"equivalent": True}))
        self.assertTrue(ak.read_verdict({"verdict": "yes"}))

    def test_unreadable_is_a_model_error_not_a_false(self):
        """Reading a malformed answer as `no` would let a broken model quietly
        decide the outcome, and the ruling would be stored as if it were real."""
        for bad in ({"same_meaning": "perhaps"}, {"same_meaning": None},
                    {"nothing": 1}, {}):
            with self.assertRaises(ak.gl.vm.UserError) as caught:
                ak.read_verdict(bad)
            self.assertTrue(caught.exception.message.startswith(ak.ERROR_LLM),
                            caught.exception.message)

    def test_a_non_object_is_a_model_error(self):
        with self.assertRaises(ak.gl.vm.UserError):
            ak.read_verdict("true")

    def test_two_is_not_a_boolean(self):
        with self.assertRaises(ak.gl.vm.UserError):
            ak.read_verdict({"same_meaning": 2})


class ReadReason(unittest.TestCase):
    def test_reads_a_reason(self):
        self.assertEqual(ak.read_reason({"reason": "same thing"}), "same thing")

    def test_missing_reason_is_empty_not_an_error(self):
        self.assertEqual(ak.read_reason({"same_meaning": True}), "")

    def test_is_truncated_so_one_model_cannot_bloat_storage(self):
        self.assertEqual(len(ak.read_reason({"reason": "x" * 500})), 200)

    def test_a_non_object_yields_empty(self):
        self.assertEqual(ak.read_reason(None), "")


class VerdictsAgree(unittest.TestCase):
    def test_matching_booleans_agree(self):
        self.assertTrue(ak.verdicts_agree(True, True))
        self.assertTrue(ak.verdicts_agree(False, False))

    def test_differing_booleans_do_not(self):
        self.assertFalse(ak.verdicts_agree(True, False))
        self.assertFalse(ak.verdicts_agree(False, True))

    def test_agreement_is_symmetric(self):
        for a in (True, False):
            for b in (True, False):
                self.assertEqual(ak.verdicts_agree(a, b),
                                 ak.verdicts_agree(b, a))

    def test_the_reason_cannot_reach_the_comparison(self):
        """Two honest validators will never write the same sentence, so the
        prose must be structurally unable to affect agreement. The rule takes
        two booleans and nothing else, which is the guarantee, checked here
        rather than asserted in a comment."""
        import inspect
        sig = inspect.signature(ak.verdicts_agree)
        self.assertEqual(list(sig.parameters), ["mine", "theirs"])
        for name, param in sig.parameters.items():
            self.assertIs(param.annotation, bool, name)


class JudgePrompt(unittest.TestCase):
    def setUp(self):
        self.prompt = ak.judge_prompt(
            "Optimistic Democracy is an enhanced version of which consensus?",
            "delegated proof of stake", ["dpos"], "proof of stake delegation")

    def test_carries_everything_the_judgement_needs(self):
        for piece in ("Optimistic Democracy", "delegated proof of stake",
                      "dpos", "proof of stake delegation"):
            self.assertIn(piece, self.prompt)

    def test_asks_for_a_single_decision(self):
        self.assertIn("same_meaning", self.prompt)

    def test_instructs_the_model_to_be_conservative(self):
        """Borderline calls should come back false rather than split the
        validators, so the instruction is part of the consensus design and is
        pinned here rather than left to whoever edits the string next."""
        self.assertIn("conservative", self.prompt.lower())
        self.assertIn("unsure", self.prompt.lower())


class RulingKey(unittest.TestCase):
    def test_is_stable(self):
        self.assertEqual(ak.ruling_key("q1", "proof of stake"),
                         ak.ruling_key("q1", "proof of stake"))

    def test_separates_question_from_answer(self):
        """Normalised answers only ever contain a-z, 0-9 and single spaces, so
        a punctuation separator cannot be produced by an answer and two
        different pairs cannot collide onto one key."""
        self.assertNotEqual(ak.ruling_key("q1", "a b"), ak.ruling_key("q1 a", "b"))


if __name__ == "__main__":
    unittest.main()
