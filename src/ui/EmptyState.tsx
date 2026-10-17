// First-run invitation on the blank canvas: what this is, and three prompts that run on click.
import type { ComponentType } from "react";
import { CalendarSketchIcon, FlowSketchIcon, PhoneSketchIcon } from "./icons";

type Prompt = { text: string; Icon: ComponentType<{ size?: number }> };

const EXAMPLE_PROMPTS: readonly Prompt[] = [
  { text: "I'm building a habit tracker app. Help me map the core loop and sketch the main screen.", Icon: PhoneSketchIcon },
  { text: "Plan a launch for my podcast. I've got six weeks and no audience yet.", Icon: CalendarSketchIcon },
  { text: "Map how our checkout service talks to payments and fraud checks.", Icon: FlowSketchIcon },
];

export function EmptyState({ visible, onPick }: { visible: boolean; onPick: (text: string) => void }) {
  return (
    <section className="empty" data-visible={visible} aria-hidden={!visible} inert={!visible}>
      <h1 className="empty-title">Think out loud.</h1>
      <p className="empty-sub">Talk through an idea and your partner sketches it on the board as you go.</p>
      <ul className="prompts">
        {EXAMPLE_PROMPTS.map(({ text, Icon }, index) => (
          <li key={text} style={{ transitionDelay: visible ? `${140 + index * 70}ms` : "0ms" }}>
            <button type="button" className="prompt" onClick={() => onPick(text)}>
              <span className="prompt-icon">
                <Icon size={20} />
              </span>
              <span className="prompt-text">{text}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
