// Numbered seed phrase input grid (12 or 24 words).
// Pasting a full phrase into any box spreads the words across the boxes;
// pasting exactly 12 or 24 words into the first box also switches the grid size.
import { useRef } from 'react';

export function SeedGrid({ words, onChange }: { words: string[]; onChange: (words: string[]) => void }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const update = (index: number, raw: string) => {
    const parts = raw.toLowerCase().split(/\s+/).filter(Boolean);

    if (parts.length > 1) {
      if (index === 0 && (parts.length === 12 || parts.length === 24)) {
        onChange(parts);
        return;
      }
      const next = [...words];
      parts.forEach((word, k) => {
        if (index + k < next.length) next[index + k] = word;
      });
      onChange(next);
      refs.current[Math.min(index + parts.length, next.length - 1)]?.focus();
      return;
    }

    const next = [...words];
    next[index] = parts[0] ?? '';
    onChange(next);
    // A trailing space after a word moves to the next box.
    if (parts.length === 1 && /\s$/.test(raw)) refs.current[index + 1]?.focus();
  };

  return (
    <div className="seed-grid">
      {words.map((word, i) => (
        <label key={i} className="seed-cell">
          <span className="muted small">
            {i + 1}.
          </span>
          <input
            ref={(el) => {
              refs.current[i] = el;
            }}
            value={word}
            onChange={(e) => update(i, e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
      ))}
    </div>
  );
}
