import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { grade, normalize } from "./lib/answerkey";
import {
  CONTRACT,
  EXPLORER,
  type QuestionRow,
  type RulingRow,
  loadQuestions,
  loadRulings,
  rule,
} from "./lib/chain";
import {
  useActiveSection,
  useCountUp,
  usePointerLight,
  useRevealObserver,
  useScrollProgress,
  useScrolledPast,
} from "./lib/motion";
import {
  CHAIN_ID,
  EXPLORER_ROOT,
  FAUCET_URL,
  balanceOf,
  chainId,
  connect,
  disconnect,
  formatGen,
  hasWallet,
  short,
  silentAccount,
  switchToBradbury,
  walletLabel,
  watch,
} from "./lib/wallet";

const ACCENTS = ["var(--cyan)", "var(--magenta)", "var(--violet)", "var(--blue)"];

const NAV = [
  { id: "try", label: "Try it" },
  { id: "how", label: "How it works" },
  { id: "wallet", label: "Wallet" },
  { id: "key", label: "The key" },
  { id: "rulings", label: "Rulings" },
];

/** Enough GEN to pay for a consensus round with room to spare. */
const GAS_FLOOR = 0.001;

const STEPS = [
  {
    t: "1. Fast path",
    p: "The answer is normalised and matched against the phrasings already stored for the question, with a one character typo tolerance. This is ordinary deterministic code and needs no model, so grading is instant.",
  },
  {
    t: "2. Slow path",
    p: "When nothing in the key covers the phrasing, the contract asks the validators one narrow question and they each answer it independently. The judgement returns a single boolean, and they have to agree on it.",
  },
  {
    t: "3. The key grows",
    p: "A verdict of yes appends the phrasing to contract storage. The model is paid once, for the first person who ever writes it that way, and every player after that is graded from state.",
  },
  {
    t: "4. Nothing is hidden",
    p: "Every ruling is stored with the reason and the address that asked. A key the owner could quietly rewrite would be a record of nothing, so a seeded spelling can be retired but a ruled one cannot.",
  },
];

function Counter({ value }: { value: number }) {
  return <>{useCountUp(value).toLocaleString("en-US")}</>;
}

