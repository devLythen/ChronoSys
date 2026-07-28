import { useEffect, useRef, useState, useCallback } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

/* ── Page Entrance ─────────────────────────────────────────── */

/** Page wrapper: fade-up on mount. Attach ref to the root page div. */
export function usePageEnter<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(el, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.3, ease: "power2.out" });
    });

    return () => mm.revert();
  }, []);

  return ref;
}

/* ── Scroll Reveal ─────────────────────────────────────────── */

/** Fade-up reveal when element enters viewport. */
export function useScrollReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(
        el,
        { opacity: 0, y: 12 },
        {
          opacity: 1, y: 0,
          duration: 0.35,
          ease: "power1.out",
          scrollTrigger: { trigger: el, start: "top 92%", toggleActions: "play none none reverse" },
        },
      );
    });

    return () => mm.revert();
  }, []);

  return ref;
}

/* ── Staggered List ────────────────────────────────────────── */

/**
 * Staggered fade-up for a container's children.
 * Children need class `anim-item`. Re-triggers when `deps` change.
 * By default uses ScrollTrigger; pass `scroll: false` for mount-only.
 */
export function useStaggerList<T extends HTMLElement>(
  deps?: unknown[],
  opts?: { scroll?: boolean; stagger?: number; duration?: number },
) {
  const ref = useRef<T>(null);
  const { scroll = true, stagger = 0.03, duration = 0.3 } = opts ?? {};

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      const items = el.querySelectorAll(".anim-item");
      gsap.fromTo(
        items,
        { opacity: 0, y: 8 },
        {
          opacity: 1, y: 0,
          duration,
          stagger,
          ease: "power1.out",
          ...(scroll
            ? { scrollTrigger: { trigger: el, start: "top 92%", toggleActions: "play none none reverse" } }
            : {}),
        },
      );
    });

    return () => mm.revert();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps ?? []);

  return ref;
}

/* ── Count-Up ───────────────────────────────────────────────── */

/**
 * Animate a number from 0 (or `from`) to `to` over `duration` seconds.
 * Returns the current animated value as an integer.
 */
export function useCountUp(to: number, opts?: { from?: number; duration?: number; enabled?: boolean }) {
  const { from = 0, duration = 0.8, enabled = true } = opts ?? {};
  const [display, setDisplay] = useState(from);
  const objRef = useRef({ val: from });
  const tweenRef = useRef<gsap.core.Tween | null>(null);

  const start = useCallback(() => {
    tweenRef.current?.kill();
    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      objRef.current.val = from;
      tweenRef.current = gsap.to(objRef.current, {
        val: to,
        duration,
        ease: "power2.out",
        onUpdate: () => setDisplay(Math.round(objRef.current.val)),
      });
    });
    mm.add("(prefers-reduced-motion: reduce)", () => {
      setDisplay(to);
    });
  }, [to, from, duration]);

  useEffect(() => {
    if (enabled) start();
    return () => { tweenRef.current?.kill(); };
  }, [enabled, start]);

  return display;
}

/* ── Expand/Collapse ────────────────────────────────────────── */

/** Animate height + opacity for accordion expand/collapse. */
export function useExpandCollapse<T extends HTMLElement>(expanded: boolean) {
  const ref = useRef<T>(null);
  const tweenRef = useRef<gsap.core.Tween | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    tweenRef.current?.kill();

    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      if (expanded) {
        gsap.fromTo(el, { height: 0, opacity: 0 }, { height: "auto", opacity: 1, duration: 0.2, ease: "power2.out" });
      } else {
        tweenRef.current = gsap.to(el, { height: 0, opacity: 0, duration: 0.15, ease: "power2.in" });
      }
    });
    mm.add("(prefers-reduced-motion: reduce)", () => {
      gsap.set(el, { height: expanded ? "auto" : 0, opacity: expanded ? 1 : 0 });
    });

    return () => { mm.revert(); tweenRef.current?.kill(); };
  }, [expanded]);

  return ref;
}

