"""Seed the AnswerKey contract with the starting question set.

Run once after deploying. Each question is one transaction, and Bradbury rate
limits, so every call retries.

The seed forms are only the spellings the author was willing to guess. Every
other phrasing that ever gets accepted has to go through a consensus round, and
that is the point of the contract.
"""
import json
import shutil
import subprocess
import sys
import time

ADDR = "0x4C95B77f8D6CF7F3EC412aAaB6EFed5b92343FD3"
CLI = shutil.which("genlayer") or shutil.which("genlayer.cmd")

# id, prompt, canonical answer, extra seed spellings separated by "|"
QUESTIONS = [
    ("q1", "GenLayer AI powered smart contracts are called ___ Contracts.",
     "intelligent", "intelligent contracts|intelligent contract"),
    ("q2", "What programming language are Intelligent Contracts written in?",
     "python", ""),
    ("q3", "Validators connect directly to these AI models to reason (3 letter abbreviation).",
     "llm", "llms|large language model|large language models"),
    ("q4", "The GenLayer Python execution environment, its virtual machine, is called ___.",
     "genvm", "gen vm"),
    ("q5", "Name the GenLayer consensus mechanism (two words).",
     "optimistic democracy", ""),
    ("q6", "The GenLayer incentivized testnet is named after which science fiction author?",
     "asimov", "isaac asimov|testnet asimov"),
    ("q7", "The GenLayer native token ticker (3 letters).",
     "gen", "$gen"),
    ("q8", "Which principle lets validators agree on non deterministic model results without identical outputs? (two words)",
     "equivalence principle", "equivalence|the equivalence principle"),
    ("q9", "In Optimistic Democracy, the validator that proposes the initial outcome is the ___.",
     "leader", "the leader|leader validator"),
    ("q10", "Optimistic Democracy is an enhanced version of which staking consensus?",
     "dpos", "delegated proof of stake|delegated proof-of-stake"),
]


def call(args, tries=4):
    for attempt in range(1, tries + 1):
        proc = subprocess.run([CLI] + args, capture_output=True, text=True,
                              timeout=420)
        blob = proc.stdout + proc.stderr
        if "status_name: 'ACCEPTED'" in blob or "successfully executed" in blob:
            return True, blob
        print("    attempt %d did not land" % attempt)
        if attempt < tries:
            time.sleep(25)
    return False, blob


def main():
    if not CLI:
        sys.exit("genlayer CLI not found on PATH")
    ok, bad = 0, []
    for qid, prompt, canonical, seeds in QUESTIONS:
        print("seeding %s ..." % qid)
        # Never pass an empty argument. The CLI coerces "" to the string "0",
        # which on the first deployment seeded "0" as an accepted answer to a
        # question about a programming language. Passing the canonical instead
        # is a no-op, because add_question adds and deduplicates it anyway.
        landed, blob = call(["write", ADDR, "add_question",
                             "--args", qid, prompt, canonical,
                             seeds or canonical])
        if landed:
            ok += 1
            print("  ok")
        else:
            bad.append(qid)
            print("  FAILED\n" + blob[-500:])
    print("\nseeded %d of %d" % (ok, len(QUESTIONS)))
    if bad:
        print("failed:", ", ".join(bad))


if __name__ == "__main__":
    main()