export default function App() {
  const [questions, setQuestions] = useState<QuestionRow[]>([]);
  const [rulings, setRulings] = useState<RulingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [selected, setSelected] = useState("");
  const [answer, setAnswer] = useState("");

  const [account, setAccount] = useState("");
  const [network, setNetwork] = useState(0);
  const [balance, setBalance] = useState<number | null>(null);
  const [walletBusy, setWalletBusy] = useState("");
  const [copied, setCopied] = useState(false);

  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [justRuled, setJustRuled] = useState<RulingRow | null>(null);

  const progress = useScrollProgress();
  const condensed = useScrolledPast(90);
  const navIds = useMemo(() => NAV.map((n) => n.id), []);
  const active = useActiveSection(navIds, !loading);
  const gridRef = usePointerLight<HTMLDivElement>();
  const stepsRef = usePointerLight<HTMLDivElement>();
  const answerRef = useRef<HTMLInputElement | null>(null);

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

  const readBalance = useCallback(async (address: string) => {
    if (!address) {
      setBalance(null);
      return;
    }
    try {
      setBalance(await balanceOf(address));
    } catch {
      setBalance(null);
    }
  }, []);

  // Wallet state, restored without a prompt and kept honest afterwards. A user
  // who switches account or network in another tab must not be left holding a
  // button that cannot possibly work.
  useEffect(() => {
    (async () => {
      const existing = await silentAccount();
      if (!existing) return;
      setAccount(existing);
      setNetwork(await chainId());
      void readBalance(existing);
    })();
    return watch({
      onAccount: (address) => {
        setAccount(address);
        setActionError("");
        void readBalance(address);
      },
      onChain: (id) => setNetwork(id),
    });
  }, [readBalance]);

  useRevealObserver([loading, questions.length, rulings.length, account, network]);

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

  const mine = useMemo(
    () =>
      account
        ? rulings.filter(
            (r) => (r.asked_by ?? "").toLowerCase() === account.toLowerCase(),
          )
        : [],
    [rulings, account],
  );

  const wrongNetwork = Boolean(account) && network !== 0 && network !== CHAIN_ID;
  const broke = balance !== null && balance < GAS_FLOOR;

  async function walletAction(name: string, fn: () => Promise<void>) {
    setWalletBusy(name);
    setActionError("");
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setWalletBusy("");
    }
  }

  const onConnect = () =>
    walletAction("connect", async () => {
      const address = await connect();
      setAccount(address);
      setNetwork(await chainId());
      await readBalance(address);
    });

  const onDisconnect = () =>
    walletAction("disconnect", async () => {
      await disconnect();
      setAccount("");
      setBalance(null);
    });

  const onSwitch = () =>
    walletAction("switch", async () => {
      await switchToBradbury();
      setNetwork(await chainId());
      await readBalance(account);
    });

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(account);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setActionError("The browser refused clipboard access.");
    }
  }

  function jump(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
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
      void readBalance(account);
      setJustRuled(
        fresh.find((r) => r.question_id === current.id && r.answer === typed) ?? null,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  const backdrop = (
    <div className="aurora" aria-hidden="true">
      <span className="blob b1" />
      <span className="blob b2" />
      <span className="blob b3" />
    </div>
  );

  if (loading) {
    return (
      <>
        {backdrop}
        <div className="spectrum" />
        <div className="shell">
          <div className="loading">
            <span className="scan" />
            Reading the answer key from Bradbury
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {backdrop}
      <div className="spectrum" />
      <div
        className="rail"
        aria-hidden="true"
        style={{ ["--p" as string]: String(progress) }}
      />

      <header className={condensed ? "masthead stuck" : "masthead"}>
        <div className="masthead-in">
          <button
            className="wordmark"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          >
            <div className="mark" />
            <h1>CONCORD</h1>
          </button>

          <nav className="topnav">
            {NAV.map((item) => (
              <button
                key={item.id}
                className={active === item.id ? "navlink on" : "navlink"}
                onClick={() => jump(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="wallet-chip">
            {account ? (
              <button
                className={wrongNetwork ? "chip warn" : "chip live"}
                onClick={() => jump("wallet")}
                title={account}
              >
                <span className="dot" />
                <span className="chip-addr">{short(account)}</span>
                <span className="chip-bal">
                  {wrongNetwork
                    ? "wrong network"
                    : balance === null
                      ? "..."
                      : formatGen(balance) + " GEN"}
                </span>
              </button>
            ) : hasWallet() ? (
              <button
                className="btn small"
                onClick={onConnect}
                disabled={walletBusy === "connect"}
              >
                {walletBusy === "connect" ? "Check the wallet" : "Connect " + walletLabel()}
              </button>
            ) : (
              <a className="chip-link" href={EXPLORER} target="_blank" rel="noreferrer">
                {short(CONTRACT)} on Bradbury
              </a>
            )}
          </div>
        </div>
      </header>

      <div className="shell">
        <section className="hero">
          <p className="kicker rise" style={{ ["--d" as string]: "0ms" }}>
            A GenLayer Intelligent Contract
          </p>
          <h2 className="rise" style={{ ["--d" as string]: "70ms" }}>
            An answer key that <em>learns</em> what a right answer looks like.
          </h2>
          <p className="rise" style={{ ["--d" as string]: "140ms" }}>
            Quiz graders compare strings, so an answer that is right in meaning
            and wrong in wording is marked wrong. Concord keeps the key on
            chain. Grading stays instant and deterministic, and the one thing a
            string comparison cannot do, decide whether two phrasings mean the
            same, is put to GenLayer validators once. What they agree on becomes
            part of the key, and every player after that is graded for free.
          </p>

          <div className="cta rise" style={{ ["--d" as string]: "210ms" }}>
            <button className="btn" onClick={() => jump("try")}>
              Grade an answer
            </button>
            <a className="btn ghost" href={EXPLORER} target="_blank" rel="noreferrer">
              {short(CONTRACT)} on the explorer
            </a>
          </div>

          <div className="stats">
            {[
              { n: questions.length, label: "Questions on chain" },
              { n: totals.forms, label: "Accepted phrasings" },
              { n: rulings.length, label: "Consensus rulings" },
              { n: totals.learned, label: "Phrasings learned" },
            ].map((s, i) => (
              <div
                key={s.label}
                className="stat rise"
                style={{
                  ["--c" as string]: ACCENTS[i],
                  ["--d" as string]: 280 + i * 70 + "ms",
                }}
              >
                <b>
                  <Counter value={s.n} />
                </b>
                <span>{s.label}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Only when there is nothing on screen. Saying "could not read the
            contract" above a page already full of real contract state is just
            wrong, and that is what a transient rate limit used to produce. */}
        {loadError && questions.length === 0 && (
          <p className="err">Could not read the contract: {loadError}</p>
        )}

        <section className="section" id="try" data-reveal>
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
                    answerRef.current?.focus();
                  }}
                >
                  {q.id}
                </button>
              ))}
            </div>

            {current && (
              <div className="console-body" key={current.id}>
                <p className="prompt swap">{current.prompt}</p>

                <div className="answer-row">
                  <input
                    ref={answerRef}
                    value={answer}
                    onChange={(e) => {
                      setAnswer(e.target.value);
                      setJustRuled(null);
                    }}
                    placeholder="Type an answer in your own words"
                    maxLength={120}
                    spellCheck={false}
                  />
                  <button className="btn ghost" onClick={() => setAnswer("")} disabled={!answer}>
                    Clear
                  </button>
                </div>

                {typed && (
                  <div className={"verdict pop " + verdict} key={verdict + typed}>
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
                  <div className="escalate pop">
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
                        <span className="bar" />
                      </div>
                    ) : !hasWallet() ? (
                      <div className="pending muted">
                        An injected wallet is needed to send the transaction.
                      </div>
                    ) : !account ? (
                      <button
                        className="btn"
                        onClick={onConnect}
                        disabled={walletBusy === "connect"}
                      >
                        Connect a wallet to send it
                      </button>
                    ) : wrongNetwork ? (
                      <button
                        className="btn warn"
                        onClick={onSwitch}
                        disabled={walletBusy === "switch"}
                      >
                        Switch to Bradbury first
                      </button>
                    ) : broke ? (
                      <a className="btn warn" href={FAUCET_URL} target="_blank" rel="noreferrer">
                        Get testnet GEN to pay for the round
                      </a>
                    ) : (
                      <button className="btn" onClick={onRule}>
                        Put it to the validators
                      </button>
                    )}
                  </div>
                )}

                {justRuled && (
                  <div
                    className={
                      "verdict pop " + (justRuled.verdict ? "correct" : "ruled_incorrect")
                    }
                  >
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

        <section className="section" id="how" data-reveal>
          <div className="section-head">
            <h3>How it works</h3>
            <span>one model call per phrasing, never per player</span>
          </div>
          <div className="steps" ref={stepsRef}>
            {STEPS.map((s, i) => (
              <div
                key={s.t}
                className="step lift"
                data-light
                data-reveal
                style={{ ["--c" as string]: ACCENTS[i], ["--d" as string]: i * 90 + "ms" }}
              >
                <b>{s.t}</b>
                <p>{s.p}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="section" id="wallet" data-reveal>
          <div className="section-head">
            <h3>Your wallet</h3>
            <span>needed for exactly one thing, and this says which</span>
          </div>

          <div className="wallet-panel">
            <div className="wallet-main" data-light>
              {!hasWallet() ? (
                <>
                  <div className="wallet-state">No injected wallet in this browser</div>
                  <p className="wallet-say">
                    Everything above already works. The key, the rulings and the
                    reasoning behind them are public state on a public chain, so
                    reading them asks nothing of you. A wallet is only needed to
                    send a new phrasing to the validators, because that writes to
                    the contract and somebody has to pay for the round.
                  </p>
                  <a
                    className="btn"
                    href="https://metamask.io/download/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Install a wallet
                  </a>
                </>
              ) : !account ? (
                <>
                  <div className="wallet-state">Not connected</div>
                  <p className="wallet-say">
                    Connecting shows your address, your GEN balance on Bradbury,
                    and every ruling you have ever paid for. It does not unlock
                    anything you cannot already see, because the whole key is
                    readable without it.
                  </p>
                  <button
                    className="btn"
                    onClick={onConnect}
                    disabled={walletBusy === "connect"}
                  >
                    {walletBusy === "connect" ? "Check the wallet" : "Connect " + walletLabel()}
                  </button>
                </>
              ) : (
                <>
                  <div className="wallet-state on">
                    <span className="dot" />
                    Connected with {walletLabel()}
                  </div>

                  <div className="wallet-grid">
                    <div className="wfield">
                      <span>Address</span>
                      <div className="wrow">
                        <code>{short(account)}</code>
                        <button className="btn tiny ghost" onClick={onCopy}>
                          {copied ? "Copied" : "Copy"}
                        </button>
                        <a
                          className="btn tiny ghost"
                          href={EXPLORER_ROOT + "/address/" + account}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Explorer
                        </a>
                      </div>
                    </div>

                    <div className="wfield">
                      <span>Balance</span>
                      <div className="wrow">
                        <code className={broke ? "big low" : "big"}>
                          {balance === null ? "..." : formatGen(balance)}
                        </code>
                        <em>GEN</em>
                        <button
                          className="btn tiny ghost"
                          onClick={() => void readBalance(account)}
                        >
                          Refresh
                        </button>
                      </div>
                    </div>

                    <div className="wfield">
                      <span>Network</span>
                      <div className="wrow">
                        {wrongNetwork ? (
                          <>
                            <code className="low">chain {network}</code>
                            <button
                              className="btn tiny warn"
                              onClick={onSwitch}
                              disabled={walletBusy === "switch"}
                            >
                              Switch to Bradbury
                            </button>
                          </>
                        ) : (
                          <code className="ok">Bradbury, chain {CHAIN_ID}</code>
                        )}
                      </div>
                    </div>

                    <div className="wfield">
                      <span>Session</span>
                      <div className="wrow">
                        <button
                          className="btn tiny ghost"
                          onClick={onDisconnect}
                          disabled={walletBusy === "disconnect"}
                        >
                          Forget this wallet
                        </button>
                      </div>
                    </div>
                  </div>

                  {broke && (
                    <p className="wallet-say warn-say">
                      This account cannot pay for a consensus round. Bradbury is
                      a testnet, so the GEN is free.{" "}
                      <a href={FAUCET_URL} target="_blank" rel="noreferrer">
                        Take some from the faucet
                      </a>{" "}
                      and press Refresh.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="wallet-side" data-light>
              <div className="side-head">What this wallet has decided</div>
              {!account ? (
                <p className="empty small">
                  Connect and any ruling you paid for shows up here, matched on
                  the address the contract stored with it.
                </p>
              ) : mine.length === 0 ? (
                <p className="empty small">
                  Nothing yet from {short(account)}. Type a phrasing the key does
                  not cover and send it to the validators.
                </p>
              ) : (
                <div className="minelist">
                  {mine.map((r, i) => (
                    <div
                      key={r.question_id + "-" + r.answer + "-" + i}
                      className={r.verdict ? "mineitem yes" : "mineitem no"}
                    >
                      <div className="mineq">{r.question_id}</div>
                      <div className="minea">{r.answer}</div>
                      <div className="minev">
                        {r.verdict ? "accepted into the key" : "ruled different"}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="side-foot">
                Read back from the ruling record in contract storage, not from
                this browser.
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="key" data-reveal>
          <div className="section-head">
            <h3>The key</h3>
            <span>violet chips were added by consensus, not by the author</span>
          </div>
          <div className="grid" ref={gridRef}>
            {questions.map((q, i) => (
              <article
                key={q.id}
                className="card lift"
                data-light
                data-reveal
                style={{
                  ["--c" as string]: ACCENTS[i % ACCENTS.length],
                  ["--d" as string]: (i % 3) * 80 + "ms",
                }}
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
                  {q.ruledCount > 0 && " / " + q.ruledCount + " learned by consensus"}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="section" id="rulings" data-reveal>
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
                  key={r.question_id + "-" + r.answer + "-" + i}
                  className={"ruling " + (r.verdict ? "yes" : "no")}
                  data-reveal
                  style={{ ["--d" as string]: Math.min(i, 6) * 70 + "ms" }}
                >
                  <div className="badge">
                    {r.verdict ? "Accepted" : "Refused"}
                    <div className="badge-q">{r.question_id}</div>
                  </div>
                  <div>
                    <div className="quoted">{r.answer}</div>
                    <div className="why">{r.reason}</div>
                    {r.asked_by && (
                      <a
                        className="asker"
                        href={EXPLORER_ROOT + "/address/" + r.asked_by}
                        target="_blank"
                        rel="noreferrer"
                      >
                        asked by {short(r.asked_by)}
                        {account && r.asked_by.toLowerCase() === account.toLowerCase()
                          ? ", which is you"
                          : ""}
                      </a>
                    )}
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
          <span>{account ? "Connected " + short(account) : "Reads need no wallet"}</span>
        </footer>
      </div>
    </>
  );
}
