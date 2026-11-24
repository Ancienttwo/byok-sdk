import { reduceMotion } from "nsh";

/** Shared motion duration/easing/scale utility classes honoring `motion-reduce:`. */
export const MOTION_CLASSES = {
  interactiveColor: "transition-colors duration-100 ease-out motion-reduce:transition-none",
  buttonPress:
    "transition-all duration-150 ease-out active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100",
  iconButtonPress:
    "transition-all duration-150 ease-out active:scale-[0.95] motion-reduce:transition-none motion-reduce:active:scale-100",
  switchThumb:
    "transition-transform duration-200 ease-in-out motion-reduce:transition-none",
  popupTransition:
    "transition-all duration-150 ease-out motion-reduce:transition-none",
  popupStarting: "opacity-0 scale-95",
  popupEnding: "opacity-0 scale-95",
} as const;

export function dialogAnimation(): "slide" | "none" {
  return reduceMotion() ? "none" : "slide";
}
