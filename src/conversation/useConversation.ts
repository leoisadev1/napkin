import { useEffect, useState, useSyncExternalStore } from 'react';
import type { BoardBridge, Conversation } from './types';
import { ConversationEngine } from './engine/conversation-engine';
export function useConversation(bridge: BoardBridge): Conversation {
  const [engine] = useState(() => new ConversationEngine(bridge)); engine.setBridge(bridge);
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  useEffect(() => {
    const abort = new AbortController(); void engine.loadStatus(abort.signal);
    return () => { abort.abort(); engine.stopVoice(); };
  }, [engine]);
  return { ...snapshot, setMuted: engine.setMuted, subscribeLevel: engine.subscribeLevel, subscribeOutputLevel: engine.subscribeOutputLevel,
    startVoice: engine.startVoice, stopVoice: engine.stopVoice, sendText: engine.sendText, pickSuggestion: engine.pickSuggestion, interrupt: engine.interrupt };
}
