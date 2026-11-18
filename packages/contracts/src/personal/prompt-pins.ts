import type { Sha256 } from "./primitives.ts";
import { PINNED_PROMPTS } from "./prompt-pins.generated.ts";

export { PINNED_PROMPTS };

// `<prompt id>@<version>` to that prompt's pinned hash: the pinned history, generated from the
// prompts' text (prompt-pins.generated.ts), and one placeholder.
export const PROMPT_PINS: Readonly<Record<string, Sha256>> = Object.freeze({
  ...PINNED_PROMPTS,
  // jev_screen version 2, with the four category questions: a placeholder until the prompt is
  // written. No prompt has this hash, so nothing can be sent under this pin.
  "jev_screen@2": "0000000000000000000000000000000000000000000000000000000000000000",
});
