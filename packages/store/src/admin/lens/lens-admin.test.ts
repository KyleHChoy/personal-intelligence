import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyFile, type Keys, loadKeys } from "../../core/keys.ts";
import { sealUnder } from "../../core/seal.ts";
import { type LabelRow, parsedOrNull } from "./lens-admin.ts";

// A row it cannot open (a key absent, a key present but wrong, a value that is no JSON) is left out
// of the count, and never fails `pi status` or `pi lens list`.

let dir = "";
let keys: Keys;
let other: Keys;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-lens-admin-"));
  await generateKeyFile(join(dir, "keys.json"), ["own", "employer:example"]);
  await generateKeyFile(join(dir, "other.json"), ["own", "employer:example"]);
  keys = await loadKeys(join(dir, "keys.json"));
  other = await loadKeys(join(dir, "other.json"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const TABLE = "knowledge.captures";
const COLUMN = "facts_enc";
const row = (compartments: string[], value: string, under: Keys = keys): LabelRow => ({
  label: "device:mac",
  id: "cap_01JABCDEFGHJKMNPQRSTVWX001",
  compartments,
  value_enc: sealUnder(
    under,
    compartments,
    { table: TABLE, id: "cap_01JABCDEFGHJKMNPQRSTVWX001", column: COLUMN },
    value,
  ),
});

describe("opened", () => {
  it("opens a value under the admin's keys, and answers null for a key absent, a key wrong or a value that is no JSON", () => {
    // The positive control.
    expect(parsedOrNull(keys, TABLE, COLUMN, row(["own"], JSON.stringify({ counts: { blanked: 2 } })))).toEqual({
      counts: { blanked: 2 },
    });
    // A key present but wrong: sealed under another key file's `own`.
    expect(
      parsedOrNull(keys, TABLE, COLUMN, row(["own"], JSON.stringify({ counts: { blanked: 2 } }), other)),
    ).toBeNull();
    // A key absent from the key file.
    const without: Keys = { ...keys, compartments: new Map([...keys.compartments].filter(([name]) => name === "own")) };
    expect(parsedOrNull(without, TABLE, COLUMN, row(["own", "employer:example"], "{}"))).toBeNull();
    // Opened, but no JSON.
    expect(parsedOrNull(keys, TABLE, COLUMN, row(["own"], "not json"))).toBeNull();
    // Bound to its row: the same envelope read as another column does not open.
    expect(parsedOrNull(keys, TABLE, "item_enc", row(["own"], "{}"))).toBeNull();
  });
});
