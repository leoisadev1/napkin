import { streamText } from 'ai';
import { BoardOp } from '../shared/board';
import type { AgentEvent, AgentRequest } from '../shared/agent-protocol';
import { selectProvider } from './llm';
import { log } from './config';
import { DrawingStream } from './dsl';

export const systemPrompt = `Draw on a shared whiteboard by streaming ONLY this line DSL, no markdown, prose, JSON or tool calls. One command per line. Strings are double-quoted JSON strings. IDs are stable lowercase kebab-case, max 48 chars. Reuse IDs from Board; don't duplicate existing concepts.
Grammar (placement is optional, defaults auto):
frame ID [in:FRAME|near:ID:right|left|above|below] "Title"
box|ellipse|diamond|sticky|text ID COLOR [PLACEMENT] "Label"
edge ID FROM->TO "Label"
phone|desktop ID [PLACEMENT] "Title" | header:Title | list:Habits | button:Check in | tabbar:Today,Feed
Mockup component kinds: header text button input image card list tabbar toggle avatar chart. Every phone/desktop line MUST include 4-8 meaningful components derived from the conversation: header, list rows, buttons, tabbar, chart, etc. Never output a header-only mockup. Labels <=80 chars. When later phrases describe an existing screen, re-emit its phone/desktop line with the SAME id and the full enriched component list, preserving prior components. Re-adding a mockup id replaces it in place; update only changes its title/color, not its components.
update ID [color:COLOR] ["New label"]
move ID PLACEMENT
del ID [ID ...]
title "Board title"
clear
image ID "Generation prompt" "Caption" [PLACEMENT]
suggest: concrete next thing | another next thing | third thing
Colors: gray blue green yellow orange red purple pink teal. Shape labels <=200 chars; edge labels <=60; titles/captions <=80.
A frame MUST be immediately followed by a child using in:FRAME in this response. Never emit empty frames. Reuse an existing frame for the SAME area. Create separate frames for distinct areas such as "Core loop", "Engagement", and "Main screen" instead of collecting every concept in one frame. A screen/mockup is a distinct area: put it in a dedicated frame named for the screen, never in the core-loop frame. When the new phrase introduces engagement/social features, create their own frame even in live mode. For a new empty board, FIRST emit a frame then a box child, for example:
frame core "Habit tracker"
box habits blue in:core "Habit tracker"
Adapt the example to the subject. In live mode prefer boxes; add a phone/desktop only when the new phrase asks for a screen or mockup. Images only when requested; they are slow. Only clear/delete when requested. Suggestions: at most 3 concrete additions, <=40 characters each, at the end. Never speak or acknowledge.`;
const suggestPrompt = `Return ONLY one line: suggest: first addition | second addition | optional third addition
Give 2-3 concrete next additions grounded in the user's speaking stretch, history, and board. Each item is <=40 characters, phrased as a short imperative or question, such as "Add onboarding flow" or "Where do reminders get sent?". Do not repeat what's on the board. No drawing commands, prose, markdown, or acknowledgment.`;
export function validateOperation(value: unknown): BoardOp | undefined {
  const parsed = BoardOp.safeParse(value);
  if (!parsed.success) { log('invalid_board_op', { issues: parsed.error.issues.length }); return; }
  return parsed.data;
}
export async function runAgent(args: { request: Request; input: AgentRequest; signal: AbortSignal; emit: (event: AgentEvent) => void }) {
  const owned = new AbortController();
  const signal = AbortSignal.any([args.signal, owned.signal]);
  const started = performance.now();
  const provider = await selectProvider(args.request);
  const { input, emit } = args;
  let firstOp = true;
  const emitOp = (op: BoardOp) => {
    if (signal.aborted) return;
    if (firstOp) { log('agent_first_op', { model: provider.modelId, mode: input.mode, ms: Math.round(performance.now() - started) }); firstOp = false; }
    emit({ type: 'op', op });
  };
  const images: Promise<void>[] = [];
  let imageFailed = false;
  const pendingNodes = new Map<string, Promise<boolean>>();
  let barrier: Promise<boolean> | undefined;
  const dependencies = (op: BoardOp) => {
    const ids = 'id' in op ? [op.id] : [];
    if ('placement' in op) {
      if (op.placement.kind === 'inside') ids.push(op.placement.frame);
      if (op.placement.kind === 'near') ids.push(op.placement.target);
    }
    if (op.op === 'add_edge') ids.push(op.from, op.to);
    if (op.op === 'delete') ids.push(...op.ids);
    const waits = op.op === 'clear' || op.op === 'delete' ? [...pendingNodes.values()] : ids.flatMap(id => {
      const pending = pendingNodes.get(id); return pending ? [pending] : [];
    });
    if (barrier) waits.push(barrier);
    return waits;
  };
  const scheduleOp = (op: BoardOp) => {
    const waits = dependencies(op);
    if (!waits.length) { emitOp(op); return; }
    const ready = Promise.all(waits).then(results => {
      if (signal.aborted || (op.op !== 'clear' && op.op !== 'delete' && results.some(result => !result))) return false;
      emitOp(op); return true;
    });
    if ('id' in op) pendingNodes.set(op.id, ready);
    if (op.op === 'delete') op.ids.forEach(id => pendingNodes.set(id, ready));
    if (op.op === 'clear' || op.op === 'delete') barrier = ready;
    images.push(ready.then(() => {}));
  };
  const parser = new DrawingStream(line => {
    if (signal.aborted || (input.mode === 'suggest' && line.kind !== 'suggestions')) return;
    switch (line.kind) {
      case 'op': scheduleOp(line.op); break;
      case 'suggestions': emit({ type: 'suggestions', items: line.items }); break;
      case 'image': {
        const { id, prompt, caption, placement } = line;
        emit({ type: 'pending', id, label: 'Generating image…' });
        const imageOp = { op: 'add_image', id, caption, placement, dataUrl: 'data:image/png;base64,' } satisfies BoardOp;
        const waits = [...dependencies(imageOp), ...(line.frame ? dependencies(line.frame) : [])];
        const ready = (async () => {
          try {
            const dataUrl = await provider.image(prompt, signal);
            const results = await Promise.all(waits);
            if (signal.aborted || results.some(result => !result)) return false;
            if (line.frame) emitOp(line.frame);
            emitOp({ ...imageOp, dataUrl }); return true;
          } catch {
            if (!signal.aborted) { log('image_failed'); imageFailed = true; }
            return false;
          } finally { if (!signal.aborted) emit({ type: 'pending_done', id }); }
        })();
        pendingNodes.set(id, ready);
        if (line.frame) pendingNodes.set(line.frame.id, ready);
        images.push(ready.then(() => {})); break;
      }
      default: { const exhaustive: never = line; void exhaustive; }
    }
  });
  try {
    const result = streamText({ model: provider.model,
      system: input.mode === 'suggest' ? suggestPrompt : systemPrompt + (input.mode === 'live'
        ? '\nLIVE: Draw ONLY what the NEW phrase adds, typically 1-4 lines, zero if nothing new. Earlier phrases are context only. Do not anticipate features. Prefer ONE box per new concept, short labels, and no edges unless the phrase describes a relationship. Keep output minimal, except mockups need 4-8 components. Enrich an existing screen when this phrase describes it, reusing its id. No suggestions in live mode; a separate pause pass handles them.'
        : '\nTURN: Draw a fuller useful set if needed. End with short concrete next-step suggestions.'),
      messages: [...input.history.map(turn => ({ role: turn.role, content: turn.text })), { role: 'user', content: `Board: ${JSON.stringify(input.board)}\nNEW phrase: ${input.utterance}` }],
      abortSignal: signal, maxRetries: 0, maxOutputTokens: input.mode === 'suggest' ? 60 : input.mode === 'live' ? 360 : 1600,
      providerOptions: { openai: { reasoningEffort: 'low' } },
      onError: ({ error }) => log('llm_stream_failed', { kind: error instanceof Error ? error.name : 'unknown' }),
    });
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') parser.push(part.text);
      else if (part.type === 'error') throw part.error;
    }
    signal.throwIfAborted();
    parser.finish();
    await Promise.all(images);
    if (imageFailed && !signal.aborted) emit({ type: 'error', message: 'Image generation failed. Please try again.' });
    log('agent_complete', { model: provider.modelId, mode: input.mode, ms: Math.round(performance.now() - started) });
  } finally { owned.abort(); await Promise.allSettled(images); }
}
