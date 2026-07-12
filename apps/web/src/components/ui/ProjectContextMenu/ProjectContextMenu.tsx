import { EditIcon, TrashIcon } from '../icons/icons';
import { useProjectContextMenu } from './ProjectContextMenu.hooks';
import type { ProjectContextMenuProps } from './ProjectContextMenu.types';

/** Right-click menu for project row actions. */
export function ProjectContextMenu({ children, onEdit, onRemove }: ProjectContextMenuProps) {
  const menu = useProjectContextMenu();

  return (
    <div
      className="relative"
      onContextMenu={(e) => {
        e.preventDefault();
        menu.openAt(e.clientX, e.clientY);
      }}
    >
      {children}
      {menu.open && (
        <div
          ref={menu.menuRef}
          role="menu"
          className="fixed z-50 min-w-[180px] rounded-lg border border-border bg-popover py-1 shadow-2xl"
          style={{ left: menu.pos.x, top: menu.pos.y }}
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs-plus hover:bg-white/[0.06]"
            onClick={() => {
              menu.close();
              onEdit();
            }}
          >
            <EditIcon size={14} />
            Edit name &amp; icon
          </button>
          {onRemove !== undefined && (
            <>
              <div className="my-1 h-px bg-border" />
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs-plus text-destructive hover:bg-destructive/10"
                onClick={() => {
                  menu.close();
                  onRemove();
                }}
              >
                <TrashIcon size={14} />
                Remove from Nightcore
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
