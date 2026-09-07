import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { motionTokens } from "../lib/motionTokens";
import { formatGen, short } from "../lib/wallet";
import type { WalletState } from "../lib/useWallet";

/**
 * The wallet control in the masthead.
 *
 * It is always present and it always says something true, which is the part
 * that was broken: the page used to decide once, during the first render, that
 * there was no wallet, and then never look again. Now the four states are real
 * states, including the one in between where discovery has started and no
 * wallet has answered yet.
 */
export function WalletButton({
  wallet,
  onConnect,
  onOpenPanel,
}: {
  wallet: WalletState;
  onConnect: () => void;
  onOpenPanel: () => void;
}) {
  const reduce = useReducedMotion();
  const press = reduce ? undefined : { scale: 0.97 };
  const hover = reduce ? undefined : { scale: 1.02 };
  const swap = {
    initial: { opacity: 0, y: reduce ? 0 : -6 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: reduce ? 0 : 6 },
    transition: {
      duration: motionTokens.duration.fast,
      ease: motionTokens.easing.smooth,
    },
  };

  const state = wallet.account
    ? "connected"
    : wallet.options.length
      ? "ready"
      : wallet.settled
        ? "none"
        : "looking";

  return (
    <AnimatePresence mode="wait" initial={false}>
      {state === "connected" && (
        <motion.button
          key="connected"
          {...swap}
          whileHover={hover}
          whileTap={press}
          className={wallet.wrongNetwork ? "chip warn" : "chip live"}
          onClick={onOpenPanel}
          title={wallet.account}
        >
          <span className="dot" />
          <span className="chip-addr">{short(wallet.account)}</span>
          <span className="chip-bal">
            {wallet.wrongNetwork
              ? "wrong network"
              : wallet.balance === null
                ? "..."
                : formatGen(wallet.balance) + " GEN"}
          </span>
        </motion.button>
      )}

      {state === "ready" && (
        <motion.button
          key="ready"
          {...swap}
          whileHover={hover}
          whileTap={press}
          className="btn small connect"
          onClick={onConnect}
          disabled={wallet.busy === "connect"}
        >
          {wallet.busy === "connect" ? "Check the wallet" : "Connect wallet"}
        </motion.button>
      )}

      {state === "looking" && (
        <motion.span key="looking" {...swap} className="chip quiet">
          <span className="dot searching" />
          Looking for a wallet
        </motion.span>
      )}

      {state === "none" && (
        <motion.a
          key="none"
          {...swap}
          whileHover={hover}
          className="chip quiet"
          href="https://metamask.io/download/"
          target="_blank"
          rel="noreferrer"
        >
          No wallet found. Install one
        </motion.a>
      )}
    </AnimatePresence>
  );
}
