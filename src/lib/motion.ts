// The motion this app needs that Framer does not already give it.
//
// Reveal, scroll progress and gesture states all moved to `motion/react`, which
// does them better and in fewer lines. What is left here is the small stuff
// with no library equivalent: a counter that lands exactly on its target, a
// sticky-header threshold, a scrollspy that survives the sections not existing
// yet, and a pointer light driven by CSS custom properties.
//
// Every hook checks `prefers-reduced-motion` and degrades to the finished
// state rather than to a broken one.

import { useEffect, useRef, useState } from "react";

export function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** True once the page has scrolled past `after`, for the condensing masthead. */
export function useScrolledPast(after: number): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      setPast(window.scrollY > after);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, [after]);
  return past;
}

/**
 * Counts to `target` on an ease out. These are counts of real things read from
 * the contract, so the animation always lands exactly on the value: the last
 * frame assigns the target rather than the eased approximation of it.
 */
export function useCountUp(target: number, duration = 900): number {
  const [value, setValue] = useState(reducedMotion() ? target : 0);
  const from = useRef(0);

  useEffect(() => {
    if (reducedMotion()) {
      setValue(target);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      if (t >= 1) {
        setValue(target);
        from.current = target;
        return;
      }
      setValue(Math.round(origin + (target - origin) * eased));
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);

  return value;
}

/**
 * Marks whichever section the reader is currently in, so the rail can say where
 * they are.
 *
 * This was an IntersectionObserver watching a thin band across the middle of
 * the viewport, and QA showed why that is the wrong tool: sections are wildly
 * different heights, so a short one can pass through the band between two
 * frames, and the final section never enters it at all because the page runs
 * out of scroll first. The reader would reach the bottom with the wrong item
 * lit. A trigger line is boring and always right: the active section is the
 * last one whose top has crossed it, and the bottom of the document always
 * means the last section.
 */
export function useActiveSection(ids: string[], ready: boolean): string {
  const [active, setActive] = useState(ids[0] ?? "");

  useEffect(() => {
    if (!ready) return;
    let frame = 0;

    const measure = () => {
      frame = 0;
      const sections = ids
        .map((id) => document.getElementById(id))
        .filter((node): node is HTMLElement => Boolean(node));
      if (!sections.length) return;

      const atBottom =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 4;
      if (atBottom) {
        setActive(sections[sections.length - 1].id);
        return;
      }

      const line = window.scrollY + window.innerHeight * 0.3;
      let current = sections[0].id;
      for (const section of sections) {
        if (section.offsetTop <= line) current = section.id;
      }
      setActive(current);
    };

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [ids, ready]);

  return active;
}

/**
 * Writes the pointer position onto the element as `--mx` / `--my` percentages,
 * which the stylesheet turns into a light that follows the cursor. Delegated on
 * the container so a grid of cards costs one listener, not one per card.
 */
export function usePointerLight<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host || reducedMotion()) return;
    const onMove = (event: PointerEvent) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
        "[data-light]",
      );
      if (!target) return;
      const box = target.getBoundingClientRect();
      target.style.setProperty("--mx", `${((event.clientX - box.left) / box.width) * 100}%`);
      target.style.setProperty("--my", `${((event.clientY - box.top) / box.height) * 100}%`);
    };
    host.addEventListener("pointermove", onMove);
    return () => host.removeEventListener("pointermove", onMove);
  }, []);
  return ref;
}
