// Lens devices, capture scope rules and capture links made by hand, for the database tests that
// drain, read and link captures. A device is made as `pi lens add` makes it.

import { randomBytes } from "node:crypto";
import type { Claim } from "@intelligence/contracts";
import { type ClaimRecord, type EntityId, MIRROR_QUOTA, QUOTA_DEFAULTS } from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import { expect } from "vitest";
import { sealRow } from "../core/seal.ts";
import type { Pipeline } from "../pipeline/pipeline.ts";
import { sha256Hex, testId } from "./clients.ts";
import { session } from "./connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "./database.ts";
import { batchOf } from "./pipeline-fixtures.ts";

const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];

const INSERT_CLIENT = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;

export type LensChannel = { id: string; name: string; token: string };
export type LensDevice = {
  name: string;
  capture: LensChannel;
  mirror: LensChannel;
  accounts: { meetings: string; activity: string; blocks: string };
};

// A device as `pi lens add` makes it, by hand as pi_admin: its capture client `<name>-capture`
// under {own} with the self view, its mirror client `<name>` under {own} with every view, and its
// three source accounts under {own}.
export async function addLensDevice(db: TestDatabase, name: string): Promise<LensDevice> {
  const channel = (client: string): LensChannel => ({
    id: testId("cli"),
    name: client,
    token: `pit_test-${client}-${randomBytes(8).toString("hex")}`,
  });
  const device: LensDevice = {
    name,
    capture: channel(`${name}-capture`),
    mirror: channel(name),
    accounts: { meetings: testId("acc"), activity: testId("acc"), blocks: testId("acc") },
  };
  await session(db.urls.admin, async (query) => {
    await query("begin");
    await query(INSERT_CLIENT, [
      device.capture.id,
      device.capture.name,
      sha256Hex(device.capture.token),
      ["own"],
      ["self"],
      ["push_capture"],
      "device",
      ...quota(QUOTA_DEFAULTS.device),
    ]);
    await query(INSERT_CLIENT, [
      device.mirror.id,
      device.mirror.name,
      sha256Hex(device.mirror.token),
      ["own"],
      ["self", "people", "work"],
      ["sync_mirror"],
      "agent",
      ...quota(MIRROR_QUOTA),
    ]);
    await query("insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ($1, $2, $3)", [
      name,
      device.capture.id,
      device.mirror.id,
    ]);
    for (const [id, connector, kind] of [
      [device.accounts.meetings, "lens_meetings", "transcript"],
      [device.accounts.activity, "lens_activity", "screen_activity"],
      [device.accounts.blocks, "lens_blocks", "time_block"],
    ] as const) {
      await query(
        "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, $2, $3, $4, '{own}')",
        [id, `device:${name}`, connector, kind],
      );
    }
    await query("commit");
  });
  return device;
}

// The device `mac`: its capture client under {own}, its mirror client under {employer:example,
// own} with every view, its three source accounts, and one capture rule that routes the meeting
// app `bundle` to `own`. Returns the capture client's token.
export async function addMacDevice(db: TestDatabase, bundle: string): Promise<string> {
  const capture = { id: testId("cli"), token: `pit_test-mac-capture-${randomBytes(8).toString("hex")}` };
  const mirror = testId("cli");
  await session(db.urls.admin, async (query) => {
    await query("begin");
    await query(INSERT_CLIENT, [
      capture.id,
      "mac-capture",
      sha256Hex(capture.token),
      ["own"],
      ["self"],
      ["push_capture"],
      "device",
      ...quota(QUOTA_DEFAULTS.device),
    ]);
    await query(INSERT_CLIENT, [
      mirror,
      "mac",
      sha256Hex(`pit_test-mac-${randomBytes(8).toString("hex")}`),
      ["employer:example", "own"],
      ["self", "people", "work"],
      ["sync_mirror"],
      "agent",
      ...quota(MIRROR_QUOTA),
    ]);
    await query("insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ($1, $2, $3)", [
      "mac",
      capture.id,
      mirror,
    ]);
    for (const [connector, kind] of [
      ["lens_meetings", "transcript"],
      ["lens_activity", "screen_activity"],
      ["lens_blocks", "time_block"],
    ] as const) {
      await query(
        "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, 'device:mac', $2, $3, '{own}')",
        [testId("acc"), connector, kind],
      );
    }
    const id = testId("csr");
    const sealed = (column: string, value: string) =>
      sealRow(db.keys, "own", { table: "policy.capture_scope", id, column }, value);
    await query(
      "insert into policy.capture_scope (id, match, value_fp, value_enc, account_fp, account_enc, compartment, kinds) values ($1, 'bundle', $2, $3, null, null, 'own', '{meeting}')",
      [id, fingerprint(db.keys, "capture_scope", bundle), sealed("value_enc", bundle)],
    );
    await query("commit");
  });
  return capture.token;
}

export type ScopeRule = {
  match: "bundle" | "host";
  value: string;
  account?: string;
  compartment: string;
  kinds: ("meeting" | "moment" | "block")[];
};

export async function insertScopeRule(db: TestDatabase, rule: ScopeRule): Promise<void> {
  const id = testId("csr");
  const fp = (value: string) => fingerprint(db.keys, "capture_scope", value);
  const sealed = (column: string, value: string) =>
    sealRow(db.keys, "own", { table: "policy.capture_scope", id, column }, value);
  await queryAs(
    db.urls.admin,
    "insert into policy.capture_scope (id, match, value_fp, value_enc, account_fp, account_enc, compartment, kinds) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      id,
      rule.match,
      fp(rule.value),
      sealed("value_enc", rule.value),
      rule.account === undefined ? null : fp(rule.account),
      rule.account === undefined ? null : sealed("account_enc", rule.account),
      rule.compartment,
      rule.kinds,
    ],
  );
}

// A stored capture's row, as linkCapture reads it.
export type CaptureRow = {
  evidence_id: string;
  kind: string;
  revision: number;
  started_at: Date;
  compartments: string[];
};

export async function linkCapture(
  pipeline: Pipeline,
  row: CaptureRow,
  key: string,
  project: EntityId,
  anchor: string,
): Promise<void> {
  const type = "capture.anchor";
  const claim = {
    id: sha256(JSON.stringify([row.evidence_id, row.revision, "capture:link", type, project, anchor, 1])),
    content: { type, subject: project, fields: { anchor } },
    statementKind: "stated_fact",
    basis: "third_party",
    validFrom: row.started_at.toISOString(),
    evidence: [{ evidenceId: row.evidence_id, span: "capture:link" }],
    primaryEvidenceId: row.evidence_id,
    label: { compartments: row.compartments, readers: ["m-owner"] },
    destination: "personal",
    pipelineVersion: "lens-link-1",
    extractorGeneration: 1,
    changeKind: "live",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  } as unknown as Claim;
  const record = {
    claim,
    subjectKind: "project",
    disclosure: [],
    factKey: sha256(`${type}\n${project}\n${key}`),
    lane: row.kind,
    fieldKinds: { anchor: "type" },
    entities: [project],
    origin: "source",
    answersSystem: false,
  } as unknown as ClaimRecord;
  expect(
    await pipeline.commit(
      batchOf(row.evidence_id, [record], { lane: row.kind, status: "skipped", code: "not_extracted" } as never),
    ),
    key,
  ).toBe("committed");
}
