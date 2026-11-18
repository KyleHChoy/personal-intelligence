import { createHash, randomBytes } from "node:crypto";
import { type ClaimRecord, MIRROR_QUOTA, QUOTA_DEFAULTS } from "@intelligence/contracts/personal";
import { openRow } from "@intelligence/personal-store";
import { fingerprint, queryAs, sealRow, type TestDatabase } from "@intelligence/personal-store/testing";

// A Lens device and its capture scope, and an item's claims opened, for the database tests of the
// capture lanes. Made-up ids alone.

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const idOf = (prefix: string): string =>
  `${prefix}_01JPKNSM${randomBytes(9)
    .toString("hex")
    .toUpperCase()
    .replace(/[ILOU]/g, "X")
    .slice(0, 18)}`;

// A Mac's capture and mirror clients and its meeting, activity and block accounts under `own`;
// the capture token.
export async function addDevice(db: TestDatabase): Promise<string> {
  const admin = (sql: string, values?: unknown[]) => queryAs(db.urls.admin, sql, values);
  const capture = { id: idOf("cli"), token: `pit_test-mac-${randomBytes(8).toString("hex")}` };
  const mirror = idOf("cli");
  const insert = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  await admin(insert, [
    capture.id,
    "mac-capture",
    sha256Hex(capture.token),
    ["own"],
    ["self"],
    ["push_capture"],
    "device",
    ...quota(QUOTA_DEFAULTS.device),
  ]);
  await admin(insert, [
    mirror,
    "mac",
    sha256Hex(`pit_test-mirror-${randomBytes(8).toString("hex")}`),
    ["own"],
    ["self", "people", "work"],
    ["sync_mirror"],
    "agent",
    ...quota(MIRROR_QUOTA),
  ]);
  await admin("insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ($1, $2, $3)", [
    "mac",
    capture.id,
    mirror,
  ]);
  for (const [connector, kind] of [
    ["lens_meetings", "transcript"],
    ["lens_activity", "screen_activity"],
    ["lens_blocks", "time_block"],
  ] as const) {
    await admin(
      "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, 'device:mac', $2, $3, '{own}')",
      [idOf("acc"), connector, kind],
    );
  }
  return capture.token;
}

export async function insertScope(
  db: TestDatabase,
  match: "bundle" | "host",
  value: string,
  kinds: string[],
): Promise<void> {
  const admin = (sql: string, values?: unknown[]) => queryAs(db.urls.admin, sql, values);
  const id = idOf("csr");
  await admin(
    "insert into policy.capture_scope (id, match, value_fp, value_enc, compartment, kinds) values ($1, $2, $3, $4, 'own', $5)",
    [
      id,
      match,
      fingerprint(db.keys, "capture_scope", value),
      sealRow(db.keys, "own", { table: "policy.capture_scope", id, column: "value_enc" }, value),
      kinds,
    ],
  );
}

// The claims of an item, opened as pi_admin.
export async function claimsOf(db: TestDatabase, evidenceId: string): Promise<ClaimRecord[]> {
  const admin = <Row>(sql: string, values?: unknown[]) => queryAs<Row>(db.urls.admin, sql, values);
  const rows = await admin<{ id: string; content_enc: unknown; compartments: string[] }>(
    "select id, content_enc, compartments from knowledge.claims where evidence_id = $1 order by id",
    [evidenceId],
  );
  return rows.map(
    (row) =>
      JSON.parse(
        openRow(
          db.keys,
          row.compartments[0] ?? "own",
          { table: "knowledge.claims", id: row.id, column: "content_enc" },
          row.content_enc as never,
        ),
      ) as ClaimRecord,
  );
}
