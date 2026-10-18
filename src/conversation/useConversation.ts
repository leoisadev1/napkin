import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ConversationOptions } from './memory';
import type { BoardBridge, Conversation } from './types';
import { ConversationEngine } from './engine/conversation-engine';
export function useConversation(bridge: BoardBridge, options: ConversationOptions = {}): Conversation {
  const [engine] = useState(() => new ConversationEngine(bridge, { memory: options.memory })); engine.setBridge(bridge);
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const onMemory = useRef(options.onMemory); onMemory.current = options.onMemory;
  useEffect(() => engine.subscribe(() => onMemory.current?.(engine.exportMemory())), [engine]);
  useEffect(() => {
    const abort = new AbortController(); void engine.loadStatus(abort.signal);
    return () => { abort.abort(); engine.stopVoice(); };
  }, [engine]);
  return { ...snapshot, setMuted: engine.setMuted, subscribeLevel: engine.subscribeLevel, subscribeOutputLevel: engine.subscribeOutputLevel,
    startVoice: engine.startVoice, stopVoice: engine.stopVoice, sendText: engine.sendText, pickSuggestion: engine.pickSuggestion, interrupt: engine.interrupt };
}
