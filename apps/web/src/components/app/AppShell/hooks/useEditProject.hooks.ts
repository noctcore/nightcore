import { useCallback, useState } from 'react';

import type { EditProjectSaveArgs } from '@/components/ui/EditProjectDialog/EditProjectDialog.types';
import type { ToastApi } from '@/components/ui/Toast/Toast.types';
import type { Project } from '@/lib/bridge';
import {
  clearProjectIcon,
  saveProjectIcon,
  setProjectIcon,
  updateProject,
} from '@/lib/bridge';
import { invalidateProjectIconCache } from '@/lib/useProjectIconUrl';

/** Edit-project dialog state + save handler (name / preset / custom icon). */
export function useEditProject(toast: ToastApi) {
  const [editTarget, setEditTarget] = useState<Project | null>(null);

  const openEdit = useCallback((project: Project) => setEditTarget(project), []);
  const closeEdit = useCallback(() => setEditTarget(null), []);

  const saveEdit = useCallback(
    async (args: EditProjectSaveArgs) => {
      const original = editTarget;
      if (original === null || original.id !== args.projectId) {
        throw new Error('No project selected');
      }
      try {
        if (args.clearCustom && args.customImage === null) {
          await clearProjectIcon(args.projectId);
        }
        if (args.customImage !== null) {
          await saveProjectIcon(args.projectId, {
            format: args.customImage.format as 'png' | 'jpeg' | 'webp' | 'gif',
            data: args.customImage.data,
            filename: args.customImage.filename,
          });
        } else if (
          args.icon !== null &&
          (args.icon !== original.icon || original.customIconPath !== null)
        ) {
          await setProjectIcon(args.projectId, args.icon);
        }
        if (args.name !== original.name) {
          await updateProject(args.projectId, { name: args.name });
        }
        invalidateProjectIconCache(args.projectId);
      } catch (err) {
        console.error('edit project failed', err);
        toast.error('Could not save project', err);
        throw err;
      }
    },
    [editTarget, toast],
  );

  return {
    editOpen: editTarget !== null,
    editTarget,
    openEdit,
    closeEdit,
    saveEdit,
  };
}
