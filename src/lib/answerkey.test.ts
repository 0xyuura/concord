import { describe, expect, it } from "vitest";
import {
  decideOffline,
  editDistance,
  grade,
  matchesForm,
  normalize,
} from "./answerkey";

// The same table as NORMALIZE_CASES in tests/test_deterministic.py, asserted
// against the same expected output. This is the contract between the client
// and the chain: if either side is edited alone, one of these two suites goes
// red rather than a player being told something the chain does not agree with.
const NORMALIZE_CASES: [string, string][] = [
  ["Intelligent", "intelligent"],
  ["  Intelligent   Contracts  ", "intelligent contracts"],
  ["Delegated Proof-of-Stake!", "delegated proof of stake"],
  ["Ásimov", "asimov"],
  ["$GEN", "gen"],
  ["GenVM", "genvm"],
  ["Optimistic  Democracy", "optimistic democracy"],
  ["proof   of\tstake", "proof of stake"],
  ["---", ""],
  ["", ""],
  ["Niño", "nino"],
  ["LLMs", "llms"],
];

describe("normalize, in parity with the contract", () => {
  it("matches the shared table", () => {
    for (const [raw, expected] of NORMALIZE_CASES) {
      expect(normalize(raw), JSON.stringify(raw)).toBe(expected);
    }
  });

  it("is idempotent", () => {
    for (const [raw] of NORMALIZE_CASES) {
      const once = normalize(raw);
      expect(normalize(once)).toBe(once);
    }
  });
});

describe("editDistance", () => {
  it("is zero for identical strings", () => {
    expect(editDistance("genvm", "genvm")).toBe(0);
  });

  it("counts a single substitution", () => {
    expect(editDistance("gen", "den")).toBe(1);
  });

  it("counts a single deletion", () => {
    expect(editDistance("democacy", "democracy")).toBe(1);
  });

  it("is symmetric", () => {
    const pairs: [string, string][] = [
      ["python", "pyhton"],
      ["llm", "llms"],
      ["", "gen"],
      ["optimistic", "optimistic democracy"],
    ];
    for (const [a, b] of pairs) {
      expect(editDistance(a, b)).toBe(editDistance(b, a));
    }
  });

  it("measures an empty string against a word", () => {
    expect(editDistance("", "gen")).toBe(3);
  });
});

describe("matchesForm", () => {
  it("accepts an exact match", () => {
    expect(matchesForm("python", "python")).toBe(true);
  });

  it("forgives one typo on a long form", () => {
    expect(matchesForm("pyhon", "python")).toBe(true);
  });

  it("does not forgive two", () => {
    expect(matchesForm("pyhtn", "python")).toBe(false);
  });

  // The reason the guard exists: this question set has a three letter ticker,
  // and without it "den" would be graded as "gen".
  it("gives short forms no tolerance at all", () => {
    expect(matchesForm("den", "gen")).toBe(false);
    expect(matchesForm("ten", "gen")).toBe(false);
    expect(matchesForm("gen", "gen")).toBe(true);
  });

  it("never matches an empty side", () => {
    expect(matchesForm("", "python")).toBe(false);
    expect(matchesForm("python", "")).toBe(false);
  });
});

describe("decideOffline", () => {
  const forms = ["dpos", "delegated proof of stake"];

  it("covers a known form", () => {
    expect(decideOffline(forms, "dpos")).toBe(true);
  });

  it("covers a typo of a long known form", () => {
    expect(decideOffline(forms, "delegated proof of stakes")).toBe(true);
  });

  // The case the whole project exists for: right meaning, wrong string.
  it("does not cover a novel phrasing", () => {
    expect(decideOffline(forms, "proof of stake delegation")).toBe(false);
  });
});

describe("grade", () => {
  const forms = ["optimistic democracy", "the optimistic democracy"];

  it("accepts a form the key already holds", () => {
    expect(grade(forms, [], "Optimistic Democracy")).toBe("correct");
  });

  it("accepts a phrasing consensus added, with no model in the path", () => {
    expect(grade(forms, [], "The Optimistic Democracy")).toBe("correct");
  });

  it("returns unknown for something the key has never seen", () => {
    expect(grade(forms, [], "hopeful voting")).toBe("unknown");
  });

  it("remembers a phrasing consensus refused", () => {
    expect(grade(["dpos"], ["proof of stake"], "Proof of Stake")).toBe(
      "ruled_incorrect",
    );
  });

  it("treats an empty answer as unknown rather than wrong", () => {
    expect(grade(forms, [], "   ")).toBe("unknown");
  });
});
