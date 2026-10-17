// The one place that picks the conversation engine. The real engine (Gradium voice + agent)
// is the default; `?mock` in the URL swaps in the scripted mock for offline UI work.
// Decided once at module load, so hook order never changes between renders.
import { useMockConversation } from "./mock";
import { useConversation as useRealConversation } from "./useConversation";

const useMock = new URLSearchParams(window.location.search).has("mock");

export const useConversation = useMock ? useMockConversation : useRealConversation;
