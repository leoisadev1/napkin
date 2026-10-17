import { ServerStatus, type ChatTurn } from '../../../shared/agent-protocol';
import type { BoardOp, BoardSummary } from '../../../shared/board';
import { agentEvents } from '../../agent/client';
import { captureMicrophone } from '../../voice/microphone';
import { SpeechToText } from '../../voice/stt';
import type { BoardBridge, ConversationPhase, TranscriptEntry } from '../types';

type Snapshot = { sketching: boolean; suggestions: string[]; phase: ConversationPhase; transcript: TranscriptEntry[]; partial: string; voiceAvailable: boolean };
export class ConversationEngine {
  private state: Snapshot = { sketching: false, suggestions: [], phase: { kind: 'idle' }, transcript: [], partial: '', voiceAvailable: false };
  private listeners = new Set<() => void>();
  private levels = new Set<(level: number) => void>();
  private outputLevels = new Set<(level: number) => void>();
  private history: ChatTurn[] = [];
  private pending = new Set<string>();
  private active: AbortController | undefined;
  private stt: SpeechToText | undefined;
  private suggestionRequest: AbortController | undefined;
  private suggestionStretch: string | undefined;
  private pauseTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: { mode: 'live' | 'turn'; text: string; history: ChatTurn[] }[] = [];
  private uncommittedWords = false;
  private mockups = new Map<string, Extract<BoardOp, { op: 'add_mockup' }>>();
  private stretchId: string | undefined;
  private context: AudioContext | undefined;
  private stopMic: (() => void) | undefined;
  private voiceGeneration = 0;
  private bridge: BoardBridge;
  constructor(bridge: BoardBridge) { this.bridge = bridge; }
  setBridge(bridge: BoardBridge) { this.bridge = bridge; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  subscribeLevel = (listener: (level: number) => void) => { this.levels.add(listener); return () => { this.levels.delete(listener); }; };
  subscribeOutputLevel = (listener: (level: number) => void) => { this.outputLevels.add(listener); return () => { this.outputLevels.delete(listener); }; };
  private update(patch: Partial<Snapshot>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  private resting(): ConversationPhase { return this.stt ? { kind: 'listening' } : { kind: 'idle' }; }
  async loadStatus(signal: AbortSignal) {
    try {
      const response = await fetch('/api/status', { signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Server unavailable');
      const status = ServerStatus.parse(await response.json()); this.update({ voiceAvailable: status.voice });
    } catch { if (!signal.aborted) this.update({ phase: { kind: 'error', message: 'Could not connect to the server' } }); }
  }
  startVoice = async () => {
    if (this.state.phase.kind === 'error') this.stopVoice();
    if (this.context) return;
    const generation = ++this.voiceGeneration;
    this.update({ phase: { kind: 'connecting' } });
    const context = new AudioContext(); this.context = context;
    try {
      await context.resume();
      const status = await fetch('/api/status').then(response => response.json());
      const parsed = ServerStatus.parse(status); this.update({ voiceAvailable: parsed.voice });
      if (!parsed.voice) throw new Error('Voice is not configured; you can still type');
      if (generation !== this.voiceGeneration) return;
      const stt = new SpeechToText({
        onPartial: partial => this.receivePartial(partial),
        onPhrase: text => this.receivePhrase(text),
        onTurn: () => this.finishSpokenStretch(),
        onError: error => { if (generation === this.voiceGeneration) { this.stopVoice(); this.update({ phase: { kind: 'error', message: error.message } }); } },
      });
      this.stt = stt;
      await stt.connect();
      if (generation !== this.voiceGeneration) { stt.stop(); return; }
      const stop = await captureMicrophone({ context, onFrame: frame => stt.send(frame), onLevel: level => this.levels.forEach(listener => listener(level)) });
      if (generation !== this.voiceGeneration) { stop(); return; }
      this.stopMic = stop; this.update({ phase: this.resting() });
    } catch (error) {
      if (generation === this.voiceGeneration) { this.stopVoice(); this.update({ phase: { kind: 'error', message: error instanceof Error ? error.message : 'Could not start microphone' } }); }
    } finally { if (generation !== this.voiceGeneration && context.state !== 'closed') await context.close(); }
  };
  stopVoice = () => {
    ++this.voiceGeneration;
    this.stt?.stop(); this.stt = undefined; this.stopMic?.(); this.stopMic = undefined;
    this.interrupt();
    if (this.context) { void this.context.close(); this.context = undefined; }
    this.levels.forEach(listener => listener(0)); this.update({ phase: { kind: 'idle' }, partial: '' });
  };
  interrupt = () => {
    this.active?.abort(); this.active = undefined;
    const undispatched = this.queue[0];
    if (undispatched) this.history = undispatched.history;
    this.queue = [];
    this.cancelSuggestions(); clearTimeout(this.pauseTimer);
    this.stt?.resetPhrases(); this.stretchId = undefined; this.uncommittedWords = false;
    for (const id of this.pending) this.bridge.clearPending(id);
    this.pending.clear();
    this.update({ sketching: false, partial: '', phase: this.resting(), transcript: this.state.transcript.map(entry => ({ ...entry, final: true })) });
  };
  private cancelSuggestions() {
    this.suggestionStretch = undefined;
    this.suggestionRequest?.abort(); this.suggestionRequest = undefined;
  }
  private newSpeech() {
    this.cancelSuggestions();
    clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => {
      this.stt?.flushPhrases();
      this.finishSpokenStretch();
    }, 1500);
  }
  receivePartial = (partial: string) => {
    if (partial.trim() && partial !== this.state.partial) { this.uncommittedWords = true; this.newSpeech(); }
    this.update({ partial });
  };
  /** A committed STT phrase. New speech is queued and never aborts drawing. */
  receivePhrase = (value: string) => {
    const text = value.trim(); if (!text) return;
    if (!this.uncommittedWords) this.newSpeech();
    this.uncommittedWords = false;
    if (!this.stretchId) this.stretchId = crypto.randomUUID();
    const id = this.stretchId;
    const previous = this.state.transcript.find(entry => entry.id === id);
    this.update({ transcript: [...this.state.transcript.filter(entry => entry.id !== id),
      { id, role: 'user', text: previous ? `${previous.text} ${text}` : text, final: false } satisfies TranscriptEntry].slice(-20) });
    this.enqueue(text, 'live');
  };
  finishSpokenStretch = () => {
    clearTimeout(this.pauseTimer);
    const id = this.stretchId; this.stretchId = undefined;
    if (id) this.suggestionStretch = this.state.transcript.find(entry => entry.id === id)?.text.slice(-4000);
    this.update({ transcript: this.state.transcript.map(entry => entry.id === id ? { ...entry, final: true } : entry) });
    void this.drain();
  };
  pickSuggestion = (text: string) => { this.update({ suggestions: [] }); this.sendText(text); };
  sendText = (value: string) => {
    const text = value.trim(); if (!text) return;
    if (text.length > 4000) { this.update({ phase: { kind: 'error', message: 'Please keep a turn under 4,000 characters' } }); return; }
    this.cancelSuggestions(); clearTimeout(this.pauseTimer);
    this.stretchId = undefined; this.uncommittedWords = false;
    this.update({ transcript: [...this.state.transcript.map(entry => ({ ...entry, final: true })),
      { id: crypto.randomUUID(), role: 'user', text, final: true } satisfies TranscriptEntry].slice(-20) });
    this.enqueue(text, 'turn');
  };
  private enqueue(text: string, mode: 'live' | 'turn') {
    // Each history snapshot excludes its own new phrase, even when it waits behind another request.
    for (let offset = 0; offset < text.length; offset += 4000) {
      const part = text.slice(offset, offset + 4000);
      this.queue.push({ mode, text: part, history: this.history.slice(-20) });
      this.history = [...this.history, { role: 'user', text: part } satisfies ChatTurn].slice(-20);
    }
    void this.drain();
  }
  private requestHistory(history: ChatTurn[], board: BoardSummary): ChatTurn[] {
    // BoardSummary carries only titles. Include generated components so a same-id
    // replacement can preserve the actual screen when later speech enriches it.
    const context: ChatTurn[] = board.items.flatMap(item => {
      const mockup = item.kind === 'mockup' ? this.mockups.get(item.id) : undefined;
      return mockup ? [{ role: 'assistant', text: `Current mockup: ${JSON.stringify(mockup)}` } satisfies ChatTurn] : [];
    }).slice(-10);
    return [...history.slice(-(20 - context.length)), ...context];
  }
  private applyOperation(op: BoardOp) {
    this.bridge.apply(op);
    if (op.op === 'add_mockup') this.mockups.set(op.id, op);
    else if (op.op === 'clear') this.mockups.clear();
    else if (op.op === 'delete') op.ids.forEach(id => this.mockups.delete(id));
    else if (op.op === 'update' && op.label !== undefined) {
      const mockup = this.mockups.get(op.id);
      if (mockup) this.mockups.set(op.id, { ...mockup, title: op.label });
    }
  }
  private async suggest() {
    const text = this.suggestionStretch;
    if (!text || this.suggestionRequest || this.active || this.queue.length) return;
    this.suggestionStretch = undefined;
    const abort = new AbortController(); this.suggestionRequest = abort;
    try {
      const board = this.bridge.getSummary();
      for await (const event of agentEvents({ mode: 'suggest', utterance: text, history: this.requestHistory(this.history, board), board }, abort.signal)) {
        if (abort.signal.aborted) return;
        if (event.type === 'suggestions') this.update({ suggestions: event.items });
      }
    } catch {
      // Suggestions are optional; drawing and existing chips remain available on failure.
    } finally {
      if (this.suggestionRequest === abort) this.suggestionRequest = undefined;
    }
  }
  private async drain() {
    if (this.active) return;
    const batch = this.queue.shift();
    if (!batch) { void this.suggest(); return; }
    while (batch.mode === 'live' && this.queue[0]?.mode === 'live' && batch.text.length + (this.queue[0]?.text.length ?? 0) + 1 <= 4000) {
      const next = this.queue.shift(); if (next) batch.text += ` ${next.text}`;
    }
    const abort = new AbortController(); this.active = abort;
    const replyId = crypto.randomUUID(); let reply = ''; let done = false;
    this.update({ sketching: true, phase: this.stt ? this.resting() : { kind: 'thinking' } });
    try {
      const board = this.bridge.getSummary();
      for await (const event of agentEvents({ utterance: batch.text, mode: batch.mode, history: this.requestHistory(batch.history, board), board }, abort.signal)) {
        if (abort.signal.aborted) return;
        switch (event.type) {
          case 'op': this.applyOperation(event.op); break;
          case 'pending': this.pending.add(event.id); this.bridge.showPending(event); break;
          case 'pending_done': this.pending.delete(event.id); this.bridge.clearPending(event.id); break;
          case 'suggestions': this.update({ suggestions: event.items }); break;
          case 'say': {
            reply += event.text;
            if (reply.trim()) this.update({ transcript: [...this.state.transcript.filter(entry => entry.id !== replyId),
              { id: replyId, role: 'assistant', text: reply, final: false } satisfies TranscriptEntry].slice(-20) });
            break;
          }
          case 'error': throw new Error(event.message);
          case 'done': done = true; break;
          default: { const exhaustive: never = event; void exhaustive; }
        }
      }
      if (!done) throw new Error('The response was interrupted. Please try again.');
      if (reply.trim()) this.history = [...this.history, { role: 'assistant', text: reply.slice(0, 4000) } satisfies ChatTurn].slice(-20);
    } catch (error) {
      if (!abort.signal.aborted) this.update({ phase: { kind: 'error', message: error instanceof Error ? error.message : 'Could not complete turn' } });
    } finally {
      if (this.active === abort) {
        this.active = undefined;
        for (const id of this.pending) this.bridge.clearPending(id); this.pending.clear();
        this.update({ sketching: false, ...(this.state.phase.kind === 'error' ? {} : { phase: this.resting() }),
          transcript: this.state.transcript.map(entry => entry.id === replyId ? { ...entry, final: true } : entry) });
        void this.drain();
      }
    }
  }
}
