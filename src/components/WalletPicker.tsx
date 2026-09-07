import { useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { motionTokens } from "../lib/motionTokens";
import type { WalletOption } from "../lib/wallet";

/**
 * Which wallet. Shown whenever more than one has announced itself, because
 * picking for the user is how you connect somebody to the wrong account.
 *
 * With exactly one wallet the caller never opens this and connects straight
 * through, since a chooser with a single choice is just a extra click.
 */
export function WalletPicker({
  open,
  options,
  busy,
  onPick,
  onClose,
}: {
  open: boolean;
  options: WalletOption[];
  busy: boolean;
  onPick: (option: WalletOption) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = panel.current.querySelectorAll<HTMLElement>(
        'button, [href], input, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence mode="wait">
      {open && (
        <motion.div
          className="scrim"
          role="dialog"
          aria-modal="true"
          aria-labelledby="wallet-picker-title"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: motionTokens.duration.fast }}
          onClick={onClose}
        >
          <motion.div
            ref={panel}
            className="picker"
            initial={{ opacity: 0, scale: reduce ? 1 : 0.96, y: reduce ? 0 : 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: reduce ? 1 : 0.96, y: reduce ? 0 : 8 }}
            transition={{
              duration: motionTokens.duration.normal,
              ease: motionTokens.easing.smooth,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <h4 id="wallet-picker-title">Choose a wallet</h4>
            <p>
              More than one is installed. Concord will use the one you pick for
              the single write it ever makes.
            </p>

            <div className="picker-list">
              {options.map((option) => (
                <motion.button
                  key={option.id}
                  className="picker-row"
                  disabled={busy}
                  onClick={() => onPick(option)}
                  whileHover={reduce ? undefined : { x: 4 }}
                  whileTap={reduce ? undefined : { scale: 0.99 }}
                  transition={{
                    duration: motionTokens.duration.fast,
                    ease: motionTokens.easing.sharp,
                  }}
                >
                  {option.icon ? (
                    <img src={option.icon} alt="" width={28} height={28} />
                  ) : (
                    <span className="picker-fallback" aria-hidden="true" />
                  )}
                  <span>{option.name}</span>
                </motion.button>
              ))}
            </div>

            <button className="btn ghost small" onClick={onClose}>
              Cancel
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
