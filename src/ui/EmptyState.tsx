// First-run invitation on the blank canvas: one line on what this is, the "Start talking" button, and three
// example prompts that run as typed turns.
import { ArrowRightIcon, Mark, MicIcon, SparkleIcon } from "./icons";

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

export function EmptyState({ visible, voiceAvailable, onStart, onPick }: Props) {
  return (
    <section className="empty" data-visible={visible} aria-hidden={!visible} inert={!visible}>
      <span className="empty-mark" aria-hidden="true">
        <Mark size={24} />
      </span>
      <h1 className="empty-title">Think out loud.</h1>
      <p className="empty-sub">Talk through an idea and the board fills in as you go.</p>
      {voiceAvailable && (
        <button type="button" className="start-talking" onClick={onStart}>
          <MicIcon />
          Start talking
        </button>
      )}
      <p className="prompts-label">{voiceAvailable ? "Or try one" : "Type below, or try one"}</p>
      <ul className="prompts">
        {EXAMPLE_PROMPTS.map((text) => (
          <li key={text}>
            <button type="button" className="prompt" onClick={() => onPick(text)}>
              <SparkleIcon />
              <span>{text}</span>
              <ArrowRightIcon />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
