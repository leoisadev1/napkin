import { ServerStatus, type ChatTurn } from '../../../shared/agent-protocol';
import type { BoardOp, BoardSummary } from '../../../shared/board';
import { StretchQuestions } from './questions';
import { agentEvents } from '../../agent/client';
import { boardKeywords } from '../../voice/keywords';
import { captureMicrophone } from '../../voice/microphone';
import { SpeechToText } from '../../voice/stt';
import type { ConversationMemory } from '../memory';
import type { BoardBridge, Conversation, ConversationPhase, TranscriptEntry } from '../types';

type Snapshot = Pick<Conversation, 'refining' | 'pendingPhrases' | 'muted'> & { sketching: boolean; suggestions: string[]; phase: ConversationPhase; transcript: TranscriptEntry[]; partial: string; voiceAvailable: boolean };
export class ConversationEngine {
  private state: Snapshot = { refining: false, pendingPhrases: [], muted: false, sketching: false, suggestions: [], phase: { kind: 'idle' }, transcript: [], partial: '', voiceAvailable: false };
  private listeners = new Set<() => void>();
  private levels = new Set<(level: number) => void>();
  private outputLevels = new Set<(level: number) => void>();
  private history: ChatTurn[] = [];
  private pending = new Set<string>();
  private flights: { abort: AbortController; text: string; mode: 'live' | 'turn'; released: boolean; done: boolean; firstOp: boolean; ops: BoardOp[]; ids: string[] }[] = [];
  private stt: SpeechToText | undefined;
  private refineRequest: AbortController | undefined;
  private imageAttempted = false;
  private liveRevision = 0;
  private refinedRevision = 0;
  private stretchText = '';
  private stretchQuestions = new StretchQuestions();
  private refineQuestions = this.stretchQuestions;
  private refineStretch: string | undefined;
  private suggestionRequest: AbortController | undefined;
  private suggestionStretch: string | undefined;
  private pauseTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: { ids: string[]; mode: 'live' | 'turn'; text: string; history: ChatTurn[]; rollbackHistory: ChatTurn[]; stretch: string; questions: StretchQuestions }[] = [];
  private uncommittedWords = false;
  private diagrams = new Map<string, Extract<BoardOp, { op: 'add_diagram' }>>();
  private mockups = new Map<string, Extract<BoardOp, { op: 'add_mockup' }>>();
  private stretchId: string | undefined;
  private context: AudioContext | undefined;
  private stopMic: (() => void) | undefined;
  private voiceGeneration = 0;
  private bridge: BoardBridge;
  private options;
  constructor(bridge: BoardBridge, options: { pipeline?: boolean; memory?: ConversationMemory; onTiming?: (event: { stage: 'request' | 'first_op' | 'complete'; ids: string[]; text: string; at: number }) => void } = {}) {
    this.bridge = bridge; this.options = options;
    const memory = options.memory;
    if (memory) {
      this.history = memory.history.slice(-20); this.imageAttempted = memory.imageAttempted;
      for (const op of memory.diagrams) this.diagrams.set(op.id, op);
      for (const op of memory.mockups) this.mockups.set(op.id, op);
      this.state = { ...this.state, suggestions: memory.suggestions, transcript: memory.transcript.map(entry => ({ ...entry, final: true })) };
    }
  }
  /** What this conversation knows about its board, for saving with the board (see src/boards). */
  exportMemory = (): ConversationMemory => ({ history: this.history, transcript: this.state.transcript, suggestions: this.state.suggestions,
    diagrams: [...this.diagrams.values()], mockups: [...this.mockups.values()], imageAttempted: this.imageAttempted });
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
    let context: AudioContext;
    try { context = new AudioContext({ sampleRate: 24000 }); } catch { context = new AudioContext(); }
    this.context = context;
    try {
      await context.resume();
      const status = await fetch('/api/status').then(response => response.json());
      const parsed = ServerStatus.parse(status); this.update({ voiceAvailable: parsed.voice });
      if (!parsed.voice) throw new Error('Voice is not configured; you can still type');
      if (generation !== this.voiceGeneration) return;
      const stt = new SpeechToText({
        getKeywords: () => boardKeywords(this.bridge.getSummary()),
        onPartial: partial => this.receivePartial(partial),
        onPhrase: text => this.receivePhrase(text),
        onTurn: () => this.finishSpokenStretch(),
        onError: error => { if (generation === this.voiceGeneration) { this.stopVoice(); this.update({ phase: { kind: 'error', message: error.message } }); } },
      });
      this.stt = stt; stt.setMuted(this.state.muted);
      await stt.connect();
      if (generation !== this.voiceGeneration) { stt.stop(); return; }
      const capture = () => captureMicrophone({ context, onFrame: frame => stt.send(frame), onLevel: level => this.levels.forEach(listener => listener(level)) });
      let stop: () => void;
      try { stop = await capture(); }
      catch (error) {
        // Some engines accept the option but cannot attach a mic at another rate.
        if (!(error instanceof DOMException) || error.name !== 'NotSupportedError' || context.sampleRate === undefined) throw error;
        await context.close(); if (generation !== this.voiceGeneration) return;
        context = new AudioContext(); this.context = context;
        await context.resume(); stop = await capture();
      }
      if (generation !== this.voiceGeneration) { stop(); return; }
      this.stopMic = stop; this.update({ phase: this.resting() });
    } catch (error) {
      if (generation === this.voiceGeneration) { this.stopVoice(); this.update({ phase: { kind: 'error', message: error instanceof Error ? error.message : 'Could not start microphone' } }); }
    } finally { if (generation !== this.voiceGeneration && context.state !== 'closed') await context.close(); }
  };
  setMuted = (muted: boolean) => {
    if (muted === this.state.muted) return;
    // STT commits a substantial partial synchronously before suppressing subsequent text.
    this.stt?.setMuted(muted);
    this.update({ muted, partial: '' });
    if (muted) {
      this.suggestionRequest?.abort(); this.suggestionRequest = undefined; this.suggestionStretch = undefined;
      clearTimeout(this.pauseTimer); this.uncommittedWords = false;
      const id = this.stretchId; this.stretchId = undefined;
      this.update({ transcript: this.state.transcript.map(entry => entry.id === id ? { ...entry, final: true } : entry) });
    }
  };
  stopVoice = () => {
    ++this.voiceGeneration;
    this.stt?.stop(); this.stt = undefined; this.stopMic?.(); this.stopMic = undefined;
    this.interrupt();
    if (this.context) { void this.context.close(); this.context = undefined; }
    this.levels.forEach(listener => listener(0)); this.update({ phase: { kind: 'idle' }, partial: '' });
  };
  interrupt = () => {
    this.flights.forEach(flight => flight.abort.abort()); this.flights = [];
    const undispatched = this.queue[0];
    if (undispatched) this.history = undispatched.rollbackHistory;
    this.queue = [];
    this.cancelSuggestions(); clearTimeout(this.pauseTimer);
    this.stt?.resetPhrases(); this.stretchId = undefined; this.uncommittedWords = false;
    for (const id of this.pending) this.bridge.clearPending(id);
    this.pending.clear();
    this.update({ sketching: false, pendingPhrases: [], partial: '', phase: this.resting(), transcript: this.state.transcript.map(entry => ({ ...entry, final: true })) });
  };
  private cancelSuggestions() {
    this.suggestionStretch = undefined;
    this.refineStretch = undefined;
    this.refineRequest?.abort(); this.refineRequest = undefined; this.update({ refining: false });
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
    if (this.state.muted) return;
    if (partial.trim() && partial !== this.state.partial) { this.uncommittedWords = true; this.newSpeech(); }
    this.update({ partial });
  };
  /** A committed STT phrase. New speech is queued and never aborts drawing. */
  receivePhrase = (value: string) => {
    const text = value.trim(); if (!text) return;
    if (!this.uncommittedWords) this.newSpeech();
    this.uncommittedWords = false;
    if (!this.stretchId) { this.stretchId = crypto.randomUUID(); this.stretchText = ''; this.stretchQuestions = new StretchQuestions(); }
    this.stretchText = `${this.stretchText} ${text}`.trim();
    const id = this.stretchId;
    const previous = this.state.transcript.find(entry => entry.id === id);
    this.update({ transcript: [...this.state.transcript.filter(entry => entry.id !== id),
      { id, role: 'user', text: previous ? `${previous.text} ${text}` : text, final: false } satisfies TranscriptEntry].slice(-20) });
    this.enqueue(text, 'live');
  };
  finishSpokenStretch = () => {
    clearTimeout(this.pauseTimer);
    const id = this.stretchId; this.stretchId = undefined;
    if (id) { this.suggestionStretch = this.state.transcript.find(entry => entry.id === id)?.text.slice(-4000); this.refineStretch = this.suggestionStretch; this.refineQuestions = this.stretchQuestions; }
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
      const id = crypto.randomUUID();
      this.update({ pendingPhrases: [...this.state.pendingPhrases, { id, text: part, status: 'queued' }] });
      this.queue.push({ ids: [id], mode, text: part, stretch: this.stretchText, questions: this.stretchQuestions, rollbackHistory: this.history.slice(-20), history: [...this.history.slice(-19), ...(mode === 'live' ? [{ role: 'user', text: `Whole current speaking stretch so far (NEW words are the request utterance): ${this.stretchText.slice(-3900)}` } satisfies ChatTurn] : [])] });
      this.history = [...this.history, { role: 'user', text: part } satisfies ChatTurn].slice(-20);
    }
    void this.drain();
  }
  private requestHistory(history: ChatTurn[], board: BoardSummary): ChatTurn[] {
    // BoardSummary carries only titles. Include generated components so a same-id
    // replacement can preserve the actual screen when later speech enriches it.
    const context: ChatTurn[] = board.items.flatMap(item => {
      const diagram = item.kind === 'diagram' ? this.diagrams.get(item.id) : undefined;
      if (diagram) return [{ role: 'assistant', text: `Current diagram: ${JSON.stringify(diagram).slice(0, 3980)}` } satisfies ChatTurn];
      const mockup = item.kind === 'mockup' ? this.mockups.get(item.id) : undefined;
      return mockup ? [{ role: 'assistant', text: `Current mockup: ${JSON.stringify(mockup)}` } satisfies ChatTurn] : [];
    }).slice(-10);
    if (this.imageAttempted) context.push({ role: 'assistant', text: 'Concept image already attempted for this board. Do not generate another unless explicitly asked.' });
    return [...history.slice(-(20 - context.length)), ...context];
  }
  private applyOperation(op: BoardOp) {
    this.bridge.apply(op);
    if (op.op === 'add_diagram') this.diagrams.set(op.id, op);
    if (op.op === 'add_mockup') this.mockups.set(op.id, op);
    else if (op.op === 'clear') { this.mockups.clear(); this.diagrams.clear(); this.imageAttempted = false; }
    else if (op.op === 'delete') op.ids.forEach(id => { this.mockups.delete(id); this.diagrams.delete(id); });
    else if (op.op === 'update') {
      const mockup = this.mockups.get(op.id);
      if (mockup && op.label !== undefined) this.mockups.set(op.id, { ...mockup, title: op.label });
      for (const [id, diagram] of this.diagrams) {
        this.diagrams.set(id, { ...diagram,
          ...(id === op.id && op.label !== undefined ? { title: op.label.slice(0, 80) } : {}),
          nodes: diagram.nodes.map(node => node.id === op.id ? { ...node,
            ...(op.label !== undefined ? { label: op.label.slice(0, 120) } : {}), ...(op.color ? { color: op.color } : {}),
          } : node),
        });
      }
    }
    if (op.op === 'delete') {
      for (const [id, diagram] of this.diagrams) {
        const nodes = diagram.nodes.filter(node => !op.ids.includes(node.id));
        if (nodes.length < 2) this.diagrams.delete(id);
        else this.diagrams.set(id, { ...diagram, nodes, links: diagram.links.filter(link => !op.ids.includes(link.from) && !op.ids.includes(link.to)) });
      }
    }
  }

  private async refine() {
    const text = this.refineStretch;
    if (!text || this.refineRequest || this.flights.length || this.queue.length || (this.liveRevision <= this.refinedRevision && !this.refineQuestions.hasOpen())) return;
    this.refineStretch = undefined;
    const revision = this.liveRevision;
    const abort = new AbortController(); this.refineRequest = abort; this.update({ refining: true });
    const timer = setTimeout(() => abort.abort(), 8000);
    const ops: BoardOp[] = []; const pending = new Set<string>();
    let done = false;
    try {
      const board = this.bridge.getSummary();
      for await (const event of agentEvents({ mode: 'refine', utterance: text, history: this.requestHistory([...this.history.slice(-18), { role: 'user', text: this.refineQuestions.policy() }], board), board }, abort.signal)) {
        if (abort.signal.aborted) return;
        if (event.type === 'op') ops.push(event.op);
        else if (event.type === 'pending') { this.imageAttempted = true; pending.add(event.id); this.bridge.showPending(event); }
        else if (event.type === 'pending_done') { pending.delete(event.id); this.bridge.clearPending(event.id); }
        else if (event.type === 'error') throw new Error(event.message);
        else if (event.type === 'done') done = true;
      }
      if (done && !abort.signal.aborted) {
        // Synchronous commit: no partial refine is visible while streaming or after cancellation.
        for (const op of [...ops.filter(op => op.op === 'delete'), ...ops.filter(op => op.op !== 'delete')]) this.applyOperation(op);
        this.refinedRevision = revision;
      }
    } catch { /* Optional refinement preserves the live sketch on timeout/failure. */ }
    finally {
      clearTimeout(timer); for (const id of pending) this.bridge.clearPending(id);
      if (this.refineRequest === abort) { this.refineRequest = undefined; this.update({ refining: false }); }
    }
  }
  private async suggest() {
    const text = this.suggestionStretch;
    if (!text || this.suggestionRequest || this.flights.length || this.queue.length) return;
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
    const prior = this.flights.at(-1);
    if (prior && (this.options.pipeline === false || this.flights.length >= 2 || prior.mode !== 'live' || !prior.released || this.queue[0]?.mode !== 'live')) return;
    const batch = this.queue.shift();
    if (!batch) { if (!this.flights.length) { void this.refine(); if (!this.state.muted) void this.suggest(); } return; }
    while (batch.mode === 'live' && this.queue[0]?.mode === 'live' && this.queue[0]?.questions === batch.questions && batch.text.length + (this.queue[0]?.text.length ?? 0) + 1 <= 4000) {
      const next = this.queue.shift(); if (next) {
        batch.stretch = next.stretch;
        batch.text += ` ${next.text}`; batch.ids.push(...next.ids);
        const context = next.history.at(-1); if (context?.text.startsWith('Whole current speaking stretch')) batch.history = [...batch.history.filter(turn => !turn.text.startsWith('Whole current speaking stretch')), context];
      }
    }
    const abort = new AbortController();
    const flight = { abort, text: batch.text, mode: batch.mode, released: false, done: false, firstOp: false, ops: new Array<BoardOp>(), ids: batch.ids };
    this.flights.push(flight);
    this.options.onTiming?.({ stage: 'request', ids: batch.ids, text: batch.text, at: performance.now() });
    const release = () => { flight.released = true; void this.drain(); };
    const pipelineTimer = setTimeout(release, 600);
    const applyReady = () => {
      while (this.flights[0]) {
        const head = this.flights[0];
        for (const op of head.ops.splice(0)) {
          if (!head.firstOp) { head.firstOp = true; this.options.onTiming?.({ stage: 'first_op', ids: head.ids, text: head.text, at: performance.now() }); }
          this.update({ pendingPhrases: this.state.pendingPhrases.filter(phrase => !head.ids.includes(phrase.id)) });
          this.applyOperation(op);
          if (head.mode === 'live' && ['add_shape', 'add_diagram', 'add_mockup', 'add_image', 'update'].includes(op.op)) this.liveRevision++;
        }
        if (!head.done) break;
        this.flights.shift();
        this.options.onTiming?.({ stage: 'complete', ids: head.ids, text: head.text, at: performance.now() });
        this.update({ pendingPhrases: this.state.pendingPhrases.filter(phrase => !head.ids.includes(phrase.id)) });
      }
    };
    const pending = new Set<string>(); const answeredIds: string[] = [];
    const replyId = crypto.randomUUID(); let reply = ''; let done = false;
    this.update({ pendingPhrases: this.state.pendingPhrases.map(phrase => batch.ids.includes(phrase.id) ? { ...phrase, status: 'drawing' } : phrase), sketching: true, phase: this.stt ? this.resting() : { kind: 'thinking' } });
    try {
      const board = this.bridge.getSummary();
      const questionPolicy = batch.mode === 'live' ? batch.questions.claim(batch.stretch, board.items.some(item => item.kind !== 'edge' && !!item.label)) : undefined;
      for await (const event of agentEvents({ utterance: batch.text, mode: batch.mode, history: this.requestHistory([...batch.history.slice(0, -1), ...(questionPolicy ? [{ role: 'user', text: questionPolicy } satisfies ChatTurn] : []), ...batch.history.slice(-1), ...this.flights.filter(other => other !== flight).map(other => ({ role: 'user', text: `Being drawn by a parallel request; do not duplicate or replace its concepts: ${other.text}`.slice(0, 4000) } satisfies ChatTurn))].slice(-20), board), board }, abort.signal)) {
        if (abort.signal.aborted) return;
        switch (event.type) {
          case 'op': if (event.op.op === 'add_diagram') answeredIds.push(event.op.id); flight.ops.push(event.op); applyReady(); release(); break;
          case 'pending': this.imageAttempted = true; this.pending.add(event.id); pending.add(event.id); this.bridge.showPending(event); break;
          case 'pending_done': this.pending.delete(event.id); pending.delete(event.id); this.bridge.clearPending(event.id); break;
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
      if (done) batch.questions.complete(answeredIds);
      if (!done) throw new Error('The response was interrupted. Please try again.');
      if (reply.trim()) this.history = [...this.history, { role: 'assistant', text: reply.slice(0, 4000) } satisfies ChatTurn].slice(-20);
    } catch (error) {
      if (!abort.signal.aborted) this.update({ phase: { kind: 'error', message: error instanceof Error ? error.message : 'Could not complete turn' } });
    } finally {
      clearTimeout(pipelineTimer);
      if (this.flights.includes(flight)) {
        flight.done = true; applyReady();
        for (const id of pending) { this.bridge.clearPending(id); this.pending.delete(id); }
        this.update({ pendingPhrases: this.state.pendingPhrases.filter(phrase => !flight.ids.includes(phrase.id)), sketching: this.flights.length > 0, ...(this.state.phase.kind === 'error' ? {} : { phase: this.resting() }),
          transcript: this.state.transcript.map(entry => entry.id === replyId ? { ...entry, final: true } : entry) });
        void this.drain();
      }
    }
  }
}
