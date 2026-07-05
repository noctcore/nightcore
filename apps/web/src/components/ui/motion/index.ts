/**
 * The shared motion layer's public surface, folded into the `ui/` barrel. This is
 * the ONLY home for motion in the app: `lib/**` is lint-banned from importing it
 * (framework-neutral leaf), and features compose their choreography from these
 * generic primitives instead of importing `motion/react` ad hoc.
 */
export { MotionProvider } from './MotionProvider';
export { DURATION, EASE } from './tokens';
export { backdrop, fadeRise, popover, scaleFade, slideIn, stagger } from './variants';

// The motion/react runtime, funnelled through the ui barrel. `m` is the strict lazy
// component proxy (never the heavy `motion`); `AnimatePresence` drives enter/exit;
// the MotionValue hooks power continuous/ambient motion OFF React's render path (so
// they add zero renders on streaming surfaces).
export type { MotionValue, Transition, Variants } from 'motion/react';
export {
  animate,
  AnimatePresence,
  m,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from 'motion/react';
