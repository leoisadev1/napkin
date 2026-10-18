// One quiet line above the bar: the tail of what you're saying, so you can trust it hears you. Phrases the partner
// has heard but not drawn yet carry a faint dotted underline; the one it is drawing now gets a moving underline; drawn
// phrases settle into plain text. The phrase still being heard is lighter.
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Conversation, TranscriptEntry } from "../conversation/types";
import type { MicState } from "./MicToggle";
import { useMediaQuery } from "./useMediaQuery";

type PendingPhrase = Conversation["pendingPhrases"][number];
type SegmentStatus = PendingPhrase["status"] | "drawn";
type Segment = { id: string; text: string; status: SegmentStatus };

const MAX_WORDS = 40;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * User phrases since the partner last said something, newest last, each with its drawing state, trimmed to about
 * one line of words. Pending phrases match their transcript entry by id, else by text; any not in the transcript yet
 * come last.
 */
export function recentSegments(transcript: readonly TranscriptEntry[], pending: readonly PendingPhrase[]): Segment[] {
  const entries: TranscriptEntry[] = [];
  let words = 0;
  for (let i = transcript.length - 1; i >= 0 && words < MAX_WORDS; i--) {
    const entry = transcript[i];
    if (entry === undefined || entry.role !== "user") break;
    entries.unshift(entry);
    words += entry.text.trim().split(/\s+/).length;
  }
  const used = new Set<string>();
  const find = (entry: TranscriptEntry): PendingPhrase | undefined => {
    const text = normalize(entry.text);
    return (
      pending.find((p) => !used.has(p.id) && p.id === entry.id) ??
      pending.find((p) => !used.has(p.id) && normalize(p.text) === text) ??
      pending.find((p) => !used.has(p.id) && normalize(p.text).length > 0 && text.includes(normalize(p.text)))
    );
  };
  const segments: Segment[] = entries.map((entry) => {
    const match = find(entry);
    if (match !== undefined) used.add(match.id);
    return { id: entry.id, text: entry.text.trim(), status: match?.status ?? "drawn" };
  });
  for (const p of pending) if (!used.has(p.id)) segments.push({ id: p.id, text: p.text.trim(), status: p.status });

  // Keep the newest words; the oldest segment loses its start if needed.
  let budget = MAX_WORDS;
  const kept: Segment[] = [];
  for (let i = segments.length - 1; i >= 0 && budget > 0; i--) {
    const segment = segments[i];
    if (segment === undefined || segment.text.length === 0) continue;
    const parts = segment.text.split(/\s+/);
    const take = parts.slice(-budget);
    budget -= take.length;
    kept.unshift({ ...segment, text: take.join(" ") });
  }
  return kept;
}

type Props = { conversation: Conversation; mic: MicState };

const STATUS_LABEL: Record<SegmentStatus, string | undefined> = { queued: "heard", drawing: "drawing", drawn: undefined };

export function LiveLine({ conversation, mic }: Props) {
  const { partial, phase, muted, pendingPhrases } = conversation;
  // No keyboard shortcut to mention on a touch screen.
  const touch = useMediaQuery("(hover: none)");
  const segments = recentSegments(conversation.transcript, pendingPhrases);
  const error = phase.kind === "error" ? phase.message : null;
  const live = mic === "live";
  const waiting = segments.some((s) => s.status !== "drawn");
  const notice = conversation.micNotice.length > 0 ? conversation.micNotice : null;
  const visible = live || error !== null || notice !== null || (segments.length > 0 && (conversation.sketching || waiting));

  const boxRef = useRef<HTMLParagraphElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  const signature = segments.map((s) => `${s.id}:${s.status}:${s.text.length}`).join("|");
  useLayoutEffect(() => {
    const box = boxRef.current;
    const inner = innerRef.current;
    if (box === null || inner === null) return;
    setOverflow(inner.scrollWidth > box.clientWidth);
  }, [signature, partial, error, notice, live, muted]);

  let body: ReactNode;
  if (error !== null) body = <span className="live-error">{error}</span>;
  else if (notice !== null) body = <span className="live-notice">{notice}</span>;
  else if (live && muted && !waiting) body = <span className="live-hint">{touch ? "Muted. Tap Muted to talk again." : "Muted. Press M to talk again."}</span>;
  else if (segments.length === 0 && partial.length === 0) body = live ? <span className="live-hint">Listening. Just start talking.</span> : null;
  else
    body = (
      <>
        {segments.map((segment, i) => (
          <span key={segment.id}>
            {i > 0 ? " " : ""}
            <span className="live-said" data-status={segment.status} title={STATUS_LABEL[segment.status]}>
              {segment.text}
            </span>
          </span>
        ))}
        {partial.length > 0 && <span className="live-hearing">{segments.length > 0 ? ` ${partial}` : partial}</span>}
      </>
    );

  return (
    <div className="live-line" data-visible={visible} aria-hidden={!visible}>
      <p className="live-text" ref={boxRef} data-overflow={overflow} aria-live="polite">
        <span className="live-text-inner" ref={innerRef}>
          {body}
        </span>
      </p>
    </div>
  );
}
