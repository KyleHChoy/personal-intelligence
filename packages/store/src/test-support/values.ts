// Small values: stored ids, times, tokens, registrations and outcomes.

import { type Timestamp, Timestamp as TimestampShape } from "@intelligence/contracts";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import { type ClientRegistration, EntityId, type ReadOutcome } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import type { SourceAccountRow } from "../write/writer-types.ts";
import { sha256Hex } from "./clients.ts";

// ---------------------------------------------------------------------------------------------
// What a stored row holds
// ---------------------------------------------------------------------------------------------

// An interaction row's id: "il-" and the first 40 hex characters of SHA-256 of evidence id, member
// and entity, joined by newlines.
export const interactionId = (evidenceId: string, entityId: string, member: string = THE_OWNER): string =>
  `il-${sha256Hex([evidenceId, member, entityId].join("\n")).slice(0, 40)}`;

// The evidence id of a revision of an item, as contracts' `evidenceIdFor` gives it.
export const evidenceIdOf = (account: SourceAccountRow, sourceItemId: string, revision = 0): string =>
  evidenceIdFor({ vault: "personal", sourceAccount: account.id, sourceItemId, revision });

// =============================================================================================
// Fixtures for the blind tests of the reader and the admin, built on the helpers above where they
// do the same job. Hand-written, on reserved domains, with canary strings. The tests read the store
// only through its outside surfaces: the Reader, the Admin, the writer's exported functions, and
// SQL as a named role.
// =============================================================================================

// ---------------------------------------------------------------------------------------------
// Small things
// ---------------------------------------------------------------------------------------------

export const hoursFrom = (base: Date, hours: number): Date => new Date(base.getTime() + hours * 3_600_000);
export const daysFrom = (base: Date, days: number): Date => hoursFrom(base, days * 24);
export const iso = (date: Date): Timestamp => TimestampShape.parse(date.toISOString());

// The instant a returned time names. The text of a time after a round trip through the database
// is not specified ("...:00Z" or "...:00.000Z"), so tests compare instants.
export const instant = (time: string | null): number | null => (time === null ? null : Date.parse(time));

// A well-formed token no client was ever given.
export const UNKNOWN_TOKEN = `pit_${"A".repeat(43)}`;

// Tokens no client holds and no client could: the wrong shape, the wrong case, text that would
// break a statement built from it, and far too long. A reader that looks at a token's shape
// before asking the database would take another path for them.
export const MALFORMED_TOKENS: readonly string[] = [
  "not-a-token",
  "pit_short",
  `pit_${"A".repeat(42)}!`,
  "pit_' or '1'='1",
  `PIT_${"A".repeat(43)}`,
  "x".repeat(4096),
];

// A well-formed entity id that no store holds.
export const MISSING_ENTITY = EntityId.parse(`ent_7${"Z".repeat(25)}`);

// A registration for every tool and both views the core's tools need, unless overridden.
export const registration = (
  name: string,
  compartments: string[],
  overrides?: Partial<ClientRegistration>,
): ClientRegistration => ({
  name,
  runtime: "local",
  vendorRetention: "none",
  compartments,
  views: ["self", "people"],
  tools: ["get_self", "search", "get_entity", "get_timeline"],
  ...overrides,
});

// The value of an answer that must be ok.
export function outcomeValue<T>(outcome: ReadOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected an answer, got ${outcome.code}`);
  return outcome.value;
}

// What the store refused a call with: the error's name and its code, never its message. Unlike
// `refusal` above, which is for a statement the database refuses, a call that succeeds is a failure.
export async function refusedWith(run: () => Promise<unknown>): Promise<{ name: string; code: unknown }> {
  try {
    await run();
  } catch (error) {
    return { name: (error as Error).name, code: (error as { code?: unknown }).code };
  }
  throw new Error("expected a refusal, and the call succeeded");
}
