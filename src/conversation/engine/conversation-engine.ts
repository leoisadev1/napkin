import { ServerStatus, type ChatTurn } from '../../../shared/agent-protocol';
import { agentEvents } from '../../agent/client';
import { captureMicrophone } from '../../voice/microphone';
import { SpeechToText } from '../../voice/stt';
import { TextToSpeech } from '../../voice/tts';
import type { BoardBridge, ConversationPhase, TranscriptEntry } from '../types';

type Snapshot = { phase: ConversationPhase; transcript: TranscriptEntry[]; partial: string; voiceAvailable: boolean };
export class ConversationEngine {
  private state: Snapshot = { phase: { kind: 'idle' }, transcript: [], partial: '', voiceAvailable: false };
  private listeners = new Set<() => void>();
  private levels = new Set<(level: number) => void>();
  private outputLevels = new Set<(level: number) => void>();
  private history: ChatTurn[] = [];
  private pending = new Set<string>();
  private active: AbortController | undefined;
  private stt: SpeechToText | undefined;
  private tts: TextToSpeech | undefined;
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
        onTurn: text => this.sendText(text),
        onBargeIn: () => { if (this.active || this.tts) this.interrupt(); },
        onError: error => { if (generation === this.voiceGeneration) { this.stopVoice(); this.update({ phase: { kind: 'error', message: error.message } }); } },
      });
      this.stt = stt;
      await stt.connect();
      if (generation !== this.voiceGeneration) { stt.stop(); return; }
      const stop = await captureMicrophone({ context, onFrame: frame => stt.send(frame), onLevel: level => this.levels.forEach(listener => listener(level)) });
      if (generation !== this.voiceGeneration) { stop(); return; }
      this.stopMic = stop; this.update({ phase: this.state.phase.kind === 'speaking' ? this.state.phase : this.active ? { kind: 'thinking' } : this.resting() });
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
    this.tts?.stop(); this.tts = undefined;
    for (const id of this.pending) this.bridge.clearPending(id);
    this.pending.clear();
    this.update({ phase: this.resting(), transcript: this.state.transcript.map(entry => ({ ...entry, final: true })) });
  };
  sendText = (value: string) => {
    const text = value.trim(); if (!text) return;
    if (text.length > 4000) { this.update({ phase: { kind: 'error', message: 'Please keep a turn under 4,000 characters' } }); return; }
    this.interrupt();
    const abort = new AbortController(); this.active = abort;
    const history = this.history.slice(-20); this.history = [...this.history, { role: 'user', text } satisfies ChatTurn].slice(-20);
    const replyId = crypto.randomUUID();
    this.update({ phase: { kind: 'thinking' }, partial: '', transcript: [...this.state.transcript,
      { id: crypto.randomUUID(), role: 'user', text, final: true } satisfies TranscriptEntry].slice(-20) });
    if (this.context && this.stt) {
      const tts = new TextToSpeech(this.context, {
        onSpeaking: () => { if (this.tts === tts) this.update({ phase: { kind: 'speaking' } }); },
        onQuiet: () => { if (this.tts === tts) this.update({ phase: this.active ? { kind: 'thinking' } : this.resting() }); },
        onDone: () => { if (this.tts === tts) { this.tts = undefined; this.update({ phase: this.active ? { kind: 'thinking' } : this.resting() }); } },
        onLevel: level => this.outputLevels.forEach(listener => listener(level)),
        onError: error => { if (this.tts === tts) { tts.stop(); this.tts = undefined; this.update({ phase: { kind: 'error', message: error.message } }); } },
      });
      this.tts = tts; void tts.connect().catch(error => { if (this.tts === tts) { tts.stop(); this.tts = undefined; this.update({ phase: { kind: 'error', message: error instanceof Error ? error.message : 'Speech unavailable' } }); } });
    }
    void (async () => {
      let reply = ''; let done = false;
      try {
        for await (const event of agentEvents({ utterance: text, history, board: this.bridge.getSummary() }, abort.signal)) {
          if (abort.signal.aborted) return;
          switch (event.type) {
            case 'op': this.bridge.apply(event.op); break;
            case 'pending': this.pending.add(event.id); this.bridge.showPending(event); break;
            case 'pending_done': this.pending.delete(event.id); this.bridge.clearPending(event.id); break;
            case 'say': {
              reply += event.text; this.tts?.push(event.text);
              const entries = this.state.transcript.filter(entry => entry.id !== replyId);
              this.update({ transcript: [...entries, { id: replyId, role: 'assistant', text: reply, final: false } satisfies TranscriptEntry].slice(-20) });
              break;
            }
            case 'error': throw new Error(event.message);
            case 'done': done = true; break;
            default: { const exhaustive: never = event; void exhaustive; }
          }
        }
        if (!done) throw new Error('The response was interrupted. Please try again.');
        if (this.active === abort) {
          this.active = undefined;
          if (reply) this.tts?.finish(); else { this.tts?.stop(); this.tts = undefined; }
          if (!this.tts) this.update({ phase: this.resting() });
        }
      } catch (error) {
        if (!abort.signal.aborted && this.active === abort) {
          this.active = undefined; this.tts?.stop(); this.tts = undefined;
          this.update({ phase: { kind: 'error', message: error instanceof Error ? error.message : 'Could not complete turn' } });
        }
      } finally {
        if (!abort.signal.aborted) {
          if (reply) this.history = [...this.history, { role: 'assistant', text: reply.slice(0, 4000) } satisfies ChatTurn].slice(-20);
          this.update({ transcript: this.state.transcript.map(entry => entry.id === replyId ? { ...entry, final: true } : entry) });
          for (const id of this.pending) this.bridge.clearPending(id); this.pending.clear();
        }
      }
    })();
  };
}
