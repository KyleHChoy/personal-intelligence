import { type CaptureWork, STRONG_ATTRIBUTE_METHODS } from "@intelligence/contracts/personal";
import { blockMatchKeys } from "@intelligence/personal-core/lens";
import { fingerprint } from "./fingerprint.ts";
import type { Keys } from "./keys.ts";

// Its app: and host: keys are left out: they credit time in work time but are no attribute of the
// block's own. A leaf, read by the pipeline's block opener and the anchor re-check alike, so the
// two select by the same keys.
type WorkBlock = Extract<CaptureWork, { kind: "block" }>["blocks"][number];
const STRONG_KINDS = ["repository", "document", "folder"] as const;

export function strongKeysOf(
  keys: Keys,
  block: WorkBlock,
): { kind: (typeof STRONG_KINDS)[number]; value: string; keyFps: string[] }[] {
  return STRONG_KINDS.flatMap((kind) => {
    const attribute = block[kind];
    if (attribute === undefined || !STRONG_ATTRIBUTE_METHODS.includes(attribute.method)) return [];
    const one =
      kind === "repository"
        ? { repository: attribute }
        : kind === "document"
          ? { document: attribute }
          : { folder: attribute };
    const keyFps = blockMatchKeys({ app: { bundle: block.bundle }, ...one })
      .filter((key) => key.strong && (key.key.startsWith("repository:") || key.key.startsWith("document:")))
      .map((key) => fingerprint(keys, "anchor", key.key));
    return [{ kind, value: attribute.value, keyFps }];
  });
}
