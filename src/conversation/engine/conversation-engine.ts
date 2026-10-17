import { ServerStatus, type ChatTurn } from '../../../shared/agent-protocol';
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
  private queue: { mode: 'live' | 'turn'; text: string; history: ChatTurn[] }[] = [];
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
        onPartial: partial => this.update({ partial }),
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
    this.stt?.resetPhrases(); this.finishSpokenStretch();
    for (const id of this.pending) this.bridge.clearPending(id);
    this.pending.clear();
    this.update({ sketching: false, partial: '', phase: this.resting(), transcript: this.state.transcript.map(entry => ({ ...entry, final: true })) });
  };
  /** A committed STT phrase. New speech is queued and never aborts drawing. */
  receivePhrase = (value: string) => {
    const text = value.trim(); if (!text) return;
    if (!this.stretchId) this.stretchId = crypto.randomUUID();
    const id = this.stretchId;
    const previous = this.state.transcript.find(entry => entry.id === id);
    this.update({ suggestions: [], transcript: [...this.state.transcript.filter(entry => entry.id !== id),
      { id, role: 'user', text: previous ? `${previous.text} ${text}` : text, final: false } satisfies TranscriptEntry].slice(-20) });
    this.enqueue(text, 'live');
  };
  finishSpokenStretch = () => {
    const id = this.stretchId; this.stretchId = undefined;
    this.update({ transcript: this.state.transcript.map(entry => entry.id === id ? { ...entry, final: true } : entry) });
  };
  pickSuggestion = (text: string) => { this.update({ suggestions: [] }); this.sendText(text); };
  sendText = (value: string) => {
    const text = value.trim(); if (!text) return;
    if (text.length > 4000) { this.update({ phase: { kind: 'error', message: 'Please keep a turn under 4,000 characters' } }); return; }
    this.finishSpokenStretch();
    this.update({ suggestions: [], transcript: [...this.state.transcript,
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
  private async drain() {
    if (this.active) return;
    const batch = this.queue.shift(); if (!batch) return;
    while (batch.mode === 'live' && this.queue[0]?.mode === 'live' && batch.text.length + (this.queue[0]?.text.length ?? 0) + 1 <= 4000) {
      const next = this.queue.shift(); if (next) batch.text += ` ${next.text}`;
    }
    const abort = new AbortController(); this.active = abort;
    const replyId = crypto.randomUUID(); let reply = ''; let done = false;
    this.update({ sketching: true, phase: this.stt ? this.resting() : { kind: 'thinking' } });
    try {
      for await (const event of agentEvents({ utterance: batch.text, mode: batch.mode, history: batch.history, board: this.bridge.getSummary() }, abort.signal)) {
        if (abort.signal.aborted) return;
        switch (event.type) {
          case 'op': this.bridge.apply(event.op); break;
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
