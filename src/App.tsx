// App shell: the canvas fills the screen; title, sign-in, transcript and the voice dock float over it.
import { useEffect, useMemo, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { BoardScreenProps } from "./boards/BoardsApp";
import { createPersistence } from "./boards/persistence";
import type { CanvasState } from "./canvas/BoardCanvas";
import { BoardCanvas, INITIAL_CANVAS } from "./canvas/BoardCanvas";
import { createBridgeHost } from "./canvas/host";
import { useConversation } from "./conversation/select";
import { BoardChrome, MOD } from "./ui/BoardChrome";
import type { Command } from "./ui/CommandMenu";
import { EmptyState } from "./ui/EmptyState";
import { micState, MUTE_KEY } from "./ui/MicToggle";
import { Keys } from "./ui/Keys";
import { PartnerCursor } from "./ui/PartnerCursor";
import { BoardIcon, CommandIcon, MicIcon, MicOffIcon, MoonIcon, NewBoardIcon, PencilIcon, SidebarIcon, SunIcon, TranscriptIcon, TrashIcon } from "./ui/icons";
import { SignIn } from "./ui/SignIn";
import { TitleIsland } from "./ui/TitleIsland";
import { TranscriptPanel } from "./ui/TranscriptPanel";
import { useTheme } from "./ui/useTheme";
import { VoiceDock } from "./ui/VoiceDock";
import "./ui/tokens.css";
import "./ui/canvas.css";
import "./ui/ui.css";

declare global {
  interface Window {
    rtwBridge?: import("./canvas/bridge").CanvasBridge;
    rtwApi?: ExcalidrawImperativeAPI;
  }
}

/** True when a key press belongs to whatever has focus: a text field, or text being edited on the board. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function reportCanvasError(error: unknown) {
  console.error("[canvas] board op failed", error);
}

/** One open board. BoardsApp keys it by board id, so switching boards remounts all of this. */
export default function App({ board, workspace }: BoardScreenProps) {
  const host = useMemo(() => createBridgeHost({ onError: reportCanvasError }), []);
  const persistence = useMemo(() => createPersistence(board, host.bridge, { onError: reportCanvasError }), [board, host]);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  // A saved board starts out with content, so the empty-state prompt never flashes while the scene loads.
  const [canvas, setCanvas] = useState<CanvasState>(() => ({ ...INITIAL_CANVAS, hasContent: (persistence.initialScene.elements?.length ?? 0) > 0 }));
  const { theme, setPreference: setThemePreference, toggle: toggleTheme } = useTheme();
  const { open: menuOpen, setOpen: setMenuOpen } = workspace.menu;
  const [renameRequest, setRenameRequest] = useState(0);
  const [title, setTitle] = useState(host.bridge.getTitle());
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const conversation = useConversation(host.bridge, persistence.conversation);

  useEffect(() => (api === null ? undefined : host.attach(api)), [api, host]);
  useEffect(() => (api === null ? undefined : persistence.attach(api)), [api, persistence]);
  useEffect(() => persistence.start(), [persistence]);
  // Dev-only handle for driving the board from the console or browser tests.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.rtwBridge = host.bridge;
    if (api !== null) window.rtwApi = api;
    return () => {
      delete window.rtwBridge;
      delete window.rtwApi;
    };
  }, [host, api]);
  useEffect(() => host.bridge.subscribeTitle(setTitle), [host]);

  useEffect(() => {
    document.title = `${title} · Whiteboard`;
  }, [title]);

  // Esc cancels a turn the partner is still working on.
  const { phase, interrupt } = conversation;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (phase.kind === "thinking" || phase.kind === "speaking") interrupt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase.kind, interrupt]);

  // M mutes and unmutes while the mic is live. Ignored while typing, with modifiers, or while editing board text.
  const live = micState(conversation) === "live";
  const { muted, setMuted } = conversation;
  useEffect(() => {
    if (!live) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== MUTE_KEY || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isTyping(event.target) || api?.getAppState().editingTextElement != null) return;
      event.preventDefault();
      setMuted(!muted);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live, muted, setMuted, api]);

  // The partner's cursor answers within a beat: it heads to where a heard phrase will land, or says it is tidying up.
  const drawingKey = conversation.pendingPhrases.find((p) => p.status === "drawing")?.id ?? null;
  const lastUser = conversation.transcript.findLast((entry) => entry.role === "user")?.id ?? null;
  const thinkingKey = drawingKey ?? (phase.kind === "thinking" ? lastUser : null);
  const { refining } = conversation;
  useEffect(() => {
    host.bridge.setPartner(refining ? { kind: "tidying" } : thinkingKey !== null ? { kind: "thinking", key: thinkingKey } : { kind: "idle" });
  }, [host, refining, thinkingKey]);

  // Conversation actions also live in the ⌘K menu.
  const { startVoice, stopVoice } = conversation;
  const voiceAvailable = conversation.voiceAvailable;
  const menuExtra = useMemo((): Command[] => {
    const talk: Command[] = !voiceAvailable
      ? []
      : live
        ? [{ id: "stop-talking", group: "Conversation", label: "Stop listening", Icon: MicOffIcon, run: stopVoice }]
        : [{ id: "start-talking", group: "Conversation", label: "Start talking", Icon: MicIcon, keywords: "voice mic", run: () => void startVoice() }];
    const mute: Command[] = live ? [{ id: "mute", group: "Conversation", label: muted ? "Unmute" : "Mute", Icon: muted ? MicIcon : MicOffIcon, shortcut: "M", run: () => setMuted(!muted) }] : [];
    const id = board.meta.id;
    const { sidebar } = workspace;
    return [
      ...talk,
      ...mute,
      { id: "transcript", group: "Conversation", label: transcriptOpen ? "Hide conversation" : "Show conversation", Icon: TranscriptIcon, keywords: "transcript history", run: () => setTranscriptOpen((open) => !open) },
      { id: "board-new", group: "Workspace", label: "New board", Icon: NewBoardIcon, shortcut: "C", keywords: "create add", run: workspace.create },
      { id: "board-rename", group: "Board", label: "Rename board…", Icon: PencilIcon, keywords: "title name", run: () => setRenameRequest((n) => n + 1) },
      {
        id: "board-delete",
        group: "Board",
        label: "Delete board",
        Icon: TrashIcon,
        keywords: "remove trash",
        confirm: "Press Enter again to delete this board",
        run: () => workspace.remove(id),
      },
      { id: "sidebar", group: "Workspace", label: sidebar.open ? "Hide sidebar" : "Show sidebar", Icon: SidebarIcon, shortcut: "[", keywords: "boards list panel", run: () => sidebar.setOpen(!sidebar.open) },
    ];
  }, [voiceAvailable, live, muted, setMuted, startVoice, stopVoice, transcriptOpen, workspace, board.meta.id]);

  // Jumping to another board sits at the end of the menu, below the actions on this one.
  const menuBoards = useMemo(
    (): Command[] =>
      workspace.boards
        .filter((other) => other.id !== board.meta.id)
        .map((other) => ({ id: `open-${other.id}`, group: "Go to board", label: other.title, Icon: BoardIcon, keywords: "switch open board", run: () => workspace.open(other.id) })),
    [workspace, board.meta.id],
  );

  const resting = phase.kind === "idle" || phase.kind === "error";
  const showEmpty = resting && !canvas.hasContent && conversation.transcript.length === 0 && conversation.partial.length === 0;

  return (
    <div className="app">
      <BoardCanvas theme={theme} onApi={setApi} onState={setCanvas} onPointer={host.bridge.trackPointer} initialScene={persistence.initialScene} />
      <PartnerCursor store={host.cursor} api={api} />
      <TitleIsland
        title={title}
        onRename={(next) => host.bridge.setTitle(next)}
        renameRequest={renameRequest}
        sidebar={workspace.sidebar.open && !workspace.sidebar.drawer ? null : { onShow: () => workspace.sidebar.setOpen(true) }}
      />
      <div className="top-right">
        <SignIn />
        <div className="panel top-tools">
          <button type="button" className="ghost-btn" aria-label="Command menu" aria-keyshortcuts="Control+K Meta+K" onClick={() => setMenuOpen(true)}>
            <CommandIcon />
            <span className="tip tip-down" role="presentation">
              Commands<Keys combo={`${MOD} K`} />
            </span>
          </button>
          <button type="button" className="ghost-btn" aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={toggleTheme}>
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            <span className="tip tip-down" role="presentation">
              {theme === "dark" ? "Light theme" : "Dark theme"}
            </span>
          </button>
          <button
            type="button"
            className="ghost-btn"
            aria-label={transcriptOpen ? "Hide conversation" : "Show conversation"}
            aria-expanded={transcriptOpen}
            aria-pressed={transcriptOpen}
            onClick={() => setTranscriptOpen((open) => !open)}
          >
            <TranscriptIcon />
            <span className="tip tip-down" role="presentation">
              Conversation
            </span>
          </button>
        </div>
      </div>
      <BoardChrome
        api={api}
        canvas={canvas}
        theme={theme}
        title={title}
        setThemePreference={setThemePreference}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
        extra={menuExtra}
        trailing={menuBoards}
      />
      <EmptyState
        visible={showEmpty}
        voiceAvailable={conversation.voiceAvailable}
        onStart={() => void conversation.startVoice()}
        onPick={conversation.sendText}
      />
      <VoiceDock conversation={conversation} />
      <TranscriptPanel open={transcriptOpen} entries={conversation.transcript} onClose={() => setTranscriptOpen(false)} />
    </div>
  );
}
