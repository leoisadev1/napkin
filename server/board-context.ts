import type { BoardItem, BoardSummary } from '../shared/board';

/** Bound prompt growth while retaining pointed/selected, named, related and visible items. */
export function boardContext(board: BoardSummary, utterance: string) {
  const focus = new Set([...board.selection, ...(board.pointer?.over ? [board.pointer.over] : [])]);
  const words = new Set(utterance.toLowerCase().match(/[\p{L}\p{N}-]{3,}/gu) ?? []);
  const visible = (item: BoardItem) => item.bounds.x + item.bounds.w >= board.viewport.x && item.bounds.y + item.bounds.h >= board.viewport.y
    && item.bounds.x <= board.viewport.x + board.viewport.w && item.bounds.y <= board.viewport.y + board.viewport.h;
  const score = (item: BoardItem) => (focus.has(item.id) ? 10000 : 0)
    + (item.label.toLowerCase().split(/\W+/).some(word => words.has(word)) || utterance.includes(item.id) ? 1000 : 0)
    + (item.frame && focus.has(item.frame) ? 100 : 0) + (visible(item) ? 10 : 0);
  const ranked = board.items.map((item, index) => ({ item, index, score: score(item) })).sort((a, b) => b.score - a.score || b.index - a.index);
  const kept = new Set((board.items.length <= 70 ? ranked : ranked.slice(0, 55)).map(row => row.item.id));
  // Include referenced frames and edge endpoints where possible.
  for (const { item } of ranked) if (kept.has(item.id)) {
    if (item.frame) kept.add(item.frame);
    if (item.link) for (const id of item.link.split(/\s*->\s*/)) kept.add(id);
  }
  const items = ranked.filter(({ item }) => kept.has(item.id)).slice(0, 90).sort((a, b) => a.index - b.index).map(({ item }) => item);
  const rect = ({ x, y, w, h }: BoardSummary['viewport']) => `${Math.round(x)},${Math.round(y)} ${Math.round(w)}x${Math.round(h)}`;
  return [`Board ${JSON.stringify(board.title)}; ${board.items.length} total; ${board.items.length - items.length} omitted.`,
    `Selection: ${board.selection.join(',') || 'none'}; pointer: ${board.pointer ? `${Math.round(board.pointer.x)},${Math.round(board.pointer.y)} over:${board.pointer.over ?? 'none'}` : 'none'}; viewport: ${rect(board.viewport)}`,
    'Items: id kind origin "label" @x,y wxh frame link',
    ...items.map(item => `${item.id} ${item.kind} ${item.origin} ${JSON.stringify(item.label)} @${rect(item.bounds)} ${item.frame ?? '-'}${item.link ? ` ${item.link}` : ''}`),
  ].join('\n');
}
