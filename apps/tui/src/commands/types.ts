import type { Config } from '@nightcore/contracts';
import type { SessionManager } from '@nightcore/engine';
import type { ViewAction } from '../session-reducer.js';
import type { SessionView } from '../types.js';

/**
 * The surface-side handle a slash command operates through. A command never
 * touches the engine directly beyond the read-only handles here — it dispatches
 * `ViewAction`s (transcript output, local-default changes) and may open the model
 * picker or quit. Keeps the engine boundary intact: commands are pure surface.
 */
export interface CommandContext {
  /** Current folded view, for commands that report state (`/doctor`). */
  view: SessionView;
  /** Resolved config, for diagnostics + defaults. */
  config: Config;
  /** The engine façade — commands only read from it (`listModels`, `activeCount`). */
  manager: SessionManager;
  /** Fold a surface action into the view (transcript output, default changes). */
  dispatch: (action: ViewAction) => void;
  /** Open the interactive model picker (App owns the overlay + key routing). */
  openModelPicker: () => void;
  /** Tear down the renderer and exit (`/quit`). */
  quit: () => void;
}

/** A registered slash command. `run` may be async (e.g. `/model`, `/doctor`). */
export interface Command {
  name: string;
  summary: string;
  run: (ctx: CommandContext, args: string[]) => void | Promise<void>;
}
