import { RequestId } from "@intelligence/contracts";
import { LIMITS, type Limits } from "./claim-pipeline/limits.ts";
import { sha256 } from "./hash.ts";

// What the shared parse accepts of a personal item. A message block holds at most what a 4 MiB
// answer held, in base64 lines of 76 characters, so its payload is held below the shared values.
// Personal configuration, not a fallback.
export const PERSONAL_LIMITS: Limits = { ...LIMITS, payloadBytes: 6 * 1024 * 1024, payloadLines: 100_000 };

// The generation the shared interaction record's request ids are made under.
export const EXTRACTOR_GENERATION = 0;

// The id of the identity request for the address at `index` among an item's participants or a
// contact's addresses: where the address stood, never what it was, so a revision replays it.
export const resolutionRequestId = (
  item: { evidenceId: string; revision: number },
  role: "participant" | "contact",
  index: number,
): RequestId =>
  RequestId.parse(sha256(JSON.stringify([item.evidenceId, item.revision, EXTRACTOR_GENERATION, role, index])));
