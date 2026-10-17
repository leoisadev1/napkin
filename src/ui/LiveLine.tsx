// One quiet line above the bar: the tail of what you're saying (committed phrases solid, the phrase still being
// heard lighter) so you can trust it hears you.
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Conversation, TranscriptEntry } from "../conversation/types";
import type { MicState } from "./MicToggle";

/** User phrases since the partner last said something, newest last. Enough words to fill one line. */
function recentSpeech(transcript: readonly TranscriptEntry[]): string {
  const words: string[] = [];
  for (let i = transcript.length - 1; i >= 0 && words.length < 40; i--) {
    const entry = transcript[i];
    if (entry === undefined || entry.role !== "user") break;
    words.unshift(...entry.text.trim().split(/\s+/));
  }
  return words.slice(-40).join(" ");
}

type Props = { conversation: Conversation; mic: MicState };

export function LiveLine({ conversation, mic }: Props) {
  const { partial, phase } = conversation;
  const said = recentSpeech(conversation.transcript);
  const error = phase.kind === "error" ? phase.message : null;
  const live = mic === "live";
  const visible = live || error !== null || (said.length > 0 && conversation.sketching);

  const boxRef = useRef<HTMLParagraphElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const box = boxRef.current;
    const inner = innerRef.current;
    if (box === null || inner === null) return;
    setOverflow(inner.scrollWidth > box.clientWidth);
  }, [said, partial, error, live]);

  let body: ReactNode;
  if (error !== null) body = <span className="live-error">{error}</span>;
  else if (said.length === 0 && partial.length === 0) body = live ? <span className="live-hint">Listening. Just start talking.</span> : null;
  else
    body = (
      <>
        {said.length > 0 && <span className="live-said">{said}</span>}
        {partial.length > 0 && <span className="live-hearing">{said.length > 0 ? ` ${partial}` : partial}</span>}
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
