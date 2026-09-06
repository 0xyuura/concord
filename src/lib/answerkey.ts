// Mirror of the grading functions in contracts/answer_key.py.
//
// This file exists so a player gets an instant verdict without waiting on a
// chain. That only works if it agrees with the contract character for
// character: if the two drift, the app tells someone their answer was accepted
// when no ruling exists for it, and the next player to type the same thing is
// told the opposite.
//
// The guarantee is pinned from both sides. tests/test_deterministic.py and
// answerkey.test.ts assert the same table of cases against the same expected
// output, so a change to one that is not made to the other fails a test rather
// than reaching a player.

export const EDIT_TOLERANCE_MIN_LEN = 4;

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalize(text: string): string {
  const stripped = (text ?? "").normalize("NFD").replace(/\p{Mn}/gu, "");
  let out = "";
  for (const ch of stripped.toLowerCase()) {
    out += /[a-z0-9]/.test(ch) ? ch : " ";
  }
  return out.split(/\s+/).filter(Boolean).join(" ");
}

/** Plain Levenshtein. Answers are capped at 120 characters by the contract. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = new Array<number>(b.length + 1);
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * One normalised answer against one stored form.
 *
 * The single edit tolerance is only allowed on forms of four characters or
 * more. Without that guard "gen" would accept "den", and this question set has
 * a three letter ticker as one of its answers.
 */
export function matchesForm(answerN: string, formN: string): boolean {
  if (!answerN || !formN) return false;
  if (answerN === formN) return true;
  if (formN.length < EDIT_TOLERANCE_MIN_LEN) return false;
  return editDistance(answerN, formN) <= 1;
}

/** True when the key already covers this phrasing, with no model needed. */
export function decideOffline(forms: string[], answerN: string): boolean {
  return forms.some((f) => matchesForm(answerN, f));
}

export type Verdict = "correct" | "unknown" | "ruled_incorrect";

/**
 * The client side grade, mirroring the contract's `grade` view.
 *
 * `unknown` is not a rejection. It means the key has nothing to say yet, which
 * is exactly the case the chain exists to settle.
 */
export function grade(
  forms: string[],
  ruledIncorrect: string[],
  answer: string,
): Verdict {
  const n = normalize(answer);
  if (!n) return "unknown";
  if (decideOffline(forms, n)) return "correct";
  if (ruledIncorrect.includes(n)) return "ruled_incorrect";
  return "unknown";
}
