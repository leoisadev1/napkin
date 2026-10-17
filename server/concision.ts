import type { BoardOp } from '../shared/board';
import { log } from './config';

export function concise(text: string, words: number, chars: number): string {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const token of tokens.slice(0, words)) {
    if ([...kept, token].join(' ').length > chars) break;
    kept.push(token);
  }
  const result = kept.join(' ').replace(/[,:;—–-]+$/, '').trimEnd();
  if (result !== text.trim()) log('board_label_truncated', { words: tokens.length, limit: words, chars: text.length });
  return result;
}
export const shapeLabel = (text: string) => concise(text, /^Pick\s*:/i.test(text) ? 14 : 6, 200);
export function conciseOperation(op: BoardOp): BoardOp {
  switch (op.op) {
    case 'add_shape': return { ...op, label: op.shape === 'sticky' ? shapeLabel(op.label) : concise(op.label, 6, 200) };
    case 'update': return { ...op, ...(op.label === undefined ? {} : { label: shapeLabel(op.label) }) };
    case 'add_edge': return { ...op, label: concise(op.label, 3, 60) };
    case 'add_frame': case 'set_title': return { ...op, title: concise(op.title, 6, 80) };
    case 'add_mockup': return { ...op, title: concise(op.title, 6, 80), components: op.components.map(component => ({ ...component, label: concise(component.label, 6, 80) })) };
    case 'add_diagram': return { ...op, title: concise(op.title, 6, 80), nodes: op.nodes.map(node => ({ ...node, label: concise(node.label, 6, 120) })), links: op.links.map(link => ({ ...link, label: concise(link.label, 3, 60) })), axes: op.axes.map(axis => concise(axis, 3, 40)) };
    default: return op;
  }
}
