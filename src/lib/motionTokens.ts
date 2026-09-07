// One place for timing, so thirty animations read as one system rather than as
// thirty opinions. Everything in the app pulls its duration and easing here.

export const motionTokens = {
  duration: {
    fast: 0.18,
    normal: 0.35,
    slow: 0.6,
  },
  easing: {
    smooth: [0.22, 1, 0.36, 1] as [number, number, number, number],
    sharp: [0.4, 0, 0.2, 1] as [number, number, number, number],
  },
  distance: {
    sm: 8,
    md: 16,
    lg: 24,
  },
} as const;

/**
 * A cheap read on whether this machine will cope with the ambient work. Chrome
 * and Android report memory; Safari and Firefox do not, so core count stands in
 * there. Anything unknown is treated as capable, because degrading a good
 * machine is worse than briefly taxing a weak one.
 */
export function isLowEndDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const memory = (navigator as { deviceMemory?: number }).deviceMemory;
  if (memory !== undefined) return memory <= 2;
  return navigator.hardwareConcurrency !== undefined && navigator.hardwareConcurrency <= 4;
}

/** The reveal used by every block below the fold. */
export const revealVariants = {
  hidden: { opacity: 0, y: motionTokens.distance.lg },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: motionTokens.duration.slow,
      ease: motionTokens.easing.smooth,
    },
  },
};

/** Parent for a list that should arrive in order rather than all at once. */
export const staggerParent = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.07 } },
};
