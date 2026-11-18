import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRecordId,
  ContextPack,
  type PersonalLogEvent,
  type PersonalLogger,
} from "@intelligence/contracts/personal";
import { canonicalJson } from "@intelligence/personal-core";
import { assemblePack, templateFor } from "@intelligence/personal-core/views";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyFile, type Keys, loadKeys } from "../core/keys.ts";
import type { Ctx } from "../core/read-ctx.ts";
import { sealUnder } from "../core/seal.ts";
import { HANDOFF, NOTES_LEFT_OUT, PREFERENCES, preferenceItem } from "./read-pack-items.ts";

// Only the proposal's `what` and `polarity` are served, never its quote, its cites or anything else of
// its body. Made-up values only.

const REC = "rec_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const LABEL = ["agent:alpha", "own"];
const CONFIRMED = new Date("2026-03-10T12:00:00.000Z");
const QUOTE = "canary-quote-never-served";
const CITE = "msg_01HZZZZZZZZZZZZZZZZZZZZZZZ";

let dir = "";
let keys: Keys;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-pack-preferences-"));
  await generateKeyFile(join(dir, "keys.json"), ["own", "agent:alpha"]);
  keys = await loadKeys(join(dir, "keys.json"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctxWith(given: Keys): { ctx: Ctx; events: PersonalLogEvent[] } {
  const events: PersonalLogEvent[] = [];
  const log: PersonalLogger = {
    info: (e) => events.push(e),
    warn: (e) => events.push(e),
    error: (e) => events.push(e),
  };
  return {
    ctx: {
      run: () => Promise.reject(new Error("no query")),
      keys: given,
      session: () => Promise.reject(new Error("no session")),
      log,
    },
    events,
  };
}

// A proposal's body as the store seals it: the arguments without requestId, canonical JSON.
const proposal = (over: Record<string, unknown> = {}) => ({
  kind: "preference",
  fields: { what: "canary-what", polarity: "prefers" },
  scope: "this_client",
  quote: QUOTE,
  cites: [CITE],
  ...over,
});
const rowOf = (body: unknown, compartments = LABEL) => ({
  record_id: AgentRecordId.parse(REC),
  evidence_id: "e".repeat(64),
  confirmed_at: CONFIRMED,
  compartments,
  body_enc: sealUnder(
    keys,
    compartments,
    { table: "ledger.agent_writes", id: REC, column: "body_enc" },
    typeof body === "string" ? body : canonicalJson(body),
  ),
});

describe("preferenceItem", () => {
  it("an item of what under untrusted, polarity and the confirmation's time, its id the record's", () => {
    const { ctx, events } = ctxWith(keys);
    const item = preferenceItem(ctx, rowOf(proposal()), false);
    expect(item).toEqual({
      kind: "preference",
      id: REC,
      section: "preferences",
      required: false,
      provenance: "owner",
      asOf: "2026-03-10T12:00:00.000Z",
      what: { untrusted: "canary-what" },
      polarity: "prefers",
      confirmedAt: "2026-03-10T12:00:00.000Z",
    });
    expect(events).toEqual([]);
    // As agent_bootstrap's newest version assembles it.
    const pack = assemblePack(templateFor("agent_bootstrap"), {
      asOf: "2026-03-10T12:00:00.000Z",
      sections: { preferences: item === null ? [] : [item] },
    });
    expect(ContextPack.parse(pack)).toEqual(pack);
  });

  it("the item holds the proposal's what and polarity and nothing else of its body", () => {
    const { ctx } = ctxWith(keys);
    const text = JSON.stringify(preferenceItem(ctx, rowOf(proposal()), false));
    for (const absent of [QUOTE, CITE, "this_client", "scope", "quote", "cites", "fields"])
      expect(text).not.toContain(absent);
  });

  it("a body that is not a this_client preference without requestId is left out, with ids only in the log", () => {
    for (const body of [
      "not json",
      "[]",
      proposal({ scope: "all" }),
      proposal({ kind: "goal", fields: { what: "canary-what" }, scope: "this_client" }),
      proposal({ fields: { what: "canary-what", polarity: "adores" } }),
      proposal({ requestId: "request-0000000001" }),
      proposal({ subject: "someone" }),
    ]) {
      const { ctx, events } = ctxWith(keys);
      expect(preferenceItem(ctx, rowOf(body), false), JSON.stringify(body)).toBeNull();
      expect(events).toEqual([{ event: "pack_preference_skipped", ids: { record: REC } }]);
    }
  });

  it("a body that does not open is left out, and logs pack_preference_skipped with the record", () => {
    const { ctx, events } = ctxWith({
      ...keys,
      compartments: new Map([...keys.compartments].filter(([name]) => name !== "agent:alpha")),
    });
    expect(preferenceItem(ctx, rowOf(proposal()), false)).toBeNull();
    expect(events).toEqual([{ event: "pack_preference_skipped", ids: { record: REC } }]);
  });

  it("any other error is thrown, and logs nothing", () => {
    const { ctx, events } = ctxWith({
      ...keys,
      compartments: new Map([...keys.compartments].map(([name]) => [name, "not a key" as never])),
    });
    expect(() => preferenceItem(ctx, rowOf(proposal()), false)).toThrow();
    expect(events).toEqual([]);
  });
});

describe("no pack statement reads a proposal but through policy.confirmed_preferences()", () => {
  it("the handoff and notes statements read their own kinds only, and the preferences one is the function alone", () => {
    expect(HANDOFF).toMatch(/w\.kind = 'handoff'/);
    expect(NOTES_LEFT_OUT).toMatch(/w\.kind in \('note', 'finding'\)/);
    expect(PREFERENCES.trim()).toBe(
      "select record_id, evidence_id, confirmed_at, compartments, body_enc from policy.confirmed_preferences()",
    );
  });
});
