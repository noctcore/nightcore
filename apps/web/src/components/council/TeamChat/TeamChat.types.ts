/** Props for the {@link import('./TeamChat').TeamChat} transcript projection. */
import type { TeamChatEntry } from '../council.types';

export interface TeamChatProps {
  /** The team-chat projection of the bus — every entry, in seq order. */
  chat: TeamChatEntry[];
}
