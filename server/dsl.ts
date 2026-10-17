import { z } from 'zod';
import { BoardOp, NodeId, Placement } from '../shared/board';
import { log } from './config';

const Image = z.object({ kind: z.literal('image'), id: NodeId, prompt: z.string().min(1).max(2000), caption: z.string().max(80), placement: Placement });
export type DrawingLine = { kind: 'op'; op: BoardOp } | (z.infer<typeof Image> & { frame?: Extract<BoardOp, { op: 'add_frame' }> }) | { kind: 'suggestions'; items: string[] };

// Preserve quoted strings and pipe separators so labels can contain literal pipes/colons.
type Token = { kind: 'word' | 'string' | 'pipe'; value: string; start: number; end: number };
function tokens(line: string): Token[] {
  const result: Token[] = [];
  const pattern = /"(?:\\.|[^"\\])*"|\||[^\s"|]+/gy;
  let offset = 0;
  while (offset < line.length) {
    if (/\s/.test(line[offset] ?? '')) { offset++; continue; }
    pattern.lastIndex = offset;
    const match = pattern.exec(line);
    if (!match) throw new Error('Invalid quoted token');
    const token = match[0];
    const position = { start: offset, end: pattern.lastIndex };
    result.push(token.startsWith('"') ? { kind: 'string', value: z.string().parse(JSON.parse(token)), ...position } : { kind: token === '|' ? 'pipe' : 'word', value: token, ...position });
    offset = pattern.lastIndex;
  }
  return result;
}
function word(token: Token | undefined) {
  if (token?.kind !== 'word') throw new Error('Expected word');
  return token.value;
}
function quoted(token: Token | undefined) {
  if (token?.kind !== 'string') throw new Error('Expected quoted string');
  return token.value;
}
function placement(parts: Token[]) {
  if (!parts.length) return { kind: 'auto' };
  if (parts.length !== 1) throw new Error('Invalid placement');
  const token = word(parts[0]);
  if (token === 'here') return { kind: 'at_pointer' };
  if (/^at:[^:]+$/.test(token)) return { kind: 'at', target: token.slice(3) };
  if (token === 'auto') return { kind: 'auto' };
  if (/^in:[^:]+$/.test(token)) return { kind: 'inside', frame: token.slice(3) };
  if (/^near:[^:]+:[^:]+$/.test(token)) {
    const [, target, direction] = token.split(':');
    return { kind: 'near', target, direction };
  }
  throw new Error('Invalid placement');
}
function count(parts: Token[], min: number, max = min) {
  if (parts.length < min || parts.length > max) throw new Error('Unexpected arguments');
}
function groups(parts: Token[]) {
  const result: Token[][] = [[]];
  for (const token of parts) {
    if (token.kind === 'pipe') result.push([]);
    else result.at(-1)?.push(token);
  }
  return result;
}
export function parseDrawingLine(line: string): DrawingLine | undefined {
  if (!line.trim() || line.trim().startsWith('```')) return;
  try {
    const [commandToken, ...parts] = tokens(line.trim());
    const command = word(commandToken);
    let value: unknown;
    switch (command) {
      case 'suggest:': return { kind: 'suggestions', items: groups(parts).map(group => group.map(t => t.value).join(' ').trim()).filter(Boolean).slice(0, 3).map(s => s.slice(0, 40)) };
      case 'box': case 'ellipse': case 'diamond': case 'sticky': case 'text':
        count(parts, 3, 4); value = { op: 'add_shape', id: word(parts[0]), shape: command, color: word(parts[1]), label: quoted(parts.at(-1)), placement: placement(parts.slice(2, -1)) }; break;
      case 'frame': count(parts, 2, 3); value = { op: 'add_frame', id: word(parts[0]), title: quoted(parts.at(-1)), placement: placement(parts.slice(1, -1)) }; break;
      case 'edge': {
        count(parts, 2, 3); const link = word(parts[1]);
        if (!/^[^>]+->[^>]+$/.test(link)) throw new Error('Invalid edge');
        const [from, to] = link.split('->');
        value = { op: 'add_edge', id: word(parts[0]), from, to, label: parts[2] ? quoted(parts[2]) : '' }; break;
      }
      case 'diagram': {
        const [head = [], ...sections] = groups(parts); count(head, 3, 4);
        const nodes: unknown[] = []; const links: unknown[] = []; const axes: string[] = [];
        let section: 'nodes' | 'links' | 'axes' = 'nodes';
        for (const group of sections) {
          let text = line.trim().slice(group[0]?.start ?? 0, group.at(-1)?.end ?? 0);
          if (text.startsWith('links:')) { section = 'links'; text = text.slice(6).trim(); }
          else if (text.startsWith('axes:')) { section = 'axes'; text = text.slice(5).trim(); }
          if (section === 'axes') { if (text) axes.push(text.replace(/^"|"$/g, '')); continue; }
          if (section === 'links') {
            for (const link of (text.match(/(?:"(?:\\.|[^"\\])*"|[^;"])+/g) ?? []).filter(value => value.trim())) {
              const match = /^\s*([a-z0-9-]+)->([a-z0-9-]+)(?:\s+("(?:\\.|[^"\\])*"))?\s*$/.exec(link);
              if (!match) throw new Error('Invalid diagram link');
              links.push({ from: match[1], to: match[2], label: match[3] ? z.string().parse(JSON.parse(match[3])) : '' });
            }
            continue;
          }
          const parentMatch = /[>^]([a-z0-9-]+)$/.exec(text);
          if (parentMatch) text = text.slice(0, parentMatch.index).trim();
          const match = /^([a-z0-9-]+):(.+):(gray|blue|green|yellow|orange|red|purple|pink|teal)(?::(box|ellipse|diamond|sticky))?$/.exec(text);
          if (!match) throw new Error('Invalid diagram node');
          const label = (match[2] ?? '').trim();
          nodes.push({ id: match[1], label: label.startsWith('"') ? z.string().parse(JSON.parse(label)) : label, color: match[3], shape: match[4] ?? 'box', parent: parentMatch?.[1] ?? null });
        }
        value = { op: 'add_diagram', id: word(head[0]), kind: word(head[1]), title: quoted(head.at(-1)), placement: placement(head.slice(2, -1)), nodes, links, axes };
        break;
      }
      case 'phone': case 'desktop': {
        const [head = [], ...components] = groups(parts); count(head, 2, 3);
        value = { op: 'add_mockup', id: word(head[0]), title: quoted(head.at(-1)), device: command, placement: placement(head.slice(1, -1)), components: components.map(group => {
          const first = word(group[0]); const colon = first.indexOf(':');
          if (colon < 1) throw new Error('Missing component kind');
          return { kind: first.slice(0, colon), label: [first.slice(colon + 1), ...group.slice(1).map(t => t.value)].join(' ').trim() };
        }) }; break;
      }
      case 'image': count(parts, 3, 4); return Image.parse({ kind: 'image', id: word(parts[0]), prompt: quoted(parts[1]), caption: quoted(parts[2]), placement: placement(parts.slice(3)) });
      case 'update': {
        count(parts, 2, 3); const id = word(parts[0]); let color: string | undefined; let label: string | undefined;
        for (const token of parts.slice(1)) {
          if (token.kind === 'word' && token.value.startsWith('color:') && color === undefined) color = token.value.slice(6);
          else if (token.kind === 'string' && label === undefined) label = token.value;
          else throw new Error('Invalid update');
        }
        value = { op: 'update', id, color, label }; break;
      }
      case 'move': count(parts, 2); value = { op: 'move', id: word(parts[0]), placement: placement(parts.slice(1)) }; break;
      case 'del': value = { op: 'delete', ids: parts.map(word) }; break;
      case 'title': count(parts, 1); value = { op: 'set_title', title: quoted(parts[0]) }; break;
      case 'clear': count(parts, 0); value = { op: 'clear' }; break;
      default: throw new Error('Unknown command');
    }
    return { kind: 'op', op: BoardOp.parse(value) };
  } catch { log('invalid_drawing_line', { command: line.trim().split(/\s/)[0] ?? '', length: line.length }); return; }
}

