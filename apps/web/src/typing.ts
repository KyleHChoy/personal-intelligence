import { useEffect, useRef } from "react";

// How long a box that searches as the owner types waits after a key.
export const SEARCH_WAIT_MS = 120;

// Asks once the owner stops typing for a moment. `ask` gets the term trimmed, and whether it is still
// the latest, so an answer to an older term is dropped; `clear` runs at once when the box is empty.
// Both are read when the term changes.
export function useAfterTyping(
  term: string,
  ms: number,
  ask: (trimmed: string, latest: () => boolean) => void,
  clear: () => void,
): void {
  const asked = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new term asks again; `ms` is fixed for a caller and the callbacks only set state
  useEffect(() => {
    const mine = ++asked.current;
    const trimmed = term.trim();
    if (trimmed === "") {
      clear();
      return;
    }
    const timer = setTimeout(() => ask(trimmed, () => mine === asked.current), ms);
    return () => clearTimeout(timer);
  }, [term]);
}
