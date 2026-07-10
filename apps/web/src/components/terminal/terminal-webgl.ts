/**
 * The xterm WebGL/GPU renderer seam (build spec PR C, decision 7).
 *
 * The DOM renderer is the default; when the Settings GPU toggle is on, a session
 * loads `@xterm/addon-webgl` AFTER its terminal is `open()`ed (the addon needs a
 * live canvas). The addon's `onContextLoss` fires when the browser drops the WebGL
 * context (GPU reset, the xtermjs#5816 corruption path, a backgrounded tab) — we
 * dispose the addon, which reverts xterm to its DOM renderer, and surface a toast
 * so the user knows rendering degraded (never a blank pane).
 *
 * The actual `import('@xterm/addon-webgl')` is DYNAMIC and only runs inside
 * {@link defaultWebglLoader}, so the WebGL bundle never enters a consumer's static
 * graph (same discipline as the terminal bridge's dynamic Tauri-core import). The
 * loader is injectable via {@link setWebglLoader} so component tests can drive the
 * fallback path (mock a context loss) WITHOUT a real GPU — headless chromium has no
 * reliable WebGL context.
 */
import type { Terminal } from '@xterm/xterm';

/** A loaded WebGL renderer's teardown handle. `dispose` removes the addon (reverting
 *  xterm to DOM) and drops the context-loss subscription. */
export interface WebglController {
  dispose: () => void;
}

/** Loads the WebGL addon onto `term`, wiring `onContextLoss` to `onContextLoss`.
 *  Resolves to a controller, or `null` when WebGL is unavailable (import fails / no
 *  GPU context) so the caller silently stays on DOM. */
export type WebglLoader = (
  term: Terminal,
  onContextLoss: () => void,
) => Promise<WebglController | null>;

/** The production loader: dynamically imports the addon, attaches it, and returns a
 *  controller. Any failure (unsupported context, import error) resolves to `null`,
 *  keeping the session on the DOM renderer. */
const defaultWebglLoader: WebglLoader = async (term, onContextLoss) => {
  try {
    const { WebglAddon } = await import('@xterm/addon-webgl');
    const addon = new WebglAddon();
    const lossSub = addon.onContextLoss(() => onContextLoss());
    term.loadAddon(addon);
    return {
      dispose: () => {
        lossSub.dispose();
        addon.dispose();
      },
    };
  } catch {
    // A device without a usable WebGL context (or a failed chunk load) falls back
    // to DOM silently — the terminal still renders, just without GPU acceleration.
    return null;
  }
};

let activeLoader: WebglLoader = defaultWebglLoader;

/** Override the WebGL loader (tests inject a fake that triggers `onContextLoss` on
 *  demand). Pass `null` to restore the production dynamic-import loader. */
export function setWebglLoader(loader: WebglLoader | null): void {
  activeLoader = loader ?? defaultWebglLoader;
}

/** Load the WebGL renderer onto `term` via the active loader. */
export function loadWebgl(
  term: Terminal,
  onContextLoss: () => void,
): Promise<WebglController | null> {
  return activeLoader(term, onContextLoss);
}
