import { useId } from 'react';

const WINDOWS_DEVICE_PREFIX = '\\\\?\\';
const WINDOWS_UNC_PREFIX = '\\\\?\\UNC\\';

/** Remove Windows device-namespace syntax for presentation only. */
export function friendlyProjectPath(path: string): string {
  if (path.toUpperCase().startsWith(WINDOWS_UNC_PREFIX.toUpperCase())) {
    return `\\\\${path.slice(WINDOWS_UNC_PREFIX.length)}`;
  }
  if (path.startsWith(WINDOWS_DEVICE_PREFIX)) {
    return path.slice(WINDOWS_DEVICE_PREFIX.length);
  }
  return path;
}

/** Keep enough context to distinguish repositories with the same folder name. */
export function compactProjectPath(path: string): string {
  const friendly = friendlyProjectPath(path);
  if (friendly === '/' || /^[A-Za-z]:[\\/]?$/.test(friendly)) return friendly;

  const separator = friendly.includes('\\') ? '\\' : '/';
  const trimmed = friendly.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]+/).filter(Boolean);

  if (segments.length === 0) return friendly;
  return segments.slice(-2).join(separator);
}

export function useProjectPathLabel(path: string) {
  return {
    compactPath: compactProjectPath(path),
    friendlyPath: friendlyProjectPath(path),
    tooltipId: useId(),
  };
}
