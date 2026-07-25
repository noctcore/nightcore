export interface SplashProps {
  /** A short boot line under the loader (e.g. "loading projects…"). */
  bootLine?: string;
  /** App version shown at the foot of the splash. Omitted (no line) until the
   *  real `app_info` version resolves, so the splash never flashes a wrong tag. */
  version?: string;
}
