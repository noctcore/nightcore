import { Column } from '../Column';
import { groupTasksByColumn } from './Board.hooks';
import type { BoardProps } from './Board.types';

export function Board({ tasks, selectedId, onSelect }: BoardProps) {
  return (
    <div className="flex h-full min-h-0 gap-3.5 overflow-x-auto p-4">
      {groupTasksByColumn(tasks).map(({ def, tasks: colTasks }) => (
        <Column
          key={def.key}
          title={def.title}
          tasks={colTasks}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