// Hold a new frame until its immediate child is validated: an empty frame never reaches the canvas.
export class DrawingStream {
  private buffer = '';
  private frame: Extract<BoardOp, { op: 'add_frame' }> | undefined;
  constructor(private emit: (line: DrawingLine) => void) {}
  push(text: string) {
    this.buffer += text;
    if (this.buffer.length > 32000) throw new Error('Drawing line too long');
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      this.line(this.buffer.slice(0, newline)); this.buffer = this.buffer.slice(newline + 1);
    }
  }
  finish() { if (this.buffer.trim()) this.line(this.buffer); this.buffer = ''; this.frame = undefined; }
  private line(text: string) {
    const line = parseDrawingLine(text);
    if (!line) return;
    if (this.frame) {
      if (line.kind === 'image' && line.placement.kind === 'inside' && line.placement.frame === this.frame.id) {
        this.emit({ ...line, frame: this.frame }); this.frame = undefined; return;
      }
      const child = line.kind === 'op' && 'placement' in line.op && line.op.op !== 'add_frame' && line.op.placement.kind === 'inside' && line.op.placement.frame === this.frame.id;
      if (child) this.emit({ kind: 'op', op: this.frame });
      else log('empty_frame_skipped', { id: this.frame.id });
      this.frame = undefined;
    }
    if (line.kind === 'op' && line.op.op === 'add_frame') this.frame = line.op;
    else this.emit(line);
  }
}
