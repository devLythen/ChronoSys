import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

/** Fade-up reveal when element enters viewport. Swiss-minimal: 12px, 350ms. */
export function useScrollReveal<T extends HTMLElement>(trigger?: boolean) {
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
          opacity: 1,
          y: 0,
          duration: 0.35,
          ease: "power1.out",
          scrollTrigger: {
            trigger: el,
            start: "top 92%",
            toggleActions: "play none none reverse",
          },
        },
      );
    });

    return () => mm.revert();
  }, [trigger]);

  return ref;
}

/** Staggered fade-up for a list container — apply to the parent, children get .anim-item class. */
export function useStaggerList<T extends HTMLElement>(deps?: unknown[]) {
  const ref = useRef<T>(null);

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
          opacity: 1,
          y: 0,
          duration: 0.3,
          stagger: 0.03,
          ease: "power1.out",
          scrollTrigger: {
            trigger: el,
            start: "top 92%",
            toggleActions: "play none none reverse",
          },
        },
      );
    });

    return () => mm.revert();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps ?? []);

  return ref;
}

/** Page entrance: subtle fade-up on mount. */
export function usePageEnter<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(el, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.25, ease: "power1.out" });
    });

    return () => mm.revert();
  }, []);

  return ref;
}
