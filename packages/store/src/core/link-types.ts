import { fingerprint } from "./fingerprint.ts";
import type { Keys } from "./keys.ts";

// The two types of a capture item's project link, in one place for every statement that names them, and the title
// link's claim key. A leaf: it imports nothing of the store but its keys, so the pipeline, the cards, the reads,
// the mirror and the admin all read it without an import cycle.
export const ANCHOR_LINK_TYPE = "capture.anchor";
export const TITLE_LINK_TYPE = "capture.project";
export const LINK_TYPES: readonly string[] = Object.freeze([ANCHOR_LINK_TYPE, TITLE_LINK_TYPE]);

// A title link (capture.project) they never serve: it reaches a client only as a cite of its
// confirmed capture_project belief. SQL states the same rule as `c.type <> TITLE_LINK_TYPE`.
export function servedAsFact(type: string): boolean {
  return type !== TITLE_LINK_TYPE;
}

// The card's request id, beliefClaims' hold and the card's claim lookup all take it.
export function titleLinkKeyOf(keys: Keys, factKeyFp: string): string {
  return fingerprint(keys, "agent_claim", `capture\n${factKeyFp}`);
}
