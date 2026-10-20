# Real-time Whiteboard

Talk through an idea and the board sketches it as you speak. Say "a repair booking flow: take a photo, match a plumber, get a quote" and boxes and arrows appear while you're still talking. Ask for a phone screen and you get a small UI mockup. Change your mind mid-sentence and the board follows.

Built for the [Active Builders × Gradium](https://activebuilders.dev/hackathon/gradium) challenge.

## How it works

- **Voice:** [Gradium](https://gradium.ai) speech-to-text. The browser streams mic audio straight to Gradium over a WebSocket. The server only hands out short-lived tokens, so the API key never reaches the browser.
- **Drawing:** each phrase you finish goes to a fast LLM, which replies with small board operations ("add a box", "connect these", "make a phone mockup") instead of raw shapes. The canvas lays them out, so drawings stay tidy while the model stays quick. When you pause, a slower pass tidies the board and offers a few next ideas.
- **Canvas:** [Excalidraw](https://github.com/excalidraw/excalidraw), so you can draw, move and edit everything yourself too. The AI sees what's under your pointer, so "label this" and "clean this up" work on your own sketches.
- **Model:** sign in with your ChatGPT account to use your own plan, or run the server with any OpenAI-compatible endpoint (we use Claude Haiku 5.5).

Other details: pick your microphone, mute with M, interrupt any time, and boards are saved in the browser.

## Run it locally

You need [Bun](https://bun.sh) 1.4 or newer and a Gradium API key.

```sh
bun install
cp .env.example .env   # add GRADIUM_API_KEY, LWC_SECRET and a model endpoint
bun run dev
```

Open http://localhost:5173 and click Talk.

`bun run typecheck`, `bun test` and `bun run build` check the project. `bun run build && bun run start` serves the production build.

## Deploy

The included `Dockerfile` builds the app and serves it on port 8080. Set `GRADIUM_API_KEY` and `LWC_SECRET`, and either let visitors sign in with ChatGPT or set `ALLOW_DEV_LLM_IN_PRODUCTION=1` with `DEV_LLM_BASE_URL`, `DEV_LLM_API_KEY` and `DEV_LLM_MODEL` for a shared model. The server rate-limits each visitor.

## License

MIT
