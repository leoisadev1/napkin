// The one place that picks the conversation engine. The real engine lives in ./useConversation.ts;
// until it is merged, the scripted mock stands in. Swap this re-export at merge time.
export { useMockConversation as useConversation } from "./mock";
