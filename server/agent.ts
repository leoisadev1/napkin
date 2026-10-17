import { streamText } from 'ai';
import { BoardOp } from '../shared/board';
import type { AgentEvent, AgentRequest } from '../shared/agent-protocol';
import { selectProvider } from './llm';
import { config, log } from './config';
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
A frame MUST be immediately followed by a child using in:FRAME in this response. Never emit empty frames. Reuse an existing frame for the SAME area. Create separate frames for distinct areas such as "Core loop", "Engagement", and "Main screen" instead of collecting every concept in one frame. A screen/mockup is a distinct area: put it in a dedicated frame named for the screen, never in the core-loop frame. When the new phrase introduces engagement/social features, create their own frame even in live mode. For a new empty board, group related content in a frame. Example:
frame core "Habit tracker"
box habits blue in:core "Habit tracker"
Adapt the example to the subject. Use diagram syntax for relationships in every drawing mode: diagram ID KIND [PLACEMENT] "Title" | id:Label:COLOR[:box|ellipse|diamond|sticky][>PARENT or ^PARENT] | id:Label:COLOR | links: a->b "label"; b->c "label" | axes: Effort | Impact. Require 2-14 nodes; links and axes optional. Loops/economies use cycle; processes/user flows/decisions use flow with diamonds; hierarchies/features use tree; brainstorming around one idea uses mindmap; plans/roadmaps use timeline; conversion/acquisition uses funnel; prioritization uses quadrant (four nodes, two axes). Plain shapes/stickies are for loose ideas. Phone/desktop mockups are for screens. Re-emit a diagram using its same id to enrich it.
Transcripts may contain mis-hearings: infer intended words from the whole stretch and FIX earlier labels with update when later words clarify them (Cast Simulator -> Cat Simulator when cat is mentioned). If NEW words are an incomplete fragment, draw nothing; the next request carries them. Never draw a box labelled only Cat from a trailing fragment.
In live mode use diagrams already when a loop/flow/plan is described; add a phone/desktop only when the new phrase asks for a screen or mockup. Images only when requested or in refine for a creative visual topic with no existing image; they are slow. Only clear/delete when requested, except refine may replace loose live shapes with a useful diagram. Suggestions: at most 3 concrete additions, <=40 characters each, at the end. Never speak or acknowledge.`;
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
  const provider = await selectProvider(args.request, args.input.mode === 'refine' ? config().DEV_LLM_REFINE_REASONING_EFFORT : 'none');
  const { input, emit } = args;
  let firstOp = true;
  const emitOp = (op: BoardOp) => {
    if (signal.aborted) return;
    if (firstOp) { log('agent_first_op', { model: provider.modelId, mode: input.mode, ms: Math.round(performance.now() - started) }); firstOp = false; }
    emit({ type: 'op', op });
  };
  const images: Promise<void>[] = [];
  const imageRequested = /\b(image|picture|photo|illustration|concept art)\b/i.test(input.utterance);
  let imageInResponse = false;
  let imageStarted = input.board.items.some(item => item.kind === 'image') || input.history.some(turn => turn.text === 'Concept image already attempted for this board. Do not generate another unless explicitly asked.');
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
        if (imageInResponse || (imageStarted && !imageRequested)) break;
        imageInResponse = true; imageStarted = true;
        const { id, prompt, caption, placement } = line;
        emit({ type: 'pending', id, label: 'Generating image…' });
        const imageOp = { op: 'add_image', id, caption, placement, dataUrl: 'data:image/png;base64,' } satisfies BoardOp;
        const waits = [...dependencies(imageOp), ...(line.frame ? dependencies(line.frame) : [])];
        const ready = (async () => {
          try {
            // Optional art must never discard an otherwise complete refinement at its deadline.
            const imageSignal = input.mode === 'refine' ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(7000 - (performance.now() - started))))]) : signal;
            const dataUrl = await provider.image(prompt, imageSignal);
            const results = await Promise.all(waits);
            if (signal.aborted || results.some(result => !result)) return false;
            if (line.frame) emitOp(line.frame);
            emitOp({ ...imageOp, dataUrl }); return true;
          } catch {
            if (!signal.aborted) { log('image_failed'); imageFailed = input.mode !== 'refine'; }
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
        ? '\nLIVE: Draw ONLY what the NEW phrase adds, typically 1-4 lines, zero if nothing new. Earlier phrases are context only. Do not anticipate features. Prefer one meaningful diagram for a loop/flow/plan, otherwise one shape per new concept, short labels, and no edges unless the phrase describes a relationship. Keep output minimal, except mockups need 4-8 components. Enrich an existing screen when this phrase describes it, reusing its id. No suggestions in live mode; a separate pause pass handles them.'
        : input.mode === 'refine' ? '\nREFINE: Restructure the live sketch into useful diagrams. Replace loose redundant shapes with del and diagram, reusing node ids so edges survive. Correct misheard labels using the full speaking stretch. Fill obvious missing pieces. Set title if untitled. At most one concept image for a creative/visual game, brand, or product look, only if no image exists. Preserve unrelated board content. No suggestions (a parallel request handles chips). Keep to one main diagram, at most 8 nodes, and at most 10 lines.' : '\nTURN: Draw a fuller useful set if needed. End with short concrete next-step suggestions.'),
      messages: [...input.history.map(turn => ({ role: turn.role, content: turn.text })), { role: 'user', content: `Board: ${JSON.stringify(input.board)}\nNEW phrase: ${input.utterance}` }],
      abortSignal: signal, maxRetries: 0, maxOutputTokens: input.mode === 'suggest' ? 60 : input.mode === 'live' ? 550 : input.mode === 'refine' ? 1200 : 1600,
      providerOptions: { openai: { reasoningEffort: input.mode === 'refine' ? config().DEV_LLM_REFINE_REASONING_EFFORT : 'none' } },
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
