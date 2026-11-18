import { DateOnly, Timestamp } from "@intelligence/contracts";
import type { PersonalReads, ReadOutcome } from "@intelligence/contracts/personal";
import {
  MemoryCorrection,
  MemoryEntry,
  MemoryExposureView,
  MemoryProjection,
  MemoryProjectionId,
  MemorySection,
  MemoryStamp,
  MemoryStatusView,
  PersonalLogEvent,
  PersonalReadTool,
  PersonalToolArgs,
  SyncMemoryArgs,
  TOOL_VIEW,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

// The outbound memory adapter's shapes.

const hex = (char: string, length: number): string => char.repeat(length);
const projection = `mpr_${hex("a", 40)}`;
const stamp = { projection, fact: hex("b", 64), state: hex("c", 64) };
const entry = {
  kind: "commitment",
  section: "commitments",
  stamp,
  status: "active",
  direction: "owed_by_owner",
  counterparty: "ent_01J0000000000000000000000A",
  due: "2026-10-09",
};
const accepts = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

// Every string a schema can hold, walked through its definition: each must be an id form (a string
// with a regex check), an enumerated word or literal, or one of the shared Timestamp and DateOnly.
type Def = { type: string; [key: string]: unknown };
const defOf = (schema: unknown): Def => (schema as { _zod: { def: Def } })._zod.def;
function freeStrings(schema: unknown, path: string, seen = new Set<unknown>()): string[] {
  if (schema === Timestamp || schema === DateOnly) return [];
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = defOf(schema);
  switch (def.type) {
    case "string": {
      const checks = (def.checks ?? []) as { _zod: { def: { check: string; format?: string } } }[];
      return checks.some((check) => check._zod.def.check === "string_format" && check._zod.def.format === "regex")
        ? []
        : [path];
    }
    case "enum":
    case "literal":
    case "boolean":
    case "number":
      return [];
    case "object":
      return Object.entries(def.shape as Record<string, unknown>).flatMap(([key, value]) =>
        freeStrings(value, `${path}.${key}`, seen),
      );
    case "array":
      return freeStrings(def.element, `${path}[]`, seen);
    case "nullable":
    case "optional":
      return freeStrings(def.innerType, path, seen);
    case "union":
      return (def.options as unknown[]).flatMap((option, i) => freeStrings(option, `${path}|${i}`, seen));
    case "pipe":
      return [...freeStrings(def.in, path, seen), ...freeStrings(def.out, path, seen)];
    default:
      return [`${path}: ${def.type}`];
  }
}

describe("memory contracts", () => {
  it("a projection id is mpr_ and 40 lower-case hexadecimal characters", () => {
    expect(accepts(MemoryProjectionId, projection)).toBe(true);
    for (const bad of [`mpr_${hex("a", 39)}`, `mpr_${hex("A", 40)}`, `blf_${hex("a", 40)}`, `mpr_${hex("g", 40)}`])
      expect(accepts(MemoryProjectionId, bad), bad).toBe(false);
  });

  it("a stamp has a projection, a fact and a state, and refuses a version field", () => {
    expect(accepts(MemoryStamp, stamp)).toBe(true);
    expect(accepts(MemoryStamp, { ...stamp, version: 3 })).toBe(false);
    for (const key of ["projection", "fact", "state"] as const) {
      const { [key]: _, ...rest } = stamp;
      expect(accepts(MemoryStamp, rest), key).toBe(false);
    }
    expect(accepts(MemoryStamp, { ...stamp, fact: hex("b", 63) })).toBe(false);
    expect(accepts(MemoryStamp, { ...stamp, state: hex("C", 64) })).toBe(false);
  });

  it("an entry without a stamp is refused", () => {
    expect(accepts(MemoryEntry, entry)).toBe(true);
    const { stamp: _, ...unstamped } = entry;
    expect(accepts(MemoryEntry, unstamped)).toBe(false);
    expect(accepts(MemoryEntry, { ...entry, stamp: null })).toBe(false);
  });

  it("an entry takes its typed values and nothing else", () => {
    expect(accepts(MemoryEntry, { ...entry, counterparty: null, due: null })).toBe(true);
    expect(accepts(MemoryEntry, { ...entry, due: "2026-10-09T14:30:00Z" })).toBe(true);
    expect(accepts(MemoryEntry, { ...entry, status: "stale", direction: "owed_to_owner" })).toBe(true);
    expect(accepts(MemoryEntry, { ...entry, status: "done" })).toBe(false);
    expect(accepts(MemoryEntry, { ...entry, section: "goals" })).toBe(false);
    expect(accepts(MemoryEntry, { ...entry, counterparty: "Alex Example" })).toBe(false);
    expect(accepts(MemoryEntry, { ...entry, due: "next week" })).toBe(false);
    expect(accepts(MemoryEntry, { ...entry, what: { untrusted: "send the deck" } })).toBe(false);
  });

  it("MemoryEntry has no confirmedAt", () => {
    expect(accepts(MemoryEntry, { ...entry, confirmedAt: "2026-10-01T00:00:00Z" })).toBe(false);
    for (const option of defOf(MemoryEntry).options as unknown[])
      expect(Object.keys(defOf(option).shape as object)).not.toContain("confirmedAt");
  });

  it("no field of MemoryEntry is an UntrustedString or a free string", () => {
    expect(freeStrings(MemoryEntry, "entry")).toEqual([]);
    expect(freeStrings(MemoryCorrection, "correction")).toEqual([]);
    // The positive control: the walk finds a free string where one is.
    expect(freeStrings(PersonalToolArgs.search, "search").length).toBeGreaterThan(0);
  });

  it("MemoryCorrection has a current id exactly when its reason is changed, and takes changed, withdrawn and dropped only", () => {
    const ended = { projection, endedAt: "2026-10-04T12:00:00Z" };
    const next = `mpr_${hex("d", 40)}`;
    expect(accepts(MemoryCorrection, { ...ended, reason: "changed", current: next })).toBe(true);
    expect(accepts(MemoryCorrection, { ...ended, reason: "changed", current: null })).toBe(false);
    expect(accepts(MemoryCorrection, { ...ended, reason: "withdrawn", current: null })).toBe(true);
    expect(accepts(MemoryCorrection, { ...ended, reason: "withdrawn", current: next })).toBe(false);
    expect(accepts(MemoryCorrection, { ...ended, reason: "dropped", current: null })).toBe(true);
    expect(accepts(MemoryCorrection, { ...ended, reason: "dropped", current: next })).toBe(false);
    expect(accepts(MemoryCorrection, { ...ended, reason: "tainted", current: null })).toBe(false);
  });

  it("a projection holds at most 20 corrections and a hash of 64 hexadecimal characters", () => {
    const value = {
      template: "active_memory@1",
      asOf: null,
      entries: [entry],
      corrections: [],
      remove: [],
      truncated: false,
      inStep: true,
      hash: hex("e", 64),
    };
    expect(accepts(MemoryProjection, value)).toBe(true);
    const correction = { projection, endedAt: "2026-10-04T12:00:00Z", reason: "withdrawn", current: null };
    expect(accepts(MemoryProjection, { ...value, corrections: Array(20).fill(correction) })).toBe(true);
    expect(accepts(MemoryProjection, { ...value, corrections: Array(21).fill(correction) })).toBe(false);
    expect(accepts(MemoryProjection, { ...value, hash: hex("e", 63) })).toBe(false);
    expect(accepts(MemoryProjection, { ...value, template: "Active Memory" })).toBe(false);
    expect(accepts(MemoryProjection, { ...value, extra: 1 })).toBe(false);
    expect(freeStrings(MemoryProjection, "projection")).toEqual([]);
  });

  it("SyncMemoryArgs refuses 201 ids and an id twice", () => {
    const ids = Array.from({ length: 201 }, (_, i) => `mpr_${i.toString(16).padStart(40, "0")}`);
    expect(accepts(SyncMemoryArgs, { have: ids.slice(0, 200), canDelete: true })).toBe(true);
    expect(accepts(SyncMemoryArgs, { have: ids, canDelete: true })).toBe(false);
    expect(accepts(SyncMemoryArgs, { have: [projection, projection], canDelete: true })).toBe(false);
    expect(accepts(SyncMemoryArgs, { have: [], canDelete: false })).toBe(true);
    expect(accepts(SyncMemoryArgs, { have: [] })).toBe(false);
    expect(accepts(SyncMemoryArgs, { have: [], canDelete: true, client: "cli_x" })).toBe(false);
  });

  it("MemoryStatusView and MemoryExposureView hold no free string", () => {
    expect(freeStrings(MemoryStatusView, "status")).toEqual([]);
    expect(freeStrings(MemoryExposureView, "exposures")).toEqual([]);
    const client = {
      client: "cli_01J0000000000000000000000A",
      name: "claude-code",
      status: "active",
      retention: "unknown",
      lastSyncAt: null,
      live: 0,
      unconfirmed: 0,
      endedNotAbsent: 0,
      exposures: { pending: 0, reported: 0, notPossible: 0 },
    };
    expect(accepts(MemoryStatusView, { clients: [client] })).toBe(true);
    expect(accepts(MemoryStatusView, { clients: [{ ...client, live: -1 }] })).toBe(false);
    const exposure = {
      id: 1,
      client: client.client,
      name: client.name,
      projection,
      firstServedAt: "2026-10-01T00:00:00Z",
      recordedAt: "2026-10-02T00:00:00Z",
      retention: "retains",
      removal: "pending",
      removalAt: null,
      firstRemoval: null,
      firstRemovalAt: null,
    };
    expect(accepts(MemoryExposureView, { exposures: [exposure], more: false })).toBe(true);
    expect(accepts(MemoryExposureView, { exposures: [{ ...exposure, removal: "done" }], more: false })).toBe(false);
    // The latest report and the first, kept apart: pending again after a report it was gone.
    const revised = {
      ...exposure,
      removal: "pending",
      removalAt: null,
      firstRemoval: "reported",
      firstRemovalAt: "2026-10-03T00:00:00Z",
    };
    expect(accepts(MemoryExposureView, { exposures: [revised], more: false })).toBe(true);
    expect(accepts(MemoryExposureView, { exposures: [{ ...revised, firstRemoval: "pending" }], more: false })).toBe(
      false,
    );
    const { firstRemoval: _first, ...withoutFirst } = exposure;
    expect(accepts(MemoryExposureView, { exposures: [withoutFirst], more: false })).toBe(false);
  });

  it("sync_memory is a read tool of the self view, with its arguments", () => {
    expect(PersonalReadTool.options).toContain("sync_memory");
    expect(TOOL_VIEW.sync_memory).toBe("self");
    expect(PersonalToolArgs.sync_memory).toBe(SyncMemoryArgs);
    expect(MemorySection.options).toEqual(["commitments"]);
  });

  it("the port gains syncMemory and the log event takes a projection id", async () => {
    // These lines compile only while the method keeps its expected signature.
    const sync: PersonalReads["syncMemory"] = async (_token, args) =>
      args.canDelete ? { ok: false, code: "unavailable" } : { ok: false, code: "not_permitted" };
    const answer: ReadOutcome<MemoryProjection> = await sync("token", { have: [], canDelete: true });
    expect(answer).toEqual({ ok: false, code: "unavailable" });
    expect(accepts(PersonalLogEvent, { event: "memory_synced", ids: { projection } })).toBe(true);
    expect(accepts(PersonalLogEvent, { event: "memory_synced", ids: { projection: "Commitment, active" } })).toBe(
      false,
    );
  });
});
