import type { gsap as Gsap } from "gsap";

let gsapPromise: Promise<typeof Gsap> | undefined;
let scrollTriggerPromise: Promise<typeof Gsap> | undefined;

export function loadGsap(): Promise<typeof Gsap> {
  gsapPromise ??= import("gsap").then(({ default: gsap }) => gsap);
  return gsapPromise;
}

export function loadGsapWithScrollTrigger(): Promise<typeof Gsap> {
  scrollTriggerPromise ??= Promise.all([loadGsap(), import("gsap/ScrollTrigger")]).then(
    ([gsap, { ScrollTrigger }]) => {
      gsap.registerPlugin(ScrollTrigger);
      return gsap;
    },
  );
  return scrollTriggerPromise;
}
