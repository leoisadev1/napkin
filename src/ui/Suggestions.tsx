// Up to three next-step ideas from the partner as small chips. Tap sends one as a turn; the close button or Escape
// hides the current set until the partner offers new ones. The last set stays mounted while it fades out.
import { useState } from "react";
import type { KeyboardEvent } from "react";
import { CloseIcon, SparkleIcon } from "./icons";

type Props = { suggestions: readonly string[]; onPick: (text: string) => void };

export function Suggestions({ suggestions, onPick }: Props) {
  const key = suggestions.join("\n");
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [shown, setShown] = useState<readonly string[]>(suggestions);
  if (suggestions.length > 0 && shown.join("\n") !== key) setShown(suggestions);

  const visible = suggestions.length > 0 && dismissed !== key;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") setDismissed(key);
  };

  return (
    <ul className="chips" data-visible={visible} aria-label="Suggestions" aria-hidden={!visible} inert={!visible} onKeyDown={onKeyDown}>
      {shown.map((text, index) => (
        // Keyed by the set so a new set enters fresh instead of morphing the old chips.
        <li key={`${key}-${text}`} style={{ transitionDelay: visible ? `${index * 50}ms` : undefined }}>
          <button type="button" className="chip" title={text} onClick={() => onPick(text)}>
            <SparkleIcon size={14} />
            <span>{text}</span>
          </button>
        </li>
      ))}
      {shown.length > 0 && (
        <li key={`${key}-dismiss`} style={{ transitionDelay: visible ? `${shown.length * 50}ms` : undefined }}>
          <button type="button" className="chips-dismiss" aria-label="Dismiss suggestions" onClick={() => setDismissed(key)}>
            <CloseIcon size={14} />
          </button>
        </li>
      )}
    </ul>
  );
}
