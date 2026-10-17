# real-time-whiteboard

A voice-first brainstorming whiteboard. You talk; an AI partner draws on an Excalidraw canvas in real time (boxes, arrows, frames, mini UI mockups, generated images) and answers out loud in a short sentence. You can interrupt it mid-sentence.

Built for the Active Builders x Gradium challenge (deadline Tue Oct 20 2026, 9pm ET). Gradium is required and provides the voice.

## Architecture

- **Voice: Gradium.** Browser streams mic PCM to Gradium STT over WebSocket and plays Gradium TTS from another WebSocket. The server only mints short-lived tokens (`GET https://api.gradium.ai/api/api-keys/token` with `x-api-key`); the API key never reaches the browser. Semantic VAD decides when a user turn has ended. Gradium facts, limits, and gotchas: `/home/leo/.t3/scratch/2026-10-17-https-activebuilders-dev-hackathon-gradium-5ab1c7a4/swarm/01-tech.md`. Docs: https://docs.gradium.ai (index at https://docs.gradium.ai/llms.txt).
- **Brain: the user's ChatGPT plan** via Login with ChatGPT (`@opencoredev/loginwithchatgpt-*`, docs in `/tmp/lwc/docs/content/docs/` and `/tmp/lwc/skills/login-with-chatgpt/SKILL.md`). No OpenAI API key. Pick a fast model from the account's model list and use low reasoning effort. Images use `chatgpt.images.generate()`.
- **Dev fallback LLM.** When no ChatGPT session exists and `DEV_LLM_BASE_URL` is set, the server uses that OpenAI-compatible endpoint (locally the CLIProxyAPI at `http://127.0.0.1:8317/v1`, key in `~/.cli-proxy-api/.api-key`). This exists only so automated tests run without a human signing in. Never ship it as the product path.
- **Canvas: Excalidraw** (`@excalidraw/excalidraw` 0.18). The agent emits semantic `BoardOp`s (`shared/board.ts`); the canvas turns them into elements with auto-layout.

## Contracts (frozen; change only with the orchestrator)

- `shared/board.ts`: `BoardOp`, `BoardSummary` zod schemas.
- `shared/agent-protocol.ts`: `POST /api/agent` request and NDJSON `AgentEvent` stream, `GET /api/status`.
- `src/conversation/types.ts`: `BoardBridge` (UI implements) and `Conversation` (engine implements via `useConversation(bridge)` exported from `src/conversation/useConversation.ts`).

## Ownership

| Area | Owner |
| --- | --- |
| `server/**`, `src/conversation/useConversation.ts`, `src/conversation/engine/**`, `src/voice/**`, `src/agent/**` | backend worker |
| `src/App.tsx`, `src/main.tsx`, `src/canvas/**`, `src/ui/**`, `src/conversation/mock.ts`, `index.html`, CSS, `public/**` | UI worker |
| `shared/**`, `AGENTS.md`, `package.json`, configs | orchestrator (ask before changing; adding a dependency is fine, note it in your report) |

## Commands

- `bun install`
- `bun run dev` starts the API (port `API_PORT`, default 8787) and Vite (port `PORT`, default 5173, proxies `/api`).
- `bun run typecheck`, `bun test`, `bun run build`
- Production: `bun run build && bun run start` (server serves `dist/`).

## Rules

- TypeScript: follow `~/.agents/skills/typescript-best-practices/SKILL.md`. Parse external data with zod at the boundary, no `as` casts on unvalidated data, discriminated unions, no `console.log` in shipped code.
- Secrets live in `.env` (gitignored). Never print or commit them.
- Tests: bound every run (`timeout 300 bun test`). Browser checks use `agent-browser` with a named session.
