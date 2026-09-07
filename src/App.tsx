import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from "motion/react";
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
  useScrolledPast,
} from "./lib/motion";
import { motionTokens, revealVariants, staggerParent } from "./lib/motionTokens";
import { useWallet } from "./lib/useWallet";
import { CHAIN_ID, EXPLORER_ROOT, FAUCET_URL, formatGen, short } from "./lib/wallet";
import { WalletButton } from "./components/WalletButton";
import { WalletPicker } from "./components/WalletPicker";

const ACCENTS = ["var(--cyan)", "var(--magenta)", "var(--violet)", "var(--blue)"];
/** Raw channels too, because the ambient field interpolates the colour. */
const ACCENT_RGB = ["94,220,246", "214,86,240", "162,116,255", "86,150,255"];

const NAV = [
  { id: "try", label: "Try it" },
  { id: "how", label: "How it works" },
  { id: "wallet", label: "Wallet" },
  { id: "key", label: "The key" },
  { id: "rulings", label: "Rulings" },
];

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

/** A block that arrives as the reader reaches it. */
function Reveal({
  children,
  className,
  id,
}: {
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <motion.section
      id={id}
      className={className}
      variants={revealVariants}
      initial="hidden"
      // `once` matters. A block that re-animates every time it scrolls back
      // into view turns a long page into a flicker, and it also means anything
      // the reader has already passed stays visible instead of resetting.
      whileInView="visible"
      viewport={{ once: true, amount: 0.15 }}
    >
      {children}
    </motion.section>
  );
}

