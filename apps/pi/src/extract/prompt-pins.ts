import { writeFileSync } from "node:fs";
import { PINNED_PROMPTS } from "@intelligence/contracts/personal";
import {
  DECIDE_RECORD,
  DECIDE_RECOVERY,
  DECIDE_SAID,
  DECIDE_SAME_FACT,
  DECIDE_SCREEN,
  DECIDE_STANDALONE,
  EXTRACT_PROMPTS,
  EXTRACT_SAME_FACT,
  promptPin,
  TIME_PROPOSAL_PROMPT,
} from "@intelligence/personal-extract";
import { ALL_STAGE_PROMPTS, contractsFile, pinHistory, pinsSource, RUN_PROMPTS } from "@intelligence/personal-ladder";
import { DECIDE_IDENTITY } from "@intelligence/personal-store";

// The contracts' pinned prompt history, generated from the prompts' own text as the ladder's
// pins.ts generates the points' (its rules: every pin kept, a moved text refused): pi is the one
// package that sees every package's prompts. Run `node apps/pi/src/extract/prompt-pins.ts`
// after adding a prompt version; prompt-pins.test.ts fails while the file and the code differ.

export const PROMPT_PINS_FILE = contractsFile("prompt-pins.generated.ts");

// Every pinned prompt in code, by `<id>@<version>`: a model prompt's hash of its text, the
// planner's the hash its prompt records of its own text.
export function codePins(): Map<string, string> {
  const prompts = [
    ...EXTRACT_PROMPTS,
    DECIDE_SCREEN,
    DECIDE_RECOVERY,
    DECIDE_RECORD,
    DECIDE_IDENTITY,
    DECIDE_SAME_FACT,
    EXTRACT_SAME_FACT,
    DECIDE_STANDALONE,
    TIME_PROPOSAL_PROMPT,
    DECIDE_SAID,
  ];
  return new Map([
    ...prompts.map((one): [string, string] => [`${one.id}@${one.version}`, promptPin(one)]),
    ...[...Object.values(RUN_PROMPTS), ...ALL_STAGE_PROMPTS].map((one): [string, string] => [
      `${one.id}@${one.version}`,
      one.textHash,
    ]),
  ]);
}

export const promptPinsSource = (): string =>
  pinsSource("apps/pi/src/extract/prompt-pins.ts", [["PINNED_PROMPTS", pinHistory(PINNED_PROMPTS, codePins())]]);

if (import.meta.main) writeFileSync(PROMPT_PINS_FILE, promptPinsSource());
