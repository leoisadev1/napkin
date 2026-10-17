// Live captions above the orb: what you're saying right now, then what the partner says back.
import { useEffect, useState } from "react";
import type { Conversation } from "../conversation/types";
import { useMediaQuery } from "./useMediaQuery";

type Caption = { key: string; who: "you" | "partner"; text: string; live: boolean };

const LINGER_MS = 6000;

/** Captions show the latest sentences that fit, like subtitles, rather than the whole reply. */
function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  let out = "";
  for (let i = sentences.length - 1; i >= 0; i--) {
    const next = (sentences[i] ?? "") + out;
    if (next.trim().length > maxChars && out.length > 0) break;
    out = next;
  }
  out = out.trim();
  if (out.length <= maxChars) return out;
  const cut = out.slice(out.length - maxChars);
  const space = cut.indexOf(" ");
  return `…${space > 0 ? cut.slice(space + 1) : cut}`;
}

function sameCaption(a: Caption, b: Caption): boolean {
  return a.key === b.key && a.who === b.who && a.text === b.text && a.live === b.live;
}

function pickCaption(conversation: Conversation, now: number, finalAt: ReadonlyMap<string, number>): Caption | null {
  if (conversation.partial.length > 0) return { key: "partial", who: "you", text: conversation.partial, live: true };
  const last = conversation.transcript.at(-1);
  if (last === undefined) return null;
  if (last.role === "assistant") {
    const done = finalAt.get(last.id);
    if (!last.final || done === undefined || now - done < LINGER_MS) return { key: last.id, who: "partner", text: last.text, live: !last.final };
    return null;
  }
  // Show what was heard while the partner works on it.
  const phase = conversation.phase.kind;
  if (phase === "thinking" || phase === "speaking") return { key: last.id, who: "you", text: last.text, live: false };
  return null;
}

export function Captions({ conversation }: { conversation: Conversation }) {
  const narrow = useMediaQuery("(max-width: 730px)");
  const [now, setNow] = useState(() => Date.now());
  const [finalAt] = useState(() => new Map<string, number>());
  const last = conversation.transcript.at(-1);

  useEffect(() => {
    if (last === undefined || !last.final || finalAt.has(last.id)) return;
    // Ages are measured against `now`, which only needs to tick when the linger window ends.
    finalAt.set(last.id, Date.now());
    const handle = window.setTimeout(() => setNow(Date.now()), LINGER_MS + 50);
    return () => window.clearTimeout(handle);
  }, [last, finalAt]);

  const caption = pickCaption(conversation, now, finalAt);
  // Keep the last caption mounted while it fades out.
  const [shown, setShown] = useState<Caption | null>(caption);
  if (caption !== null && (shown === null || !sameCaption(caption, shown))) setShown(caption);

  const visible = caption !== null;
  const display = caption ?? shown;

  return (
    <div className="captions" data-visible={visible} aria-live="polite" aria-atomic="false">
      {display !== null && (
        <p className="caption" data-who={display.who} data-live={display.live} key={`${display.who}-${display.key}`}>
          <span className="caption-who">{display.who === "you" ? "You" : "Partner"}</span>
          <span className="caption-text">{tail(display.text, narrow ? 96 : 150)}</span>
        </p>
      )}
    </div>
  );
}
