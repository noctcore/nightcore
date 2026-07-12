/** A link that opens a repository in a new tab. */
import type { ReactNode } from 'react';

import { GithubIcon } from '../icons';

/** A link that opens the project's repository in a new tab. */
export function RepoLink({ href }: { href: string }): ReactNode {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1.5 text-xs-plus font-semibold text-primary"
    >
      <GithubIcon size={15} />
      Open repo
    </a>
  );
}
