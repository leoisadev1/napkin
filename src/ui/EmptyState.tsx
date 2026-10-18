// First-run invitation on the blank canvas. The signature is a spoken line that turns into a drawn card, which is the
// whole product in one stroke. Then one line on what this is, the "Start talking" button, and three things to say
// that run as typed turns.
import { MicIcon } from "./icons";

const EXAMPLE_PROMPTS: readonly string[] = [
  "A habit tracker app: the core loop and main screen",
  "A six-week launch plan for a new podcast",
  "How our checkout talks to payments and fraud checks",
];

type Props = {
  visible: boolean;
  voiceAvailable: boolean;
  onStart: () => void;
  onPick: (text: string) => void;
};

/** A voice wave that settles into a rounded card: speech becoming a shape on the board. */
function Signature() {
  return (
    <svg className="empty-sig" width="168" height="56" viewBox="0 0 168 56" fill="none" aria-hidden="true" focusable="false">
      <path
        className="empty-sig-wave"
        d="M4 28h6c4 0 5-8 9-8s5 16 9 16 5-22 9-22 5 28 9 28 5-20 9-20 5 10 9 10 4-4 7-4h11"
        pathLength="1"
      />
      <rect className="empty-sig-card" x="99" y="8" width="64" height="40" rx="10" pathLength="1" />
      <path className="empty-sig-lines" d="M111 23h34M111 33h22" pathLength="1" />
    </svg>
  );
}

export function EmptyState({ visible, voiceAvailable, onStart, onPick }: Props) {
  return (
    <section className="empty" data-visible={visible} aria-hidden={!visible} inert={!visible}>
      <Signature />
      <h1 className="empty-title">Think out loud.</h1>
      <p className="empty-sub">Talk through an idea and the board sketches it as you go.</p>
      {voiceAvailable && (
        <button type="button" className="start-talking" onClick={onStart}>
          <MicIcon />
          Start talking
        </button>
      )}
      <p className="prompts-label">{voiceAvailable ? "Or try saying" : "Type below, or try"}</p>
      <ul className="prompts">
        {EXAMPLE_PROMPTS.map((text) => (
          <li key={text}>
            <button type="button" className="prompt" onClick={() => onPick(text)}>
              {text}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
