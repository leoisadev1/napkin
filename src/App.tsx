// App shell: the canvas fills the screen; title, sign-in, transcript and the voice dock float over it.
import { useEffect, useMemo, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { CanvasState } from "./canvas/BoardCanvas";
import { BoardCanvas } from "./canvas/BoardCanvas";
import { createBridgeHost } from "./canvas/host";
import { useConversation } from "./conversation/select";
import { EmptyState } from "./ui/EmptyState";
import { TranscriptIcon } from "./ui/icons";
import { SignIn } from "./ui/SignIn";
import { TitleIsland } from "./ui/TitleIsland";
import { TranscriptPanel } from "./ui/TranscriptPanel";
import { VoiceDock } from "./ui/VoiceDock";
import "./ui/ui.css";

declare global {
  interface Window {
    rtwBridge?: import("./canvas/bridge").CanvasBridge;
  }
}

function reportCanvasError(error: unknown) {
  console.error("[canvas] board op failed", error);
}

export default function App() {
  const host = useMemo(() => createBridgeHost({ onError: reportCanvasError }), []);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [canvas, setCanvas] = useState<CanvasState>({ hasContent: false, theme: "light" });
  const [title, setTitle] = useState(host.bridge.getTitle());
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const conversation = useConversation(host.bridge);

  useEffect(() => (api === null ? undefined : host.attach(api)), [api, host]);
  // Dev-only handle for driving the board from the console or browser tests.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.rtwBridge = host.bridge;
    return () => {
      delete window.rtwBridge;
    };
  }, [host]);
  useEffect(() => host.bridge.subscribeTitle(setTitle), [host]);

  useEffect(() => {
    document.title = `${title} · Whiteboard`;
  }, [title]);

  useEffect(() => {
    document.documentElement.dataset.theme = canvas.theme;
  }, [canvas.theme]);

  // Esc cuts the partner off mid-sentence or mid-sketch.
  const { phase, interrupt } = conversation;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (phase.kind === "thinking" || phase.kind === "speaking") interrupt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase.kind, interrupt]);

  const showEmpty = !canvas.hasContent && conversation.transcript.length === 0 && conversation.partial.length === 0;

  return (
    <div className="app">
      <BoardCanvas onApi={setApi} onState={setCanvas} />
      <TitleIsland title={title} onRename={(next) => host.bridge.setTitle(next)} />
      <div className="top-right">
        <SignIn />
        <button
          type="button"
          className="icon-btn island"
          aria-label={transcriptOpen ? "Hide conversation" : "Show conversation"}
          aria-expanded={transcriptOpen}
          data-active={transcriptOpen}
          onClick={() => setTranscriptOpen((open) => !open)}
        >
          <TranscriptIcon size={20} />
        </button>
      </div>
      <EmptyState visible={showEmpty} onPick={conversation.sendText} />
      <VoiceDock conversation={conversation} />
      <TranscriptPanel open={transcriptOpen} entries={conversation.transcript} onClose={() => setTranscriptOpen(false)} />
    </div>
  );
}
