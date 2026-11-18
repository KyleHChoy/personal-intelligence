// A card to raise, for the tests of the owner's queue.

import { randomBytes } from "node:crypto";
import type { CardId, NewCard } from "@intelligence/contracts/personal";
import { newId } from "../core/ids.ts";

const requestId = (): string => `req-${randomBytes(8).toString("hex")}`;

// A system notice under {own} with one option, acknowledge, and nothing else set; `over` changes
// any part.
export const noticeCard = (over: Partial<NewCard> = {}): NewCard => ({
  id: newId("crd") as CardId,
  requestId: requestId(),
  kind: "notice",
  author: "system:test",
  options: ["acknowledge"],
  target: null,
  refs: [],
  compartments: ["own"],
  expiresAt: null,
  expiresAfterDays: null,
  caseKey: null,
  run: null,
  body: null,
  bodyFrom: null,
  ...over,
});
