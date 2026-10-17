import type { BoardSummary } from '../../shared/board';
/** Gradium matches single, case-sensitive tokens. Keep board spelling and cap the dictionary. */
export function boardKeywords(board: BoardSummary): string[] {
  const words = [board.title, ...board.items.filter(item => item.kind !== 'edge').map(item => item.label)].join(' ').match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter(word => word.length >= 2))].slice(0, 100);
}
