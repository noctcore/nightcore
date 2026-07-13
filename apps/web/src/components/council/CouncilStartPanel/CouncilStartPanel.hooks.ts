/** Local draft state for the {@link import('./CouncilStartPanel').CouncilStartPanel}
 *  form — the objective the council debates. The preset is fixed (`research`) in P1, so
 *  the only input is the objective. */
import { useState } from 'react';

export interface CouncilStartPanelModel {
  objective: string;
  setObjective: (value: string) => void;
  /** True once the objective has non-whitespace content — gates the Start button. */
  canStart: boolean;
}

export function useCouncilStartPanel(): CouncilStartPanelModel {
  const [objective, setObjective] = useState('');
  return { objective, setObjective, canStart: objective.trim().length > 0 };
}
