import type { BoardOp, BoardSummary, BoardItem } from '../shared/board';
/** Headless consumer used by live benchmarks and integration tests. */
export class BoardState {
  private title = '';
  private items = new Map<string, BoardItem>();
  summary = (): BoardSummary => ({ title: this.title, items: [...this.items.values()], selection: [] });
  apply = (op: BoardOp) => {
    const frame = 'placement' in op && op.placement.kind === 'inside' ? op.placement.frame : null;
    switch (op.op) {
      case 'add_frame': this.items.set(op.id, { id: op.id, kind: 'frame', label: op.title, frame, link: '' }); break;
      case 'add_shape': this.items.set(op.id, { id: op.id, kind: 'shape', label: op.label, frame, link: '' }); break;
      case 'add_mockup': this.items.set(op.id, { id: op.id, kind: 'mockup', label: op.title, frame, link: '' }); break;
      case 'add_image': this.items.set(op.id, { id: op.id, kind: 'image', label: op.caption, frame, link: '' }); break;
      case 'add_edge': this.items.set(op.id, { id: op.id, kind: 'edge', label: op.label, frame: null, link: `${op.from} -> ${op.to}` }); break;
      case 'update': { const item = this.items.get(op.id); if (item && op.label !== undefined) item.label = op.label; break; }
      case 'move': { const item = this.items.get(op.id); if (item) item.frame = frame; break; }
      case 'delete': op.ids.forEach(id => this.items.delete(id)); break;
      case 'clear': this.items.clear(); this.title = ''; break;
      case 'set_title': this.title = op.title; break;
      default: { const exhaustive: never = op; void exhaustive; }
    }
  };
}
