import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodedError } from "@intelligence/contracts/personal";
import pg from "pg";
import { parseDatabaseUrl } from "./db.ts";

// `pi export DIR` and `pi import DIR`: the owner's claims, the entities and accounts they name, the
// owner's rulings and decisions, and the evidence they cite, as one JSON Lines file a table and a
// manifest, and back into an empty database. Rows are written as stored: a sealed value stays
// sealed, and the key file opens it, so nothing here decrypts and no plaintext reaches the disk.
// Both run as pi_owner, the role every one of these tables belongs to, from the bootstrap's
// connection, as the migration runner does.

export const EXPORT_FORMAT = "pi-export";
export const EXPORT_VERSION = 1;

// Every table the export holds, in the order an import loads them: each after those it refers to.
// `order` sorts a table's rows so that a row that refers to another of its table comes after it.
export const EXPORT_TABLES: readonly { name: string; order: string }[] = [
  { name: "vault.source_accounts", order: "id" },
  { name: "vault.evidence_blobs", order: "blob_ref" },
  { name: "vault.evidence_items", order: "id" },
  { name: "knowledge.entities", order: "id" },
  { name: "knowledge.accounts", order: "id" },
  { name: "knowledge.claims", order: "id" },
  { name: "knowledge.claim_entities", order: "claim_id, entity_id" },
  { name: "knowledge.owner_decisions", order: "decided_at, id" },
  { name: "knowledge.fact_rulings", order: "ruling_id" },
  { name: "knowledge.identity_rulings", order: "ruling_id" },
  { name: "knowledge.belief_rulings", order: "ruling_id" },
];

export type ExportManifest = {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  // The newest migration of the database it was taken from: an import loads only into a database
  // at the same one, since a row's columns are that schema's.
  migration: string | null;
  tables: { name: string; file: string; rows: number }[];
};

const fileOf = (table: string): string => `${table}.jsonl`;
// Rows a statement loads at once. Each batch is one statement, so a row that refers to another of
// its table in the same batch is checked at the statement's end.
const BATCH = 500;

async function asOwner<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: parseDatabaseUrl(url).href });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local role pi_owner");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

const latest = async (client: pg.Client): Promise<string | null> =>
  (await client.query<{ name: string | null }>("select max(name) as name from policy.migrations")).rows[0]?.name ??
  null;

// Every row of every table, one JSON object a line, read in one transaction so the files agree.
export async function exportOwnerData(url: string, dir: string): Promise<ExportManifest> {
  await mkdir(dir, { recursive: true });
  return asOwner(url, async (client) => {
    await client.query("set transaction isolation level repeatable read, read only");
    const tables: ExportManifest["tables"] = [];
    for (const { name, order } of EXPORT_TABLES) {
      const { rows } = await client.query<{ row: unknown }>(
        `select row_to_json(t) as row from ${name} t order by ${order}`,
      );
      await writeFile(join(dir, fileOf(name)), rows.map(({ row }) => `${JSON.stringify(row)}\n`).join(""), {
        mode: 0o600,
      });
      tables.push({ name, file: fileOf(name), rows: rows.length });
    }
    const manifest: ExportManifest = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      migration: await latest(client),
      tables,
    };
    await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return manifest;
  });
}

// An export loaded into a database that holds none of these rows, at the export's migration, in one
// transaction: all of it, or nothing. Refused with `not_an_export`, `schema_mismatch` or `not_empty`.
// The tables force row-level security even on their owner; pi_owner loads them with that lifted for
// this transaction alone, and it is forced again before the commit, so no other session ever sees it
// lifted.
export async function importOwnerData(url: string, dir: string): Promise<ExportManifest> {
  let manifest: ExportManifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as ExportManifest;
  } catch {
    throw new CodedError("not_an_export");
  }
  const known = new Set(EXPORT_TABLES.map((table) => table.name));
  if (
    manifest.format !== EXPORT_FORMAT ||
    manifest.version !== EXPORT_VERSION ||
    !Array.isArray(manifest.tables) ||
    manifest.tables.some((table) => !known.has(table.name) || table.file !== fileOf(table.name))
  )
    throw new CodedError("not_an_export");
  return asOwner(url, async (client) => {
    if ((await latest(client)) !== manifest.migration) throw new CodedError("schema_mismatch");
    for (const { name } of EXPORT_TABLES) {
      const { rows } = await client.query<{ any: boolean }>(`select exists (select 1 from ${name}) as any`);
      if (rows[0]?.any === true) throw new CodedError("not_empty");
    }
    for (const { name } of EXPORT_TABLES) {
      const listed = manifest.tables.find((table) => table.name === name);
      if (listed === undefined) continue;
      const lines = (await readFile(join(dir, listed.file), "utf8")).split("\n").filter((line) => line !== "");
      if (lines.length !== listed.rows) throw new CodedError("not_an_export");
      await client.query(`alter table ${name} no force row level security`);
      for (let at = 0; at < lines.length; at += BATCH) {
        const batch = `[${lines.slice(at, at + BATCH).join(",")}]`;
        await client.query(`insert into ${name} select * from json_populate_recordset(null::${name}, $1::json)`, [
          batch,
        ]);
      }
      await client.query(`alter table ${name} force row level security`);
    }
    return manifest;
  });
}