export default function App() {
  const [questions, setQuestions] = useState<QuestionRow[]>([]);
  const [rulings, setRulings] = useState<RulingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [selected, setSelected] = useState("");
  const [answer, setAnswer] = useState("");

  const [pending, setPending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [justRuled, setJustRuled] = useState<RulingRow | null>(null);
  const [picking, setPicking] = useState(false);
  const [copied, setCopied] = useState(false);

  const wallet = useWallet();
  const reduce = useReducedMotion();
  const answerRef = useRef<HTMLInputElement | null>(null);

  const { scrollYProgress } = useScroll();
  const railScale = useSpring(scrollYProgress, {
    stiffness: 140,
    damping: 24,
    restDelta: 0.001,
  });
  // The ambient field drifts against the scroll. Small on purpose: enough to
  // read as depth, not enough to notice as an effect.
  const fieldY = useTransform(scrollYProgress, [0, 1], [0, reduce ? 0 : -90]);

  const condensed = useScrolledPast(90);
  const navIds = useMemo(() => NAV.map((n) => n.id), []);
  const active = useActiveSection(navIds, !loading);
  const gridRef = usePointerLight<HTMLDivElement>();
  const stepsRef = usePointerLight<HTMLDivElement>();

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
  const currentIndex = Math.max(
    0,
    questions.findIndex((q) => q.id === selected),
  );

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
      wallet.account
        ? rulings.filter(
            (r) => (r.asked_by ?? "").toLowerCase() === wallet.account.toLowerCase(),
          )
        : [],
    [rulings, wallet.account],
  );

  function jump(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // One wallet means no chooser: a dialog with a single option is a click for
  // nothing. Two or more and the user picks, because choosing for them is how
  // you connect somebody to the wrong account.
  function startConnect() {
    if (wallet.options.length === 1) {
      void wallet.connectTo(wallet.options[0]);
      return;
    }
    setPicking(true);
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(wallet.account);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setSendError("The browser refused clipboard access.");
    }
  }

  async function onRule() {
    if (!current || !typed || !wallet.provider) return;
    setPending(true);
    setSendError("");
    setJustRuled(null);
    try {
      await rule(wallet.provider, wallet.account, current.id, answer.trim());
      const fresh = await loadRulings(12);
      setRulings(fresh);
      await refresh();
      void wallet.refreshBalance();
      setJustRuled(
        fresh.find((r) => r.question_id === current.id && r.answer === typed) ?? null,
      );
    } catch (err) {
      // A wallet reports the user closing the prompt as an error. It is not
      // one, and painting it red makes a normal choice look like a failure.
      if ((err as { code?: number })?.code !== 4001) {
        setSendError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setPending(false);
    }
  }

  // The ambient light takes the colour of the question being worked on, so the
  // background reports state instead of decorating. It is the only large soft
  // light on the page, which is what keeps it from reading as filler.
  const fieldColor = ACCENT_RGB[currentIndex % ACCENT_RGB.length];
  // The second light takes the next accent along, so the pair always reads as a
  // gradient across the spectrum rather than one hue washed twice.
  const auxColor = ACCENT_RGB[(currentIndex + 1) % ACCENT_RGB.length];

  const backdrop = (
    <motion.div className="field" aria-hidden="true" style={{ y: fieldY }}>
      <motion.span
        className="field-core"
        animate={{ backgroundColor: `rgba(${fieldColor}, 0.30)` }}
        transition={{
          duration: motionTokens.duration.slow,
          ease: motionTokens.easing.smooth,
        }}
      />
      <motion.span
        className="field-aux"
        animate={{ backgroundColor: `rgba(${auxColor}, 0.18)` }}
        transition={{
          duration: motionTokens.duration.slow,
          ease: motionTokens.easing.smooth,
        }}
      />
      <span className="field-edge" />
    </motion.div>
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
      <motion.div className="rail" aria-hidden="true" style={{ scaleX: railScale }} />

      <header className={condensed ? "masthead stuck" : "masthead"}>
        <div className="masthead-in">
          <motion.button
            className="wordmark"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            whileHover={reduce ? undefined : { scale: 1.02 }}
            whileTap={reduce ? undefined : { scale: 0.98 }}
            transition={{ duration: motionTokens.duration.fast }}
          >
            <div className="mark" />
            <h1>CONCORD</h1>
          </motion.button>

          <nav className="topnav">
            {NAV.map((item) => (
              <button
                key={item.id}
                className={active === item.id ? "navlink on" : "navlink"}
                onClick={() => jump(item.id)}
              >
                <span>{item.label}</span>
                {active === item.id && (
                  // One underline that travels between items rather than five
                  // that fade in place. The travel is what says these are one
                  // control and you are somewhere inside it.
                  <motion.span
                    className="navmark"
                    layoutId="navmark"
                    transition={{ type: "spring", stiffness: 380, damping: 32 }}
                  />
                )}
              </button>
            ))}
          </nav>

          <div className="wallet-chip">
            <WalletButton
              wallet={wallet}
              onConnect={startConnect}
              onOpenPanel={() => jump("wallet")}
            />
          </div>
        </div>
      </header>

      <div className="shell">
        <motion.section
          className="hero"
          variants={staggerParent}
          initial="hidden"
          animate="visible"
        >
          <motion.p className="kicker" variants={revealVariants}>
            A GenLayer Intelligent Contract
          </motion.p>
          <motion.h2 variants={revealVariants}>
            An answer key that <em>learns</em> what a right answer looks like.
          </motion.h2>
          <motion.p variants={revealVariants}>
            Quiz graders compare strings, so an answer that is right in meaning
            and wrong in wording is marked wrong. Concord keeps the key on
            chain. Grading stays instant and deterministic, and the one thing a
            string comparison cannot do, decide whether two phrasings mean the
            same, is put to GenLayer validators once. What they agree on becomes
            part of the key, and every player after that is graded for free.
          </motion.p>

          <motion.div className="cta" variants={revealVariants}>
            <motion.button
              className="btn"
              onClick={() => jump("try")}
              whileHover={reduce ? undefined : { scale: 1.03 }}
              whileTap={reduce ? undefined : { scale: 0.97 }}
              transition={{ duration: motionTokens.duration.fast }}
            >
              Grade an answer
            </motion.button>
            <motion.a
              className="btn ghost"
              href={EXPLORER}
              target="_blank"
              rel="noreferrer"
              whileHover={reduce ? undefined : { scale: 1.02 }}
              whileTap={reduce ? undefined : { scale: 0.98 }}
              transition={{ duration: motionTokens.duration.fast }}
            >
              {short(CONTRACT)} on the explorer
            </motion.a>
          </motion.div>

          <motion.div className="stats" variants={staggerParent}>
            {[
              { n: questions.length, label: "Questions on chain" },
              { n: totals.forms, label: "Accepted phrasings" },
              { n: rulings.length, label: "Consensus rulings" },
              { n: totals.learned, label: "Phrasings learned" },
            ].map((s, i) => (
              <motion.div
                key={s.label}
                className="stat"
                variants={revealVariants}
                style={{ ["--c" as string]: ACCENTS[i] }}
              >
                <b>
                  <Counter value={s.n} />
                </b>
                <span>{s.label}</span>
              </motion.div>
            ))}
          </motion.div>
        </motion.section>

        {loadError && questions.length === 0 && (
          <p className="err">Could not read the contract: {loadError}</p>
        )}

        <Reveal className="section" id="try">
          <div className="section-head">
            <h3>Try it</h3>
            <span>graded locally against the on chain key, no wallet needed</span>
          </div>

          <div className="console">
            <div className="console-top" role="tablist">
              {questions.map((q) => (
                <motion.button
                  key={q.id}
                  className="qtab"
                  role="tab"
                  aria-selected={q.id === selected}
                  whileHover={reduce ? undefined : { y: -2 }}
                  whileTap={reduce ? undefined : { scale: 0.96 }}
                  transition={{ duration: motionTokens.duration.fast }}
                  onClick={() => {
                    setSelected(q.id);
                    setAnswer("");
                    setJustRuled(null);
                    setSendError("");
                    answerRef.current?.focus();
                  }}
                >
                  {q.id === selected && (
                    <motion.span
                      className="qtab-fill"
                      layoutId="qtabfill"
                      transition={{ type: "spring", stiffness: 420, damping: 34 }}
                    />
                  )}
                  <span className="qtab-label">{q.id}</span>
                </motion.button>
              ))}
            </div>

            {current && (
              <div className="console-body">
                <AnimatePresence mode="wait">
                  <motion.p
                    key={current.id}
                    className="prompt"
                    initial={{ opacity: 0, x: reduce ? 0 : -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: reduce ? 0 : 10 }}
                    transition={{
                      duration: motionTokens.duration.normal,
                      ease: motionTokens.easing.smooth,
                    }}
                  >
                    {current.prompt}
                  </motion.p>
                </AnimatePresence>

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

                <AnimatePresence mode="wait">
                  {typed && (
                    <motion.div
                      key={verdict + typed}
                      className={"verdict " + verdict}
                      initial={{ opacity: 0, y: reduce ? 0 : 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: reduce ? 0 : -6 }}
                      transition={{
                        duration: motionTokens.duration.normal,
                        ease: motionTokens.easing.smooth,
                      }}
                    >
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
                    </motion.div>
                  )}
                </AnimatePresence>

                <AnimatePresence mode="wait">
                  {typed && verdict === "unknown" && (
                    <motion.div
                      key="escalate"
                      className="escalate"
                      initial={{ opacity: 0, y: reduce ? 0 : 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{
                        duration: motionTokens.duration.normal,
                        ease: motionTokens.easing.smooth,
                      }}
                    >
                      <p>
                        Put it to the validators. They will each judge whether{" "}
                        <strong>{typed}</strong> means the same as the canonical
                        answer and must agree on the verdict. If they say yes,
                        the phrasing joins the key on chain and is graded
                        instantly from then on, for everyone.
                      </p>

                      {pending ? (
                        <div className="pending">
                          <span className="pulse" />
                          Consensus round running. This takes about a minute.
                          <span className="bar" />
                        </div>
                      ) : !wallet.options.length ? (
                        <div className="pending muted">
                          {wallet.settled
                            ? "No wallet found in this browser, so this is as far as the page goes."
                            : "Looking for a wallet..."}
                        </div>
                      ) : !wallet.account ? (
                        <motion.button
                          className="btn"
                          onClick={startConnect}
                          disabled={wallet.busy === "connect"}
                          whileHover={reduce ? undefined : { scale: 1.02 }}
                          whileTap={reduce ? undefined : { scale: 0.97 }}
                        >
                          Connect a wallet to send it
                        </motion.button>
                      ) : wallet.wrongNetwork ? (
                        <motion.button
                          className="btn warn"
                          onClick={wallet.switchNetwork}
                          disabled={wallet.busy === "switch"}
                          whileHover={reduce ? undefined : { scale: 1.02 }}
                          whileTap={reduce ? undefined : { scale: 0.97 }}
                        >
                          Switch to Bradbury first
                        </motion.button>
                      ) : wallet.broke ? (
                        <a className="btn warn" href={FAUCET_URL} target="_blank" rel="noreferrer">
                          Get testnet GEN to pay for the round
                        </a>
                      ) : (
                        <motion.button
                          className="btn"
                          onClick={onRule}
                          whileHover={reduce ? undefined : { scale: 1.02 }}
                          whileTap={reduce ? undefined : { scale: 0.97 }}
                        >
                          Put it to the validators
                        </motion.button>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>

                <AnimatePresence>
                  {justRuled && (
                    <motion.div
                      key="justruled"
                      className={
                        "verdict " + (justRuled.verdict ? "correct" : "ruled_incorrect")
                      }
                      initial={{ opacity: 0, scale: reduce ? 1 : 0.97 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{
                        duration: motionTokens.duration.normal,
                        ease: motionTokens.easing.smooth,
                      }}
                    >
                      <span className="tag">
                        {justRuled.verdict ? "Ruled acceptable" : "Ruled different"}
                      </span>
                      <span className="say">{justRuled.reason}</span>
                    </motion.div>
                  )}
                </AnimatePresence>

                {(sendError || wallet.error) && (
                  <p className="err">{sendError || wallet.error}</p>
                )}
              </div>
            )}
          </div>
        </Reveal>

        <Reveal className="section" id="how">
          <div className="section-head">
            <h3>How it works</h3>
            <span>one model call per phrasing, never per player</span>
          </div>
          <motion.div
            className="steps"
            ref={stepsRef}
            variants={staggerParent}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.2 }}
          >
            {STEPS.map((s, i) => (
              <motion.div
                key={s.t}
                className="step"
                data-light
                variants={revealVariants}
                whileHover={reduce ? undefined : { y: -4 }}
                transition={{ duration: motionTokens.duration.fast }}
                style={{ ["--c" as string]: ACCENTS[i] }}
              >
                <b>{s.t}</b>
                <p>{s.p}</p>
              </motion.div>
            ))}
          </motion.div>
        </Reveal>

        <Reveal className="section" id="wallet">
          <div className="section-head">
            <h3>Your wallet</h3>
            <span>needed for exactly one thing, and this says which</span>
          </div>

          <div className="wallet-panel">
            <div className="wallet-main" data-light>
              <AnimatePresence mode="wait">
                {wallet.account ? (
                  <motion.div
                    key="connected"
                    initial={{ opacity: 0, y: reduce ? 0 : 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{
                      duration: motionTokens.duration.normal,
                      ease: motionTokens.easing.smooth,
                    }}
                  >
                    <div className="wallet-state on">
                      <span className="dot" />
                      Connected with {wallet.chosen?.name ?? "your wallet"}
                    </div>

                    <div className="wallet-grid">
                      <div className="wfield">
                        <span>Address</span>
                        <div className="wrow">
                          <code>{short(wallet.account)}</code>
                          <button className="btn tiny ghost" onClick={onCopy}>
                            {copied ? "Copied" : "Copy"}
                          </button>
                          <a
                            className="btn tiny ghost"
                            href={EXPLORER_ROOT + "/address/" + wallet.account}
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
                          <code className={wallet.broke ? "big low" : "big"}>
                            {wallet.balance === null ? "..." : formatGen(wallet.balance)}
                          </code>
                          <em>GEN</em>
                          <button
                            className="btn tiny ghost"
                            onClick={wallet.refreshBalance}
                            disabled={wallet.busy === "balance"}
                          >
                            {wallet.busy === "balance" ? "Reading" : "Refresh"}
                          </button>
                        </div>
                      </div>

                      <div className="wfield">
                        <span>Network</span>
                        <div className="wrow">
                          {wallet.wrongNetwork ? (
                            <>
                              <code className="low">chain {wallet.network}</code>
                              <button
                                className="btn tiny warn"
                                onClick={wallet.switchNetwork}
                                disabled={wallet.busy === "switch"}
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
                            onClick={wallet.leave}
                            disabled={wallet.busy === "disconnect"}
                          >
                            Forget this wallet
                          </button>
                        </div>
                      </div>
                    </div>

                    {wallet.broke && (
                      <p className="wallet-say warn-say">
                        This account cannot pay for a consensus round. Bradbury
                        is a testnet, so the GEN is free.{" "}
                        <a href={FAUCET_URL} target="_blank" rel="noreferrer">
                          Take some from the faucet
                        </a>{" "}
                        and press Refresh.
                      </p>
                    )}
                  </motion.div>
                ) : wallet.options.length ? (
                  <motion.div
                    key="disconnected"
                    initial={{ opacity: 0, y: reduce ? 0 : 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{
                      duration: motionTokens.duration.normal,
                      ease: motionTokens.easing.smooth,
                    }}
                  >
                    <div className="wallet-state">
                      {wallet.options.length === 1
                        ? wallet.options[0].name + " is available"
                        : wallet.options.length + " wallets available"}
                    </div>
                    <p className="wallet-say">
                      Connecting shows your address, your GEN balance on
                      Bradbury, and every ruling you have ever paid for. It does
                      not unlock anything you cannot already see, because the
                      whole key is readable without it.
                    </p>
                    <motion.button
                      className="btn"
                      onClick={startConnect}
                      disabled={wallet.busy === "connect"}
                      whileHover={reduce ? undefined : { scale: 1.02 }}
                      whileTap={reduce ? undefined : { scale: 0.97 }}
                    >
                      {wallet.busy === "connect" ? "Check the wallet" : "Connect wallet"}
                    </motion.button>
                  </motion.div>
                ) : (
                  <motion.div
                    key="nowallet"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: motionTokens.duration.normal }}
                  >
                    <div className="wallet-state">
                      {wallet.settled
                        ? "No injected wallet in this browser"
                        : "Looking for a wallet"}
                    </div>
                    <p className="wallet-say">
                      Everything above already works. The key, the rulings and
                      the reasoning behind them are public state on a public
                      chain, so reading them asks nothing of you. A wallet is
                      only needed to send a new phrasing to the validators,
                      because that writes to the contract and somebody has to
                      pay for the round.
                    </p>
                    {wallet.settled && (
                      <a
                        className="btn"
                        href="https://metamask.io/download/"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Install a wallet
                      </a>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="wallet-side" data-light>
              <div className="side-head">What this wallet has decided</div>
              {!wallet.account ? (
                <p className="empty small">
                  Connect and any ruling you paid for shows up here, matched on
                  the address the contract stored with it.
                </p>
              ) : mine.length === 0 ? (
                <p className="empty small">
                  Nothing yet from {short(wallet.account)}. Type a phrasing the
                  key does not cover and send it to the validators.
                </p>
              ) : (
                <motion.div
                  className="minelist"
                  variants={staggerParent}
                  initial="hidden"
                  animate="visible"
                >
                  {mine.map((r, i) => (
                    <motion.div
                      key={r.question_id + "-" + r.answer + "-" + i}
                      className={r.verdict ? "mineitem yes" : "mineitem no"}
                      variants={revealVariants}
                    >
                      <div className="mineq">{r.question_id}</div>
                      <div className="minea">{r.answer}</div>
                      <div className="minev">
                        {r.verdict ? "accepted into the key" : "ruled different"}
                      </div>
                    </motion.div>
                  ))}
                </motion.div>
              )}
              <div className="side-foot">
                Read back from the ruling record in contract storage, not from
                this browser.
              </div>
            </div>
          </div>
        </Reveal>

        <Reveal className="section" id="key">
          <div className="section-head">
            <h3>The key</h3>
            <span>violet chips were added by consensus, not by the author</span>
          </div>
          <motion.div
            className="grid"
            ref={gridRef}
            variants={staggerParent}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.05 }}
          >
            {questions.map((q, i) => (
              <motion.article
                key={q.id}
                className="card"
                data-light
                variants={revealVariants}
                whileHover={reduce ? undefined : { y: -5 }}
                transition={{ duration: motionTokens.duration.fast }}
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
                      <motion.span
                        key={f}
                        className={learned ? "form ruled" : "form"}
                        whileHover={reduce ? undefined : { scale: 1.05 }}
                        transition={{ duration: motionTokens.duration.fast }}
                      >
                        {f}
                      </motion.span>
                    );
                  })}
                </div>
                <div className="card-foot">
                  {q.forms.length} accepted
                  {q.ruledCount > 0 && " / " + q.ruledCount + " learned by consensus"}
                </div>
              </motion.article>
            ))}
          </motion.div>
        </Reveal>

        <Reveal className="section" id="rulings">
          <div className="section-head">
            <h3>What the validators decided</h3>
            <span>newest first, read from contract storage</span>
          </div>
          {rulings.length === 0 ? (
            <p className="empty">No rulings yet. Be the first to put a phrasing to the chain.</p>
          ) : (
            <motion.div
              className="feed"
              variants={staggerParent}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, amount: 0.1 }}
            >
              {rulings.map((r, i) => (
                <motion.div
                  key={r.question_id + "-" + r.answer + "-" + i}
                  className={"ruling " + (r.verdict ? "yes" : "no")}
                  variants={revealVariants}
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
                        {wallet.account &&
                        r.asked_by.toLowerCase() === wallet.account.toLowerCase()
                          ? ", which is you"
                          : ""}
                      </a>
                    )}
                  </div>
                </motion.div>
              ))}
            </motion.div>
          )}
        </Reveal>

        <footer className="foot">
          <span>
            Intelligent Contract on GenLayer Testnet Bradbury.{" "}
            <a href={EXPLORER} target="_blank" rel="noreferrer">
              Read it on the explorer
            </a>
          </span>
          <span>
            {wallet.account ? "Connected " + short(wallet.account) : "Reads need no wallet"}
          </span>
        </footer>
      </div>

      <WalletPicker
        open={picking}
        options={wallet.options}
        busy={wallet.busy === "connect"}
        onPick={(option) => {
          setPicking(false);
          void wallet.connectTo(option);
        }}
        onClose={() => setPicking(false)}
      />
    </>
  );
}
