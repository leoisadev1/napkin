/** Bounded, content-free lifecycle evidence. Never store audio, transcripts or tokens. */
type Diagnostic = { at: string; event: string; detail: Record<string, string | number | boolean> };
const events: Diagnostic[] = [];
const controls = new Map<string, () => void>();
export const voiceDebug = {
  events,
  clear: () => { events.length = 0; },
  run: (name: string) => controls.get(name)?.(),
};
declare global { interface Window { __rtwDebug: typeof voiceDebug } }
if (typeof window !== 'undefined') window.__rtwDebug = voiceDebug;
export function diagnostic(event: string, detail: Diagnostic['detail'] = {}) {
  events.push({ at: new Date().toISOString(), event, detail });
  if (events.length > 500) events.splice(0, events.length - 500);
}
export function debugControl(name: string, action: () => void) {
  controls.set(name, action);
  return () => { if (controls.get(name) === action) controls.delete(name); };
}

export function voiceFailureCategory(message: string) {
  for (const category of ['credit', 'concurr', 'token', 'expir', 'idle', 'timeout', 'duration', 'policy', 'format']) {
    if (message.toLowerCase().includes(category)) return category;
  }
  return message ? 'other' : 'unspecified';
}
