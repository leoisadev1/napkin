// A keyboard shortcut as separate keycaps, the way Linear shows them: "⌘ K" becomes two keys.
export function Keys({ combo }: { combo: string }) {
  return (
    <span className="keys">
      {combo.split(" ").map((key, index) => (
        <kbd key={`${index}-${key}`}>{key}</kbd>
      ))}
    </span>
  );
}
