import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { log } from "../test-support/unit.ts";
import { generateKeyFile, type Keys, loadKeys } from "./keys.ts";
import { type Ctx, Unavailable, untrusted } from "./read-ctx.ts";
import { openRow, openUnder, type RowRef, sealRow, sealUnder } from "./seal.ts";

// One compartment gives that compartment's own key.

let dir = "";
let keys: Keys;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-seal-under-"));
  await generateKeyFile(join(dir, "keys.json"), ["own", "employer:example", "agent:alpha"]);
  keys = await loadKeys(join(dir, "keys.json"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const at: RowRef = { table: "ledger.agent_writes", id: "rec_01", column: "body_enc" };
const notOpened = expect.objectContaining({ name: "CryptoError", code: "open_failed" });
const unknown = expect.objectContaining({ code: "unknown_compartment" });
const throwing = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};
const only = (names: string[]): Keys => ({
  ...keys,
  compartments: new Map([...keys.compartments].filter(([name]) => names.includes(name))),
});

describe("sealUnder and openUnder", () => {
  it("a value sealed under two compartments opens only with both keys", () => {
    const envelope = sealUnder(keys, ["own", "agent:alpha"], at, "canary body");
    expect(openUnder(keys, ["own", "agent:alpha"], at, envelope)).toBe("canary body");
    expect(openUnder(only(["own", "agent:alpha"]), ["own", "agent:alpha"], at, envelope)).toBe("canary body");
    // Either key alone does not open it.
    expect(throwing(() => openRow(keys, "own", at, envelope))).toEqual(notOpened);
    expect(throwing(() => openRow(keys, "agent:alpha", at, envelope))).toEqual(notOpened);
    expect(throwing(() => openUnder(keys, ["own"], at, envelope))).toEqual(notOpened);
    // Nor a third compartment with them.
    expect(throwing(() => openUnder(keys, ["own", "agent:alpha", "employer:example"], at, envelope))).toEqual(
      notOpened,
    );
  });

  it("one compartment gives an envelope openRow opens", () => {
    const envelope = sealUnder(keys, ["own"], at, "one");
    expect(openRow(keys, "own", at, envelope)).toBe("one");
    expect(openUnder(keys, ["own"], at, sealRow(keys, "own", at, "two"))).toBe("two");
  });

  it("the order of the compartments does not matter", () => {
    const envelope = sealUnder(keys, ["own", "employer:example", "agent:alpha"], at, "ordered");
    expect(openUnder(keys, ["agent:alpha", "own", "employer:example"], at, envelope)).toBe("ordered");
    expect(openUnder(keys, ["employer:example", "agent:alpha", "own"], at, envelope)).toBe("ordered");
  });

  it("a compartment the keys lack is refused before any key is tried", () => {
    const envelope = sealUnder(keys, ["own", "agent:alpha"], at, "value");
    expect(throwing(() => sealUnder(keys, ["own", "public"], at, "value"))).toEqual(unknown);
    expect(throwing(() => openUnder(only(["own"]), ["own", "agent:alpha"], at, envelope))).toEqual(unknown);
    // The control: with both keys the same envelope opens.
    expect(openUnder(only(["own", "agent:alpha"]), ["own", "agent:alpha"], at, envelope)).toBe("value");
    expect(throwing(() => sealUnder(keys, [], at, "value"))).toEqual(unknown);
  });

  it("an envelope moved to another row or column does not open", () => {
    const envelope = sealUnder(keys, ["own", "agent:alpha"], at, "value");
    for (const other of [
      { ...at, id: "rec_02" },
      { ...at, column: "item_enc" },
      { ...at, table: "vault.evidence_blobs" },
    ]) {
      expect(throwing(() => openUnder(keys, ["own", "agent:alpha"], other, envelope))).toEqual(notOpened);
    }
  });
});

describe("the reader's untrusted()", () => {
  const ctx = (names: string[]): Ctx => ({
    run: () => Promise.reject(new Error("no statement")),
    keys: only(names),
    session: () => Promise.reject(new Error("no session")),
    log,
  });

  it("opens a row under every one of its compartments", () => {
    const envelope = sealUnder(keys, ["own", "agent:alpha"], at, "both");
    const row = { id: at.id, compartments: ["own", "agent:alpha"], value_enc: envelope };
    expect(untrusted(ctx(["own", "agent:alpha"]), at.table, at.column, row)).toEqual({ untrusted: "both" });
    // A row of one compartment opens as it did before.
    const single = { id: at.id, compartments: ["own"], value_enc: sealRow(keys, "own", at, "one") };
    expect(untrusted(ctx(["own"]), at.table, at.column, single)).toEqual({ untrusted: "one" });
  });

  it("a row of two compartments, one outside the call's keys, does not open", () => {
    const envelope = sealUnder(keys, ["own", "agent:alpha"], at, "both");
    const row = { id: at.id, compartments: ["own", "agent:alpha"], value_enc: envelope };
    expect(throwing(() => untrusted(ctx(["own"]), at.table, at.column, row))).toBeInstanceOf(Unavailable);
    expect(throwing(() => untrusted(ctx([]), at.table, at.column, { ...row, compartments: [] }))).toBeInstanceOf(
      Unavailable,
    );
  });
});
