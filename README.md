# Napkin

Talk through an idea and the board sketches it as you speak. Say "a repair booking flow: take a photo, match a plumber, get a quote" and boxes and arrows appear while you're still talking. Ask for a phone screen and you get a small UI mockup. Change your mind mid-sentence and the board follows.

Built for the [Active Builders × Gradium](https://activebuilders.dev/hackathon/gradium) challenge.

## How it works

- **Voice:** [Gradium](https://gradium.ai) speech-to-text. The browser streams mic audio straight to Gradium over a WebSocket. The server only hands out short-lived tokens, so the API key never reaches the browser.
- **Drawing:** each phrase you finish goes to a fast LLM, which replies with small board operations ("add a box", "connect these", "make a phone mockup") instead of raw shapes. The canvas lays them out, so drawings stay tidy while the model stays quick. When you pause, a slower pass tidies the board and offers a few next ideas.
- **Canvas:** [Excalidraw](https://github.com/excalidraw/excalidraw), so you can draw, move and edit everything yourself too. The AI sees what's under your pointer, so "label this" and "clean this up" work on your own sketches.
- **Model:** [Claude Haiku 5.5](https://www.anthropic.com/claude/haiku) through the Claude API. Live phrases skip extended thinking so the first box lands in about a second and a half. Tidy-ups get a little thinking.

Other details: mute with M, ⌘B toggles the board list, ⌘K opens commands, boards are saved in your browser, and if your mic goes silent (say, an iPhone that wandered off) it switches to another one.

## Run it locally

You need [Bun](https://bun.sh) 1.4 or newer and a Gradium API key.

```sh
bun install
cp .env.example .env   # add GRADIUM_API_KEY and ANTHROPIC_API_KEY
bun run dev
```

Open http://localhost:5173 and click Talk.

`bun run typecheck`, `bun test` and `bun run build` check the project. `bun run build && bun run start` serves the production build.

## Deploy

The included `Dockerfile` builds the app and serves it on port 8080. Set `GRADIUM_API_KEY` and `ANTHROPIC_API_KEY`. Mount a volume at `/app/.data` so the spend total survives restarts.

Every visitor shares one Claude key, so the server protects it: each visitor gets a per-minute request limit, and all model calls stop for the rest of the calendar month once spend reaches `MONTHLY_BUDGET_USD` (default $100).

## License

MIT
