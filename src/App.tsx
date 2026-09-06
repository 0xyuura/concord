import { useCallback, useEffect, useMemo, useState } from "react";
import { grade, normalize } from "./lib/answerkey";
import {
  CONTRACT,
  EXPLORER,
  type QuestionRow,
  type RulingRow,
  connect,
  hasWallet,
  loadQuestions,
  loadRulings,
  rule,
} from "./lib/chain";

const ACCENTS = ["var(--cyan)", "var(--magenta)", "var(--violet)", "var(--blue)"];

function short(address: string): string {
  return address.slice(0, 6) + "..." + address.slice(-4);
}

export default function App() {
  const [questions, setQuestions] = useState<QuestionRow[]>([]);
  const [rulings, setRulings] = useState<RulingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [selected, setSelected] = useState("");
  const [answer, setAnswer] = useState("");

  const [account, setAccount] = useState("");
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [justRuled, setJustRuled] = useState<RulingRow | null>(null);

  const refresh = useCallback(async () => {
    const [q, r] = await Promise.all([loadQuestions(), loadRulings(12)]);
    setQuestions(q);
    setRulings(r);
    return q;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const q = await refresh();
        if (q.length) setSelected((s) => s || q[0].id);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  const current = questions.find((q) => q.id === selected) ?? null;

  // A phrasing the validators refused is remembered, so the app can say "the
  // chain has already looked at this" instead of offering another round that
  // would be refused deterministically by the contract anyway.
  const refusedHere = useMemo(
    () =>
      rulings
        .filter((r) => r.question_id === selected && !r.verdict)
        .map((r) => r.answer),
    [rulings, selected],
  );

  const verdict = current ? grade(current.forms, refusedHere, answer) : "unknown";
  const typed = normalize(answer);

  const totals = useMemo(() => {
    const forms = questions.reduce((sum, q) => sum + q.forms.length, 0);
    const learned = questions.reduce((sum, q) => sum + q.ruledCount, 0);
    return { forms, learned };
  }, [questions]);

  async function onConnect() {
    setActionError("");
    try {
      setAccount(await connect());
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onRule() {
    if (!current || !typed) return;
    setPending(true);
    setActionError("");
    setJustRuled(null);
    try {
      await rule(account, current.id, answer.trim());
      const fresh = await loadRulings(12);
      setRulings(fresh);
      await refresh();
      const mine = fresh.find(
        (r) => r.question_id === current.id && r.answer === typed,
      );
      setJustRuled(mine ?? null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  if (loading) {
    return (
      <>
        <div className="spectrum" />
        <div className="shell">
          <div className="loading">Reading the answer key from Bradbury...</div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="spectrum" />
      <div className="shell">
        <header className="masthead">
          <div className="wordmark">
            <div className="mark" />
            <h1>CONCORD</h1>
          </div>
          <a className="chip-link" href={EXPLORER} target="_blank" rel="noreferrer">
            {short(CONTRACT)} on Bradbury
          </a>
        </header>

        <section className="hero">
          <p className="kicker">A GenLayer Intelligent Contract</p>
          <h2>
            An answer key that <em>learns</em> what a right answer looks like.
          </h2>
          <p>
            Quiz graders compare strings, so an answer that is right in meaning
            and wrong in wording is marked wrong. Concord keeps the key on
            chain. Grading stays instant and deterministic, and the one thing a
            string comparison cannot do, decide whether two phrasings mean the
            same, is put to GenLayer validators once. What they agree on becomes
            part of the key, and every player after that is graded for free.
          </p>

          <div className="stats">
            <div className="stat" style={{ ["--c" as string]: ACCENTS[0] }}>
              <b>{questions.length}</b>
              <span>Questions on chain</span>
            </div>
            <div className="stat" style={{ ["--c" as string]: ACCENTS[1] }}>
              <b>{totals.forms}</b>
              <span>Accepted phrasings</span>
            </div>
            <div className="stat" style={{ ["--c" as string]: ACCENTS[2] }}>
              <b>{rulings.length}</b>
              <span>Consensus rulings</span>
            </div>
            <div className="stat" style={{ ["--c" as string]: ACCENTS[3] }}>
              <b>{totals.learned}</b>
              <span>Phrasings learned</span>
            </div>
          </div>
        </section>

        {loadError && (
          <p className="err">Could not read the contract: {loadError}</p>
        )}

        <section className="section">
          <div className="section-head">
            <h3>Try it</h3>
            <span>graded locally against the on chain key, no wallet needed</span>
          </div>

          <div className="console">
            <div className="console-top" role="tablist">
              {questions.map((q) => (
                <button
                  key={q.id}
                  className="qtab"
                  role="tab"
                  aria-selected={q.id === selected}
                  onClick={() => {
                    setSelected(q.id);
                    setAnswer("");
                    setJustRuled(null);
                    setActionError("");
                  }}
                >
                  {q.id}
                </button>
              ))}
            </div>

            {current && (
              <div className="console-body">
                <p className="prompt">{current.prompt}</p>

                <div className="answer-row">
                  <input
                    value={answer}
                    onChange={(e) => {
                      setAnswer(e.target.value);
                      setJustRuled(null);
                    }}
                    placeholder="Type an answer in your own words"
                    maxLength={120}
                    spellCheck={false}
                  />
                  <button
                    className="btn ghost"
                    onClick={() => setAnswer("")}
                    disabled={!answer}
                  >
                    Clear
                  </button>
                </div>

                {typed && (
                  <div className={`verdict ${verdict}`}>
                    <span className="tag">
                      {verdict === "correct"
                        ? "Accepted"
                        : verdict === "ruled_incorrect"
                          ? "Refused"
                          : "Not in the key"}
                    </span>
                    <span className="say">
                      {verdict === "correct" &&
                        "The key already holds this phrasing, so the grade came from stored state with no model in the path."}
                      {verdict === "ruled_incorrect" &&
                        "Validators have already looked at this exact phrasing and ruled it does not mean the same thing."}
                      {verdict === "unknown" &&
                        "Nothing in the key covers this. A string comparison would stop here and mark it wrong."}
                    </span>
                  </div>
                )}

                {typed && verdict === "unknown" && (
                  <div className="escalate">
                    <p>
                      Put it to the validators. They will each judge whether{" "}
                      <strong>{typed}</strong> means the same as the canonical
                      answer and must agree on the verdict. If they say yes, the
                      phrasing joins the key on chain and is graded instantly
                      from then on, for everyone.
                    </p>

                    {pending ? (
                      <div className="pending">
                        <span className="pulse" />
                        Consensus round running. This takes about a minute.
                      </div>
                    ) : !hasWallet() ? (
                      <div className="pending" style={{ color: "var(--dim)" }}>
                        An injected wallet is needed to send the transaction.
                      </div>
                    ) : account ? (
                      <button className="btn" onClick={onRule}>
                        Put it to the validators
                      </button>
                    ) : (
                      <button className="btn" onClick={onConnect}>
                        Connect wallet
                      </button>
                    )}
                  </div>
                )}

                {justRuled && (
                  <div className={`verdict ${justRuled.verdict ? "correct" : "ruled_incorrect"}`}>
                    <span className="tag">
                      {justRuled.verdict ? "Ruled acceptable" : "Ruled different"}
                    </span>
                    <span className="say">{justRuled.reason}</span>
                  </div>
                )}

                {actionError && <p className="err">{actionError}</p>}
              </div>
            )}
          </div>
        </section>

        <section className="section">
          <div className="section-head">
            <h3>How it works</h3>
            <span>one model call per phrasing, never per player</span>
          </div>
          <div className="steps">
            <div className="step" style={{ ["--c" as string]: ACCENTS[0] }}>
              <b>1. Fast path</b>
              <p>
                The answer is normalised and matched against the phrasings
                already stored for the question, with a one character typo
                tolerance. This is ordinary deterministic code and needs no
                model, so grading is instant.
              </p>
            </div>
            <div className="step" style={{ ["--c" as string]: ACCENTS[1] }}>
              <b>2. Slow path</b>
              <p>
                When nothing in the key covers the phrasing, the contract asks
                the validators one narrow question and they each answer it
                independently. The judgement returns a single boolean, and they
                have to agree on it.
              </p>
            </div>
            <div className="step" style={{ ["--c" as string]: ACCENTS[2] }}>
              <b>3. The key grows</b>
              <p>
                A verdict of yes appends the phrasing to contract storage. The
                model is paid once, for the first person who ever writes it that
                way, and every player after that is graded from state.
              </p>
            </div>
            <div className="step" style={{ ["--c" as string]: ACCENTS[3] }}>
              <b>4. Nothing is hidden</b>
              <p>
                Every ruling is stored with the reason and the address that
                asked. A key the owner could quietly rewrite would be a record
                of nothing, so a seeded spelling can be retired but a ruled one
                cannot.
              </p>
            </div>
          </div>
        </section>

        <section className="section">
          <div className="section-head">
            <h3>The key</h3>
            <span>violet chips were added by consensus, not by the author</span>
          </div>
          <div className="grid">
            {questions.map((q, i) => (
              <article
                key={q.id}
                className="card"
                style={{ ["--c" as string]: ACCENTS[i % ACCENTS.length] }}
              >
                <div className="qid">{q.id}</div>
                <p className="qtext">{q.prompt}</p>
                <div className="forms">
                  {q.forms.map((f) => {
                    const learned = rulings.some(
                      (r) => r.question_id === q.id && r.verdict && r.answer === f,
                    );
                    return (
                      <span key={f} className={learned ? "form ruled" : "form"}>
                        {f}
                      </span>
                    );
                  })}
                </div>
                <div className="card-foot">
                  {q.forms.length} accepted
                  {q.ruledCount > 0 && ` / ${q.ruledCount} learned by consensus`}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="section">
          <div className="section-head">
            <h3>What the validators decided</h3>
            <span>newest first, read from contract storage</span>
          </div>
          {rulings.length === 0 ? (
            <p className="empty">No rulings yet. Be the first to put a phrasing to the chain.</p>
          ) : (
            <div className="feed">
              {rulings.map((r, i) => (
                <div
                  key={`${r.question_id}-${r.answer}-${i}`}
                  className={`ruling ${r.verdict ? "yes" : "no"}`}
                >
                  <div className="badge">
                    {r.verdict ? "Accepted" : "Refused"}
                    <div style={{ color: "var(--dimmer)", fontWeight: 400, marginTop: 4 }}>
                      {r.question_id}
                    </div>
                  </div>
                  <div>
                    <div className="quoted">{r.answer}</div>
                    <div className="why">{r.reason}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <footer className="foot">
          <span>
            Intelligent Contract on GenLayer Testnet Bradbury.{" "}
            <a href={EXPLORER} target="_blank" rel="noreferrer">
              Read it on the explorer
            </a>
          </span>
          <span>{account ? `Connected ${short(account)}` : "Reads need no wallet"}</span>
        </footer>
      </div>
    </>
  );
}
