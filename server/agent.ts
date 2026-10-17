import { streamText } from 'ai';
import { BoardOp } from '../shared/board';
import type { AgentEvent, AgentRequest } from '../shared/agent-protocol';
import { selectProvider } from './llm';
import { config, log } from './config';
import { boardContext } from './board-context';
import { answerGuard } from './answers';
import { conciseOperation } from './concision';
import { DrawingStream } from './dsl';

export const systemPrompt = `Draw on a shared whiteboard by streaming ONLY this line DSL. No markdown, prose, JSON, tools, speech or acknowledgment. One command per line. Double-quoted strings use JSON escaping. Stable lowercase kebab-case IDs, max 48 chars; reuse Board IDs, never duplicate concepts.
Grammar (optional PLACEMENT defaults auto):
frame ID [PLACEMENT] "Title"
box|ellipse|diamond|sticky|text ID COLOR [PLACEMENT] "Label"
edge ID FROM->TO "Label"
phone|desktop ID [PLACEMENT] "Title" | header:Title | input:Email | button:Continue | tabbar:Home,Profile
update ID [color:COLOR] ["New label"]
move ID PLACEMENT
del ID [ID ...]
title "Board title"
clear
image ID "Generation prompt" "Caption" [PLACEMENT]
suggest: next addition | another addition | optional third
PLACEMENT = here (at_pointer), at:ID (reuse replaced item's exact spot), near:ID:right|left|above|below, in:FRAME, auto.
Colors: gray blue green yellow orange red purple pink teal. Hard word limits: shape/node labels <=6 words, diagram/frame titles <=6 words, Pick sticky <=14 words, edge labels <=3 words. Use option names ("Comeback-first tracking"), never explanatory sentences. Put detail only when explicitly requested. Captions <=80 chars.
Resolve "here/this/that/this thing" to selection first, then pointer.over, then pointer coordinates. To edit a pointed item use its existing ID. "Label this as the payment service and connect it to checkout" = update pointed/selected sketch ID + edge from that ID to checkout, never a duplicate box. "Put a login screen here" = phone/desktop with here directly, no enclosing frame. Place related new items beside the discussed item with near:ID:direction or here near the pointer, prefer visible viewport; avoid scattering with auto.
User-origin sketches are addressable items. On request, label/recolor with update, connect with edge, move or del. Never modify user items unprompted, except refine may label an obvious unlabelled user box clearly named in speech. For explicit "clean up my sketch"/"turn this into a flowchart", del it first, then add shape/diagram with at:OLD-ID using its pre-delete spot.
Frames: group related content on an empty board. A new frame MUST be immediately followed by a child using in:FRAME; never empty. Reuse frames for the SAME area; separate Core loop, Engagement/social, and each screen into distinct dedicated frames even live. Example:
frame core "Habit tracker"
box habits blue in:core "Habit tracker"
Screens: When adding an unplaced screen on a board with named areas, first emit its own dedicated frame immediately followed by phone/desktop in:THAT-FRAME. A screen is its own area; never reuse Core loop or Engagement frames for it. Only explicitly positioned here/near/at screens omit that enclosing frame. phone/desktop MUST have 4-8 meaningful components grounded in conversation. Kinds: header text button input image card list tabbar toggle avatar chart. Never header-only. On enrichment re-emit SAME mockup ID and full enriched list preserving prior components. Re-adding replaces in place; update changes title/color only.
Diagrams: diagram ID KIND [PLACEMENT] "Title" | id:Label:COLOR[:box|ellipse|diamond|sticky][>PARENT] | id:Label:COLOR | links: a->b "label"; b->c "label" | axes: Effort | Impact
Require 2-14 nodes, optional links/axes. Use cycle for loops/economies; flow for processes/decisions (diamond); tree for hierarchies; mindmap for brainstorming; timeline for roadmaps; funnel for conversion; quadrant for prioritization (4 nodes,2 axes). Use diagrams for relationships in ALL modes, shapes for loose ideas, mockups for screens. Enrich diagrams with SAME ID.
Infer and fix misheard labels from the whole speaking stretch, e.g. Cast Simulator -> Cat Simulator when cats clarify it. If NEW words are an incomplete fragment, draw nothing; next request carries them. Never make a box labelled only Cat. Draw ONLY what NEW words add; history is context. Don't duplicate concepts being drawn by a parallel request.
QUESTIONS: Answer only COMPLETE questions: an interrogative must end in ?; a clear complete imperative request also qualifies. The specific topic must be known from the whole stretch or board. Obey Question ownership instructions: only the request whose NEW words complete a question may answer it. Other parallel requests MUST NOT answer it. Never answer a fragment or offer a generic framework without its topic. Answer with one specific options diagram plus one green sticky "Pick: <option> — <short reason>". At most one answer diagram and one Pick per question. Enrich or replace the SAME diagram ID in refine; delete superseded generic answers, duplicate diagrams and extra Pick stickies using del. Place answer near:TOPIC-ID:right and Pick near:DIAGRAM-ID:below. Topic belongs in the title/frame; never create a meta sticky restating the user's request (e.g. "Habit tracking app — explore a distinctive angle"). Filler draws nothing.
Images only when explicitly requested or refine for a creative visual topic without an image. Only clear/delete when asked, except refine may replace redundant agent-origin loose shapes with useful diagrams. Suggestions <=3 concrete next additions, <=40 characters each.
`;
const suggestPrompt = `Return ONLY one line: suggest: first addition | second addition | optional third addition
Give 2-3 concrete next additions grounded in the user's speaking stretch, history, and board. Each item is <=40 characters, phrased as a short imperative or question, such as "Add onboarding flow" or "Where do reminders get sent?". Do not repeat what's on the board. No drawing commands, prose, markdown, or acknowledgment.`;
export function validateOperation(value: unknown): BoardOp | undefined {
  const parsed = BoardOp.safeParse(value);
  if (!parsed.success) { log('invalid_board_op', { issues: parsed.error.issues.length }); return; }
  return conciseOperation(parsed.data);
}
export async function runAgent(args: { request: Request; input: AgentRequest; signal: AbortSignal; emit: (event: AgentEvent) => void }) {
  const owned = new AbortController();
  const signal = AbortSignal.any([args.signal, owned.signal]);
  const started = performance.now();
  const provider = await selectProvider(args.request, args.input.mode === 'refine' ? config().DEV_LLM_REFINE_REASONING_EFFORT : 'none');
  const { input, emit } = args;
  const answers = answerGuard(input);
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
      if (op.placement.kind === 'near' || op.placement.kind === 'at') ids.push(op.placement.target);
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
      case 'op': { const op = answers.operation(line.op); if (op) scheduleOp(op); break; }
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
        ? '\nLIVE: Draw ONLY what the NEW phrase adds, typically 1-4 lines, zero if nothing new. Earlier phrases are context only. Do not anticipate features. Prefer one meaningful diagram for a loop/flow/plan, otherwise one shape per new concept, short labels, and no edges unless the phrase describes a relationship. Keep output minimal, except mockups need 4-8 components and owned complete questions/requests get one on-board answer (up to 12 lines). Enrich an existing screen when this phrase describes it, reusing its id. No suggestions in live mode; a separate pause pass handles them.'
        : input.mode === 'refine' ? '\nREFINE: Restructure the live sketch into useful diagrams. Replace loose redundant shapes with del and diagram, reusing node ids so edges survive. Correct misheard labels using the full speaking stretch. Fill obvious missing pieces. Enrich the existing answer with its SAME diagram ID and SAME Pick ID. If none exists and a complete question has a known topic, supply one answer. Never add a second answer. Set title if untitled. At most one concept image for a creative/visual game, brand, or product look, only if no image exists. Preserve unrelated board content. No suggestions (a parallel request handles chips). Keep to one main diagram, at most 8 nodes, and at most 10 lines.' : '\nTURN: Draw a fuller useful set if needed. End with short concrete next-step suggestions.') + answers.instructions,
      messages: [...input.history.map(turn => ({ role: turn.role, content: turn.text })), { role: 'user', content: `${boardContext(input.board, input.utterance)}\nNEW phrase: ${input.utterance}` }],
      abortSignal: signal, maxRetries: 0, maxOutputTokens: input.mode === 'suggest' ? 60 : input.mode === 'live' ? 420 : input.mode === 'refine' ? 1200 : 1600,
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
    for (const op of answers.cleanup()) emitOp(op);
    if (imageFailed && !signal.aborted) emit({ type: 'error', message: 'Image generation failed. Please try again.' });
    log('agent_complete', { model: provider.modelId, mode: input.mode, ms: Math.round(performance.now() - started) });
  } finally { owned.abort(); await Promise.allSettled(images); }
}
