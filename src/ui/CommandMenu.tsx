// ⌘K: every action on the board in one filterable list, Linear style. It opens and closes instantly (it is used too
// often to animate), arrow keys move, Enter runs, Escape closes. Actions marked `confirm` ask for a second Enter.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ComponentType, KeyboardEvent } from "react";
import { EnterIcon, SearchIcon } from "./icons";
import { Keys } from "./Keys";

export type Command = {
  id: string;
  group: string;
  label: string;
  Icon: ComponentType<{ size?: number }>;
  shortcut?: string;
  keywords?: string;
  confirm?: string;
  run: () => void;
};

type Props = { open: boolean; commands: readonly Command[]; onClose: () => void };

function matches(command: Command, query: string): boolean {
  const haystack = `${command.label} ${command.group} ${command.keywords ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

export function CommandMenu({ open, commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const shown = useMemo(() => commands.filter((c) => matches(c, query)), [commands, query]);
  const groups = useMemo(() => {
    const out: { name: string; items: { command: Command; index: number }[] }[] = [];
    shown.forEach((command, index) => {
      const group = out.find((g) => g.name === command.group);
      if (group === undefined) out.push({ name: command.group, items: [{ command, index }] });
      else group.items.push({ command, index });
    });
    return out;
  }, [shown]);
  // Groups render in first-seen order, so keyboard order follows the screen, not the list.
  const order = groups.flatMap((g) => g.items.map((item) => item.index));

  // Focus moves into the menu while it is open and goes back where it was when it closes.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    setQuery("");
    setActive(0);
    setConfirming(null);
    inputRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (command: Command) => {
    if (command.confirm !== undefined && confirming !== command.id) {
      setConfirming(command.id);
      return;
    }
    onClose();
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const position = Math.max(0, order.indexOf(active));
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive(order[(position + 1) % Math.max(1, order.length)] ?? 0);
        setConfirming(null);
        return;
      case "ArrowUp":
        event.preventDefault();
        setActive(order[(position - 1 + order.length) % Math.max(1, order.length)] ?? 0);
        setConfirming(null);
        return;
      case "Enter": {
        event.preventDefault();
        const command = shown[active];
        if (command !== undefined) run(command);
        return;
      }
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      // The input is the menu's only stop; options are reached with the arrows. Tab never leaves the dialog.
      case "Tab":
        event.preventDefault();
        inputRef.current?.focus();
        return;
      default:
        return;
    }
  };

  if (!open) return null;
  const activeCommand = shown[active];

  return (
    <div className="cmdk-scrim" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command menu" onKeyDown={onKeyDown}>
        <div className="cmdk-search">
          <SearchIcon />
          <input
            ref={inputRef}
            className="cmdk-input"
            value={query}
            placeholder="Type a command or search…"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeCommand === undefined ? undefined : `${listId}-${activeCommand.id}`}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
              setConfirming(null);
            }}
          />
          <kbd className="cmdk-esc">Esc</kbd>
        </div>
        <div className="cmdk-list" id={listId} role="listbox" ref={listRef}>
          {groups.length === 0 && <p className="cmdk-empty">No matching commands</p>}
          {groups.map((group) => (
            <div key={group.name} role="group" aria-label={group.name}>
              <p className="cmdk-group">{group.name}</p>
              {group.items.map(({ command, index }) => {
                const asking = confirming === command.id;
                return (
                  <div
                    key={command.id}
                    id={`${listId}-${command.id}`}
                    role="option"
                    aria-selected={index === active}
                    className="cmdk-item"
                    data-active={index === active}
                    data-danger={asking}
                    onPointerMove={() => index !== active && setActive(index)}
                    onClick={() => run(command)}
                  >
                    <command.Icon />
                    <span className="cmdk-label">{asking ? command.confirm : command.label}</span>
                    {asking ? (
                      <kbd>
                        <EnterIcon size={12} />
                      </kbd>
                    ) : (
                      command.shortcut !== undefined && <Keys combo={command.shortcut} />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
