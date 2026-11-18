import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyFile, type Keys, loadKeys } from "./keys.ts";
import { openRow, type RowRef, sealRow } from "./seal.ts";

let dir = "";
let keys: Keys;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-seal-"));
  await generateKeyFile(join(dir, "keys.json"), ["own", "employer:example"]);
  keys = await loadKeys(join(dir, "keys.json"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const notOpened = expect.objectContaining({ name: "CryptoError", code: "open_failed" });
const throwing = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("sealRow and openRow", () => {
  it("an envelope opens only at its own row and column", () => {
    const at: RowRef = { table: "knowledge.accounts", id: "adr_01", column: "value_enc" };
    const value = "canary.person@example.test é";
    const envelope = sealRow(keys, "own", at, value);

    expect(openRow(keys, "own", at, envelope)).toBe(value);
    expect(JSON.stringify(envelope)).not.toContain("canary");
    expect(sealRow(keys, "own", at, value)).not.toEqual(envelope);

    const elsewhere: RowRef[] = [
      { ...at, id: "adr_02" },
      { ...at, column: "domain_enc" },
      { ...at, table: "knowledge.aliases" },
    ];
    for (const other of elsewhere) expect(throwing(() => openRow(keys, "own", other, envelope))).toEqual(notOpened);
    expect(throwing(() => openRow(keys, "employer:example", at, envelope))).toEqual(notOpened);
  });

  it("a compartment the keys lack is refused", () => {
    const at: RowRef = { table: "knowledge.accounts", id: "adr_01", column: "value_enc" };
    const envelope = sealRow(keys, "own", at, "value");
    const unknown = expect.objectContaining({ code: "unknown_compartment" });
    expect(throwing(() => sealRow(keys, "public", at, "value"))).toEqual(unknown);
    expect(throwing(() => openRow(keys, "public", at, envelope))).toEqual(unknown);
  });
});
