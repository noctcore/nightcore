/** Prop types for the SessionComposer. The `send-input` relay handler
 *  (`onSendInput`) comes from `TaskActionsContext` (`../actions`), not props. */
export interface SessionComposerProps {
  /** The running task whose LIVE session this composer streams input into (the
   *  broadcast origin). */
  taskId: string;
  /** Every LIVE session id (task id) on the board — the broadcast fan-out set. With
   *  two or more the composer offers a broadcast toggle; with one it sends to
   *  `taskId` alone. */
  liveSessionIds: readonly string[];
}
