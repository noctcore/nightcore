/** Probe inputs + live verdicts for the policy pattern tester. */
import { useMemo, useState } from 'react';

import type { PatternTesterProps } from './PatternTester.types';
import {
  probeCommand,
  probeRead,
  probeTool,
  type ProbeVerdict,
  probeWrite,
} from './PatternTester.utils';

/** Everything the PatternTester shell renders. */
export interface PatternTesterVM {
  /** The repo-relative path probe (feeds BOTH the write and read verdicts). */
  path: string;
  setPath: (value: string) => void;
  writeVerdict: ProbeVerdict;
  readVerdict: ProbeVerdict;
  /** The Bash command-line probe. */
  command: string;
  setCommand: (value: string) => void;
  commandVerdict: ProbeVerdict;
  /** The SDK tool-name probe. */
  tool: string;
  setTool: (value: string) => void;
  toolVerdict: ProbeVerdict;
  /** True once at least one probe has input — the card stays quiet until then. */
  probed: boolean;
}

/** Own the three probe inputs and recompute their verdicts against the CURRENT
 *  draft on every keystroke. Every verdict comes from the shared contracts
 *  matchers, so editing a rule above immediately re-answers the question below. */
export function usePatternTester({ lists }: PatternTesterProps): PatternTesterVM {
  const [path, setPath] = useState('');
  const [command, setCommand] = useState('');
  const [tool, setTool] = useState('');

  const writeVerdict = useMemo(() => probeWrite(lists, path), [lists, path]);
  const readVerdict = useMemo(() => probeRead(lists, path), [lists, path]);
  const commandVerdict = useMemo(() => probeCommand(lists, command), [lists, command]);
  const toolVerdict = useMemo(() => probeTool(lists, tool), [lists, tool]);

  return {
    path,
    setPath,
    writeVerdict,
    readVerdict,
    command,
    setCommand,
    commandVerdict,
    tool,
    setTool,
    toolVerdict,
    probed:
      path.trim().length > 0 || command.trim().length > 0 || tool.trim().length > 0,
  };
}
