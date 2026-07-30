import type { StageMeta } from '@/lib/stages';

/** One row of the stage diagram: the stage's own metadata plus its 1-based
 *  lifecycle number and whether it is the last link in the chain (the connector
 *  under the marker is dropped there). */
export interface StageDiagramRow {
  stage: StageMeta;
  number: number;
  last: boolean;
}
