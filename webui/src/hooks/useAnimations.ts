import { useEffect, useRef, useState } from "react";
import { loadGsap, loadGsapWithScrollTrigger } from "../lib/motion";

type Killable = { kill: () => void };

/** Page wrapper: fade-up on mount. Attach ref to the root page div. */
export function usePageEnter<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    let revert: (() => void) | undefined;

    void loadGsap().then((gsap) => {
      if (disposed) return;
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.fromTo(el, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.3, ease: "power2.out" });
      });
      revert = () => mm.revert();
    });

    return () => {
      disposed = true;
      revert?.();
    };
  }, []);

  return ref;
}

/** Fade-up reveal when element enters viewport. */
export function useScrollReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    let revert: (() => void) | undefined;

    void loadGsapWithScrollTrigger().then((gsap) => {
      if (disposed) return;
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.fromTo(el, { opacity: 0, y: 12 }, {
          opacity: 1, y: 0, duration: 0.35, ease: "power1.out",
          scrollTrigger: { trigger: el, start: "top 92%", toggleActions: "play none none reverse" },
        });
      });
      revert = () => mm.revert();
    });

    return () => {
      disposed = true;
      revert?.();
    };
  }, []);

  return ref;
}

/** Staggered fade-up for a container's `.anim-item` children. */
export function useStaggerList<T extends HTMLElement>(
  deps?: unknown[],
  opts?: { scroll?: boolean; stagger?: number; duration?: number },
) {
  const ref = useRef<T>(null);
  const { scroll = true, stagger = 0.03, duration = 0.3 } = opts ?? {};

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    let revert: (() => void) | undefined;

    void (scroll ? loadGsapWithScrollTrigger() : loadGsap()).then((gsap) => {
      if (disposed) return;
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.fromTo(el.querySelectorAll(".anim-item"), { opacity: 0, y: 8 }, {
          opacity: 1, y: 0, duration, stagger, ease: "power1.out",
          ...(scroll ? { scrollTrigger: { trigger: el, start: "top 92%", toggleActions: "play none none reverse" } } : {}),
        });
      });
      revert = () => mm.revert();
    });

    return () => {
      disposed = true;
      revert?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps ?? []);

  return ref;
}

/** Animate a number from `from` to `to`, preserving reduced-motion behavior. */
export function useCountUp(to: number, opts?: { from?: number; duration?: number; enabled?: boolean }) {
  const { from = 0, duration = 0.8, enabled = true } = opts ?? {};
  const [display, setDisplay] = useState(from);
  const objRef = useRef({ val: from });
  const tweenRef = useRef<Killable | null>(null);

  useEffect(() => {
    tweenRef.current?.kill();
    if (!enabled) return;
    let disposed = false;
    let revert: (() => void) | undefined;

    void loadGsap().then((gsap) => {
      if (disposed) return;
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
      mm.add("(prefers-reduced-motion: reduce)", () => setDisplay(to));
      revert = () => mm.revert();
    });

    return () => {
      disposed = true;
      revert?.();
      tweenRef.current?.kill();
    };
  }, [enabled, from, to, duration]);

  return display;
}

/** Animate height and opacity for accordion expand/collapse. */
export function useExpandCollapse<T extends HTMLElement>(expanded: boolean) {
  const ref = useRef<T>(null);
  const tweenRef = useRef<Killable | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    tweenRef.current?.kill();
    let disposed = false;
    let revert: (() => void) | undefined;

    void loadGsap().then((gsap) => {
      if (disposed) return;
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        if (expanded) {
          tweenRef.current = gsap.fromTo(el, { height: 0, opacity: 0 }, { height: "auto", opacity: 1, duration: 0.2, ease: "power2.out" });
        } else {
          tweenRef.current = gsap.to(el, { height: 0, opacity: 0, duration: 0.15, ease: "power2.in" });
        }
      });
      mm.add("(prefers-reduced-motion: reduce)", () => {
        gsap.set(el, { height: expanded ? "auto" : 0, opacity: expanded ? 1 : 0 });
      });
      revert = () => mm.revert();
    });

    return () => {
      disposed = true;
      revert?.();
      tweenRef.current?.kill();
    };
  }, [expanded]);

  return ref;
}
