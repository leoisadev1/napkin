import { streamText, tool, stepCountIs, type ToolSet } from 'ai';
import { z } from 'zod';
import { BoardOp, NodeId, Placement } from '../shared/board';
import type { AgentEvent, AgentRequest } from '../shared/agent-protocol';
import { selectProvider } from './llm';
import { log } from './config';

export const systemPrompt = `You are an energetic, concise brainstorming partner working on a shared whiteboard. Act immediately: call drawing tools first, without preamble or lengthy planning. Build a clean organized visual: set a title, group concepts in frames, add colored shapes and labeled relationship edges. When apps or UI are discussed add a phone or desktop mockup with useful components. For a new multi-feature idea create at least 5 meaningful operations. Use stable lowercase kebab-case ids. Create referenced frames/nodes before their children/edges. Use placement inside frames and near related nodes; auto for main frames. Read the board summary and edit existing ids instead of duplicating. Resolve 'this'/'that' to the selection. Support moving, recoloring, relabeling, deleting groups (include their children and edges), and clearing only when requested. Generate an image only when it adds real value or is requested. Images run asynchronously. Never write prose: a separate voice speaks to the user, so you only call tools. Emit all drawing tools in a single parallel batch whenever possible. If the user is only chatting and nothing should change on the board, call no tools. Aim for 6-10 operations for a new board; keep tool arguments compact.`;

// Spoken reply runs in parallel with drawing so the user hears an answer within about a second.
export const voicePrompt = `You are the voice of a brainstorming partner on a shared whiteboard. A separate drawing assistant is updating the board right now from the same request. Reply out loud in exactly ONE short sentence, at most 18 words: a quick acknowledgement plus one useful suggestion or question that moves the idea forward. Sound natural and warm, like a sharp colleague. Never use markdown, lists, emoji, dashes, or ids; use only commas and periods. Do not describe the drawing in detail.`;

export function validateOperation(value: unknown): BoardOp | undefined {
  const parsed = BoardOp.safeParse(value);
  if (!parsed.success) { log('invalid_board_op', { issues: parsed.error.issues.length }); return undefined; }
  return parsed.data;
}
export async function runAgent(args: { request: Request; input: AgentRequest; signal: AbortSignal; emit: (event: AgentEvent) => void }) {
  const { request, input, emit } = args;
  const owned = new AbortController();
  const signal = AbortSignal.any([args.signal, owned.signal]);
  const provider = await selectProvider(request);
  const started = performance.now();
  let firstOp = true;
  const emitOp = (value: unknown) => {
    const op = validateOperation(value);
    if (!op || signal.aborted) return;
    if (firstOp) { log('agent_first_op', { model: provider.modelId, ms: Math.round(performance.now() - started) }); firstOp = false; }
    emit({ type: 'op', op });
  };
  const images: Promise<void>[] = [];
  const tools: ToolSet = {};
  for (const variant of BoardOp.options) {
    const name = variant.shape.op.value;
    if (name === 'add_image') continue;
    const inputSchema: z.ZodType<BoardOp> = variant;
    tools[name] = tool({ description: `Apply the ${name} board operation immediately.`, inputSchema,
      execute: async (value) => { emitOp(value); return { applied: true }; },
    });
  }
  tools.generate_image = tool({ description: 'Generate a useful image asynchronously; do not wait before drawing or replying.',
    inputSchema: z.object({ id: NodeId, prompt: z.string().min(1).max(2000), caption: z.string().max(80), placement: Placement }),
    execute: async ({ id, prompt, caption, placement }) => {
      emit({ type: 'pending', id, label: 'Generating image…' });
      images.push((async () => {
        try { const dataUrl = await provider.image(prompt, signal); emitOp({ op: 'add_image', id, caption, placement, dataUrl }); }
        catch { if (!signal.aborted) { log('image_failed'); emit({ type: 'error', message: 'Image generation failed. Please try again.' }); } }
        finally { if (!signal.aborted) emit({ type: 'pending_done', id }); }
      })());
      return { queued: true };
    },
  });
  const messages = [...input.history.map(turn => ({ role: turn.role, content: turn.text })),
    { role: 'user' as const, content: `Board: ${JSON.stringify(input.board)}\nUser: ${input.utterance}` }];
  try {
    const voice = (async () => {
      const spoken = streamText({
        model: provider.model, system: voicePrompt, messages, abortSignal: signal, maxOutputTokens: 120,
        onError: ({ error }) => log('voice_stream_failed', { kind: error instanceof Error ? error.name : 'unknown' }),
        providerOptions: { openai: { reasoningEffort: 'low' } },
      });
      let first = true;
      for await (const part of spoken.fullStream) {
        if (part.type === 'text-delta') {
          if (first) { log('agent_first_say', { model: provider.modelId, ms: Math.round(performance.now() - started) }); first = false; }
          emit({ type: 'say', text: part.text });
        } else if (part.type === 'error') throw part.error;
      }
      if (!first) emit({ type: 'say', text: ' ' }); // Release the final TTS word.
    })();
    const draw = (async () => {
      const result = streamText({
        model: provider.model, system: systemPrompt, messages,
        tools, stopWhen: stepCountIs(3), abortSignal: signal,
        prepareStep: ({ stepNumber }) => stepNumber >= 2 ? { toolChoice: 'none' } : {},
        onError: ({ error }) => log('llm_stream_failed', { kind: error instanceof Error ? error.name : 'unknown' }),
        providerOptions: { openai: { reasoningEffort: 'low', parallelToolCalls: true } },
        maxOutputTokens: 5000,
      });
      for await (const part of result.fullStream) {
        if (part.type === 'error') throw part.error;
      }
    })();
    await Promise.all([voice, draw]);
    await Promise.all(images);
    log('agent_complete', { model: provider.modelId, ms: Math.round(performance.now() - started) });
  } finally { owned.abort(); await Promise.allSettled(images); }
}
