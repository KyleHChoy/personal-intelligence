import { createHash, randomBytes } from "node:crypto";
import { ConnectorCursor } from "@intelligence/contracts";
import { messageBodyHash } from "@intelligence/contracts/body-hash";
import { TOOL_NAMES as SERVED_TOOLS } from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { CANARIES, CANARY_PERSON, connect, OWNER, QUENTIN, SOLO } from "../test-support/cast.ts";
import {
  bareCondition,
  EXPOSURE_TABLE_GRANTS,
  FORGETTING_COLUMN_GRANTS,
  FORGETTING_TABLE_GRANTS,
  isMemoryColumnGrant,
  LEARNING_TABLE_GRANTS,
  MEMORY_COLUMN_GRANTS,
  MEMORY_TABLE_GRANTS,
  MENTION_TABLE_GRANTS,
  PIPELINE_LEDGER_CONDITIONS,
  RESTRICTED_COLUMN_GRANTS,
  RESTRICTED_TABLE_GRANTS,
  TABLES,
  WRITER_LEDGER_CONDITIONS,
} from "../test-support/catalogue.ts";
import {
  DREAM_COLUMN_GRANTS,
  DREAM_CONDITIONS,
  DREAM_TABLE_GRANTS,
  isDreamColumnGrant,
} from "../test-support/catalogue-dream.ts";
import {
  BELIEF_INPUTS_COLUMN_GRANTS,
  CLOSE_COLUMN_GRANTS,
  CLOSE_CONDITIONS,
  CLOSE_TABLE_GRANTS,
  COVERAGE_COLUMN_GRANTS,
  COVERAGE_CONDITIONS,
  COVERAGE_TABLE_GRANTS,
  FEWER_CARDS_COLUMN_GRANTS,
  FEWER_CARDS_CONDITIONS,
  FEWER_CARDS_TABLE_GRANTS,
  isBeliefInputsColumnGrant,
  isCoverageColumnGrant,
  isFewerCardsColumnGrant,
  isLensColumnGrant,
  isNoticeColumnGrant,
  isOutcomeColumnGrant,
  isWarmthColumnGrant,
  KNOWLEDGE,
  LASTING_KNOWLEDGE_COLUMN_GRANTS,
  LASTING_KNOWLEDGE_CONDITIONS,
  LENS_COLUMN_GRANTS,
  LENS_TABLE_GRANTS,
  MIRROR_TABLE_GRANTS,
  MOMENT_CALL_TABLE_GRANTS,
  NAMED_ORG_TABLE_GRANTS,
  NOTICE_COLUMN_GRANTS,
  NOTICE_GRANTS_ON_EARLIER,
  NOTICE_TABLE_GRANTS,
  OUTCOME_COLUMN_GRANTS,
  PROJECT_ANCHOR_READER_COLUMNS,
  PROJECT_READER_COLUMNS,
  PROJECT_TABLE_GRANTS,
  QUERY_TIME_TABLE_GRANTS,
  RESEARCH_COLUMN_GRANTS,
  RESEARCH_GRANTS_ON_EARLIER,
  RESEARCH_TABLE_GRANTS,
  RUNTIME_ROLES,
  SCHEMAS,
  TRIGGER_WORK_CLAIM_COLUMNS,
  tablesIn,
  WARMTH_COLUMN_GRANTS,
  WARMTH_GRANTS_ON_EARLIER,
  WARMTH_TABLE_GRANTS,
} from "../test-support/catalogue-grants.ts";
import { labelFixedColumnGrants, withoutLabelUpdates as onTable } from "../test-support/catalogue-labels.ts";
import { PROMOTION_TABLE_GRANTS } from "../test-support/catalogue-promotion.ts";
import {
  AREA_READER_COLUMNS,
  AREA_TABLE_GRANTS,
  isTimePassColumnGrant,
  TIME_PASS_COLUMN_GRANTS,
  TIME_PASS_CONDITIONS,
  TIME_PASS_TABLE_GRANTS,
} from "../test-support/catalogue-time.ts";
import {
  DECISION_COLUMN_GRANTS,
  DECISION_CONDITIONS,
  DECISION_GRANTS_ON_EARLIER,
  DECISION_TABLE_GRANTS,
  isSendColumnGrant,
  isWorkColumnGrant,
  RECORD_EVENTS_WORK_INSERT,
  SEND_CONDITIONS,
  SEND_GRANTS_ON_EARLIER,
  SEND_PROXY_COLUMNS,
  SEND_TABLE_GRANTS,
  SEND_WORK_COLUMNS_BUT,
  STATE_WAKE_GRANTS_ON_EARLIER,
  WORK_COLUMN_GRANTS,
  WORK_GRANTS_ON_EARLIER,
  WORK_READER_CONDITIONS,
  WORK_TABLE_GRANTS,
} from "../test-support/catalogue-work.ts";
import {
  ALL_TOOLS,
  ALL_VIEWS,
  insertClient,
  revokeClient,
  sha256Hex,
  type TestClient,
  TOOL_NAMES,
  testId,
} from "../test-support/clients.ts";
import {
  asOwner,
  one,
  type Query,
  readAs,
  refusal,
  session,
  sqlState,
  thrownBy,
  withToken,
} from "../test-support/connections.ts";
import { fingerprint, queryAs, scanForPlaintext, type TestDatabase } from "../test-support/database.ts";
import { ingestMail, type MailFixture, mailItem, mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { readerReadProbes, readerWriteProbes, writerPolicyProbes } from "../test-support/probes.ts";
import { seedBothCompartments, seeder } from "../test-support/seeder.ts";
import { opened } from "../test-support/snapshot.ts";
import { withDatabase, withStore } from "../test-support/store.ts";
import { tampering } from "../test-support/tamper.ts";
import { evidenceIdOf } from "../test-support/values.ts";

// The tests of a row for every message (the tool names' table, the hold's column, no unkeyed hash)
// are at the end.

const TIMEOUT = 180_000;
// The knowledge tables the reader has a policy on (KNOWLEDGE in test-support/catalogue-grants.ts): the owner surface's
// two knowledge tables are the owner's alone, and owner-database.db.test.ts refuses the reader each.

type Role =
  | "pi_admin"
  | "pi_writer"
  | "pi_reader"
  | "pi_pipeline"
  | "pi_owner"
  | "pi_work"
  | "pi_proxy"
  | "pi_restricted"
  | "pi_notify";
type Cell = "all" | "select" | "insert" | "update" | "delete";

const EXTRACTION_TABLE_GRANTS: Record<string, Partial<Record<Role, Cell[]>>> = {
  "vault.pipeline_items": {
    pi_admin: ["all"],
    pi_writer: ["select", "delete", "update"],
    pi_pipeline: ["select", "insert", "update"],
    pi_owner: ["select"],
  },
  "vault.model_calls": { pi_admin: ["all"], pi_writer: ["select", "delete"], pi_pipeline: ["select", "insert"] },
  "vault.model_usage": { pi_admin: ["all"], pi_pipeline: ["select", "insert"] },
  "vault.extraction_runs": { pi_admin: ["all"], pi_pipeline: ["select", "insert"] },
  "vault.unmapped_claims": {
    pi_admin: ["all"],
    pi_writer: ["select", "delete"],
    pi_pipeline: ["select", "insert", "delete"],
  },
  "vault.extraction_reviews": { pi_admin: ["all"], pi_writer: ["select", "delete"] },
  "knowledge.claims": {
    pi_admin: ["all"],
    pi_writer: ["select", "delete"],
    pi_pipeline: ["select", "insert", "delete"],
    pi_reader: ["select"],
  },
  "knowledge.claim_entities": {
    pi_admin: ["all"],
    pi_writer: ["select", "delete"],
    pi_pipeline: ["select", "insert", "delete"],
    pi_reader: ["select"],
  },
};

// And agent records': pi_owner, as the definer functions run, selects and inserts.
const AGENT_RECORD_TABLE_GRANTS: Record<string, Partial<Record<Role, Cell[]>>> = {
  "ledger.sessions": { pi_admin: ["select"], pi_owner: ["select", "insert"] },
  "ledger.read_log": { pi_admin: ["select"], pi_writer: ["select"], pi_owner: ["select", "insert"] },
  // The admin and the writer update some columns, and the reader reads eight.
  "ledger.agent_writes": {
    pi_admin: ["select", "update"],
    pi_writer: ["select", "update"],
    pi_reader: ["select"],
    pi_owner: ["select", "insert"],
    pi_pipeline: ["select", "update"],
  },
  // The per-client quota row append_record bumps: the admin reads it.
  "policy.record_quota": { pi_admin: ["select"], pi_owner: ["select", "insert", "update"] },
  // Context packs: the admin reads, policy.log_pack inserts.
  "ledger.context_packs": { pi_admin: ["select"], pi_owner: ["insert"] },
};

// The owner surface's five tables, and pi_owner_select on the nine core tables its functions read.
const OWNER_TABLES: Record<string, Partial<Record<Role, Cell[]>>> = {
  "knowledge.owner_decisions": { pi_admin: ["select", "insert"], pi_owner: ["select", "update"] },
  "knowledge.vetoes": { pi_admin: ["select", "insert", "update"], pi_owner: ["select"] },
  // pi_writer raises system:identity's cards at the end of a sync, and the pipeline sets a card's
  // match key once (a column grant).
  "ledger.cards": {
    pi_admin: ["select", "insert"],
    pi_owner: ["select", "update"],
    pi_pipeline: ["select", "insert", "update"],
    pi_writer: ["select", "insert"],
  },
  "ledger.record_events": {
    pi_admin: ["select", "insert"],
    pi_owner: ["select", "insert", "update"],
    pi_pipeline: ["select", "insert"],
    pi_writer: ["select", "insert"],
  },
  "ledger.basis": { pi_admin: ["select"], pi_owner: ["select", "insert", "update"] },
};
// The owner surface's erasure tables.
const ERASURE_TABLES: Record<string, Partial<Record<Role, Cell[]>>> = {
  "knowledge.erasures": { pi_admin: ["select", "insert", "update"], pi_owner: ["select"] },
  "knowledge.removed_evidence": { pi_admin: ["select", "insert", "delete"], pi_writer: ["select"] },
  "knowledge.suppressions": { pi_admin: ["select", "insert", "delete"], pi_writer: ["select"] },
};
// Drive's two.
const DRIVE_TABLE_GRANTS: Record<string, Partial<Record<Role, Cell[]>>> = {
  "policy.drive_roots": { pi_admin: ["all"], pi_writer: ["select"] },
  "knowledge.documents": { pi_admin: ["all"], pi_writer: ["all"], pi_reader: ["select"], pi_pipeline: ["select"] },
};
// Contacts and identity's ruling table: the admin writes rulings and lifts them by two columns, the
// writer and the owner (for policy.vetoed_by) read them, and the reader reads four columns of the
// rulings its clearance reaches.
const CONTACT_TABLES_GRANTS: Record<string, Partial<Record<Role, Cell[]>>> = {
  // pi_owner inserts a policy's same, for ledger.policy_merge, and lifts one, and no other ruling,
  // for ledger.split_wrong_merge.
  "knowledge.identity_rulings": {
    pi_admin: ["select", "insert", "update", "delete"],
    pi_writer: ["select"],
    pi_reader: ["select"],
    pi_owner: ["select", "insert", "update"],
  },
  // The owner's ignore list, the admin's and the owner's (for policy.entity_withheld); and the
  // writer's re-key of a live domain ruling.
  "knowledge.ignore_rulings": {
    pi_admin: ["select", "insert", "update", "delete"],
    pi_writer: ["select", "update"],
    pi_owner: ["select"],
  },
  // The owner's tier rulings, the admin's (the erasure hook's delete among them) and the owner's
  // (for policy.tier_rulings_in).
  "knowledge.tier_rulings": { pi_admin: ["select", "insert", "update", "delete"], pi_owner: ["select"] },
  // The owner's Remove's hide of a person's group, the admin's alone, lifted by two columns.
  "knowledge.person_hides": { pi_admin: ["select", "insert", "update", "delete"] },
  // The owner's lists of people, the admin's alone (the erasure hook's delete of a member row
  // among them); no agent role holds anything.
  "knowledge.owner_lists": { pi_admin: ["select", "insert", "update"] },
  "knowledge.owner_list_members": { pi_admin: ["select", "insert", "update", "delete"] },
  // A contact's clear columns and its sealed facts for the reader, never its sealed names or addresses.
  "knowledge.contacts": { pi_admin: ["all"], pi_writer: ["all"], pi_reader: ["select"] },
};
const RULING_TABLES: Record<string, Partial<Record<Role, Cell[]>>> = {
  // pi_owner updates both rulings tables: the definers that write a ruling's anchors run as it.
  "knowledge.belief_rulings": { pi_admin: ["select", "insert", "update"], pi_owner: ["select", "update"] },
  // The owner's joins and splits, the admin's, deleted only by the erasure hook.
  "knowledge.fact_rulings": { pi_admin: ["select", "insert", "update", "delete"], pi_owner: ["select", "update"] },
  // The owner's releases, the admin's, lifted once and never deleted but with their record; and
  // pi_owner inserts a standing grant's row, in policy.grant_release.
  "knowledge.claim_releases": { pi_admin: ["select", "insert", "update"], pi_owner: ["select", "insert"] },
  // Each journalled lift of a release, the admin's, never edited or deleted.
  "knowledge.release_lifts": { pi_admin: ["select", "insert"], pi_owner: ["select"] },
  "projections.declassified_facts": {
    pi_admin: ["select", "insert", "delete"],
    pi_reader: ["select"],
    pi_owner: ["select", "delete"],
  },
};
const OWNER_SELECT_ON = [
  "knowledge.messages",
  "knowledge.events",
  "knowledge.event_details",
  "knowledge.event_participants",
  "knowledge.interaction_log",
  "knowledge.accounts",
  "knowledge.domains",
  "knowledge.entities",
  "vault.evidence_items",
];

// Cells on earlier tables: the writer's claims made from a contact, the owner's read of the two
// contact tables for ledger.contact_candidates, and the writer's re-key of an organization's name.
const CONTACT_GRANTS_ON_EARLIER: Record<string, Partial<Record<Role, Cell[]>>> = {
  "knowledge.claims": { pi_writer: ["insert"] },
  "knowledge.claim_entities": { pi_writer: ["insert"] },
  "knowledge.contacts": { pi_owner: ["select"] },
  // The Pipeline reads a saved contact's person, restricted-blind, for triage's known
  // correspondent line; pi_restricted holds the same cell, as it holds each of pi_pipeline's.
  "knowledge.contact_addresses": { pi_owner: ["select"], pi_pipeline: ["select"], pi_restricted: ["select"] },
  "knowledge.organization_names": { pi_writer: ["select", "update"] },
  // The keyed replay's `facts:` rows, the Pipeline's and so the restricted worker's.
  "vault.decision_calls": { pi_pipeline: ["select", "insert"], pi_restricted: ["select", "insert"] },
};

function grantsOf(table: string): Partial<Record<Role, Cell[]>> {
  // The read log's columns the shadow sampler reads, with no restricted copy; the tick's clock
  // reads eight columns of a claim, restricted-blind; and policy.write_typed_claims inserts claims,
  // their entities, a typed record's evidence row and blob, and updates the record's evidence id
  // and reply, as pi_owner.
  const queryTimeOnEarlier: Partial<Record<Role, Cell[]>> =
    table === "ledger.read_log"
      ? { pi_pipeline: ["select"] }
      : table === "knowledge.claims"
        ? { pi_work: ["select"], pi_owner: ["insert"] }
        : table === "knowledge.claim_entities" || table === "vault.evidence_items"
          ? { pi_owner: ["insert"] }
          : table === "vault.evidence_blobs"
            ? { pi_owner: ["insert", "select"] }
            : table === "ledger.agent_writes"
              ? { pi_owner: ["update"] }
              : {};
  const grants = merged(
    merged(merged(baseGrantsOf(table), CONTACT_GRANTS_ON_EARLIER[table] ?? {}), NOTICE_GRANTS_ON_EARLIER[table] ?? {}),
    queryTimeOnEarlier,
  );
  if (table === "knowledge.entities") return { ...grants, pi_owner: [...(grants.pi_owner ?? []), "insert"] };
  if (table === "knowledge.projects") return { ...grants, pi_owner: [...(grants.pi_owner ?? []), "insert", "update"] };
  if (table === "knowledge.claims" || table === "knowledge.claim_entities")
    return { ...grants, pi_admin: ["select", "insert"], pi_owner: [...(grants.pi_owner ?? []), "delete"] };
  // The Pipeline's match key update on a card has no restricted copy.
  if (table === "ledger.cards" && grants.pi_restricted !== undefined)
    return { ...grants, pi_restricted: grants.pi_restricted.filter((cell) => cell !== "update") };
  return grants;
}

// The restricted worker's tables and the owner's one more cell, and on every table a pi_restricted cell for
// each of pi_pipeline's.
function baseGrantsOf(table: string): Partial<Record<Role, Cell[]>> {
  // The promotion gate and its intake: the admin's, and the reader's read of a taken claim.
  const promotion = PROMOTION_TABLE_GRANTS[table];
  if (promotion !== undefined) return promotion;
  // The planner's mission: pi_admin writes it, and the reader reads it for a reasoner.
  if (table === "projections.planner_mission") return { pi_admin: ["all"], pi_reader: ["select"] };
  // The owner's settings: pi_admin sets the zone, and the reader, the tick, the Pipeline (so
  // pi_restricted) and the writer, for a phone's region, read that column. pi_owner sets the go's
  // time once, by the claims' trigger, and pi_admin selects the row and updates the zone alone.
  if (table === "policy.owner_settings")
    return {
      pi_admin: ["select", "update"],
      pi_reader: ["select"],
      pi_work: ["select"],
      pi_pipeline: ["select"],
      pi_restricted: ["select"],
      pi_owner: ["select", "update"],
      pi_writer: ["select"],
    };
  // The labels in use, pi_owner's alone, with no grant to any runtime role.
  if (table === "policy.labels") return { pi_owner: ["all"] };
  // The owner's gap routes, pi_admin's for `pia work route`; pi_owner reads them for
  // ledger.raise_gap_flag.
  if (table === "policy.gap_routes") return { pi_admin: ["all"], pi_owner: ["select"] };
  // The daily time pass's tables: the Pipeline's cells have no copy for pi_restricted.
  const timePass = TIME_PASS_TABLE_GRANTS[table];
  if (timePass !== undefined) return timePass;
  // The coverage tables: the Pipeline's cell on its own job has no copy for pi_restricted.
  const coverage = COVERAGE_TABLE_GRANTS[table];
  if (coverage !== undefined) return coverage;
  // The work notice tables: no pi_pipeline cell either.
  const notice = NOTICE_TABLE_GRANTS[table];
  if (notice !== undefined) return notice;
  // Fact settlements: no restricted copy.
  const settlements = FEWER_CARDS_TABLE_GRANTS[table];
  if (settlements !== undefined) return settlements;
  // Commitment reopens: no restricted copy.
  const reopens = CLOSE_TABLE_GRANTS[table];
  if (reopens !== undefined) return reopens;
  // Goal proposals: pi_owner's for ledger.propose_goal and the taint; pi_admin reads them for
  // the owner's card. No reader, no restricted copy.
  if (table === "ledger.goal_proposals") return { pi_owner: ["all"], pi_admin: ["select"] };
  // Agent messages and improvements: pi_owner selects and inserts for the definer functions, and
  // updates the three labelled ones for the taint; pi_admin reads them. No reader, no delete.
  if (table === "ledger.agent_message_reads") return { pi_owner: ["select", "insert"], pi_admin: ["select"] };
  if (
    ["ledger.agent_messages", "ledger.improvements", "ledger.improvement_events", "ledger.agent_learnings"].includes(
      table,
    )
  )
    return { pi_owner: ["select", "insert", "update"], pi_admin: ["select"] };
  // The outcome test: pi_owner's for the definer functions and the taint of the two sealed; pi_admin reads.
  if (table === "ledger.outcome_test_runs") return { pi_owner: ["select", "insert"], pi_admin: ["select"] };
  if (["ledger.outcome_test_tasks", "ledger.held_out_questions"].includes(table))
    return { pi_owner: ["select", "insert", "update"], pi_admin: ["select"] };
  // What a filing pass read: pi_admin writes and reads it.
  if (table === "ledger.measure_readings") return { pi_owner: ["select"], pi_admin: ["select", "insert"] };
  // What a policy did with a card: the tick writes it, and what became of it is its events. The holds
  // are code's, through their definers; pi_admin lifts one.
  // The sweep's questions; agents read those they are cleared for and write answers through a definer;
  // the tick proposes rules and only the owner's admin moves one on.
  if (table === "ledger.identity_questions")
    return {
      pi_owner: ["all"],
      pi_admin: ["select", "insert", "update", "delete"],
      pi_writer: ["select", "insert", "update"],
      pi_reader: ["select"],
    };
  if (table === "ledger.identity_answers")
    return {
      pi_owner: ["all"],
      pi_admin: ["select", "update", "delete"],
      pi_writer: ["select", "update"],
      pi_reader: ["select"],
    };
  // An agent's answer on a card: written by its definer alone, read and marked by pi_admin.
  if (table === "ledger.card_answers") return { pi_owner: ["all"], pi_admin: ["select", "update"] };
  // An agent's ruling on a card: written by ledger.answer_card alone, read by pi_admin.
  if (table === "ledger.agent_rulings") return { pi_owner: ["all"], pi_admin: ["select"] };
  // A relayed answer: written by its definer alone; pi_admin reads it and marks what became of it.
  if (table === "ledger.card_relays") return { pi_owner: ["all"], pi_admin: ["select", "update"] };
  // An agent's report of a wrong merge: written by its definer alone; the sweep and the owner's
  // report read it, erasure deletes it, and a client reads its own.
  if (table === "ledger.wrong_merge_reports")
    return { pi_owner: ["all"], pi_admin: ["select", "delete"], pi_writer: ["select"], pi_reader: ["select"] };
  // An agent's report of a wrong relation: written by its definer alone; the switch job reads it as
  // the Pipeline and the restricted worker, erasure deletes it, and a client reads its own.
  if (table === "ledger.relation_reports")
    return {
      pi_owner: ["all"],
      pi_admin: ["select", "delete"],
      pi_pipeline: ["select"],
      pi_restricted: ["select"],
      pi_reader: ["select"],
    };
  if (table === "ledger.question_rules")
    return {
      pi_owner: ["all"],
      pi_admin: ["select", "update"],
      pi_work: ["select"],
      pi_writer: ["select"],
    };
  const r: Cell[] = ["select"];
  if (table === "policy.settings")
    return { pi_owner: ["all"], pi_admin: r, pi_work: r, pi_pipeline: r, pi_restricted: r };
  if (table === "policy.setting_changes") return { pi_owner: ["select", "insert"], pi_admin: ["select"] };
  // Session taint's counts: ledger.count_session_taint writes them as pi_owner; pi_admin reads.
  if (table === "ledger.session_taint_counts")
    return { pi_owner: ["select", "insert", "update"], pi_admin: ["select"] };
  if (table === "ledger.agent_spend")
    return { pi_owner: ["select", "insert"], pi_admin: ["select"], pi_work: ["select"] };
  // What agents wrote back, and what each client was told: pi_owner's for the definers; the reader
  // reads marks by label, and the feed through its function alone.
  if (table === "ledger.signal_marks") return { pi_owner: ["all"], pi_admin: ["select"], pi_reader: ["select"] };
  if (table === "ledger.work_dependencies")
    return { pi_owner: ["all"], pi_admin: ["select"], pi_work: ["select"], pi_reader: ["select"] };
  if (["ledger.change_log", "ledger.change_cursors", "ledger.ping_walks"].includes(table))
    return { pi_owner: ["all"], pi_admin: ["select"] };
  // Dreaming's tables, pi_restricted's cells named.
  const dream = DREAM_TABLE_GRANTS[table];
  if (dream !== undefined) return dream;
  // The query-time value rows and relations, pi_restricted's cells named.
  const queryTime = QUERY_TIME_TABLE_GRANTS[table];
  if (queryTime !== undefined) return queryTime;
  // A claim's name row and a named organization's names, pi_restricted's cell named.
  const namedOrgs = NAMED_ORG_TABLE_GRANTS[table];
  if (namedOrgs !== undefined) return namedOrgs;
  // The OAuth tables: pi_owner's, for the definer functions; pi_admin reads them, and inserts the
  // approvals. pi_reader holds nothing on any.
  if (table.startsWith("policy.oauth_"))
    return { pi_owner: ["all"], pi_admin: table === "policy.oauth_approvals" ? ["select", "insert"] : ["select"] };
  // The seal tables: no pi_pipeline cell, so no copy for pi_restricted.
  const forgetting = FORGETTING_TABLE_GRANTS[table];
  if (forgetting !== undefined) return forgetting;
  // Lens's mirror tables: no pi_pipeline cell either.
  const mirror = MIRROR_TABLE_GRANTS[table];
  if (mirror !== undefined) return mirror;
  // Organization names: the admin names and lifts, by two columns; the reader reads four columns of
  // a live name within its clearance. No other role.
  if (table === "knowledge.organization_names")
    return { pi_admin: ["select", "insert", "update"], pi_reader: ["select"] };
  if (table === "knowledge.person_names")
    return { pi_admin: ["select", "insert", "update", "delete"], pi_reader: ["select"] };
  // The restricted worker's tables (its migration adds no cell on earlier tables but
  // pi_restricted's); then the decide-model decision tables, and their cells on earlier tables.
  // Research's four, and its two cells on earlier tables. Lens's five, on which no earlier
  // migration grants anything, and vault.model_call_members, with vault.model_calls' cells. The two
  // warmth tables, and the pipeline's reads of five earlier ones, each with pi_restricted's copy
  // below.
  const cells =
    LENS_TABLE_GRANTS[table] ??
    MOMENT_CALL_TABLE_GRANTS[table] ??
    RESEARCH_TABLE_GRANTS[table] ??
    RESTRICTED_TABLE_GRANTS[table] ??
    WARMTH_TABLE_GRANTS[table] ??
    merged(
      merged(decisionGrantsOf(table), RESEARCH_GRANTS_ON_EARLIER[table] ?? {}),
      WARMTH_GRANTS_ON_EARLIER[table] ?? {},
    );
  return cells.pi_pipeline === undefined ? cells : { ...cells, pi_restricted: [...cells.pi_pipeline] };
}

function decisionGrantsOf(table: string): Partial<Record<Role, Cell[]>> {
  const decision = DECISION_TABLE_GRANTS[table];
  if (decision !== undefined) return decision;
  return merged(sendGrantsOf(table), DECISION_GRANTS_ON_EARLIER[table] ?? {});
}

function sendGrantsOf(table: string): Partial<Record<Role, Cell[]>> {
  // Exposures.
  const exposures = EXPOSURE_TABLE_GRANTS[table];
  if (exposures !== undefined) return exposures;
  // Mentions: no earlier migration grants anything on them.
  const mentions = MENTION_TABLE_GRANTS[table];
  if (mentions !== undefined) return mentions;
  // Contacts' and Drive's tables: no earlier migration grants anything on them.
  const contacts = CONTACT_TABLES_GRANTS[table];
  if (contacts !== undefined) return contacts;
  const drive = DRIVE_TABLE_GRANTS[table];
  // write_typed_claims reads a document as pi_owner, to refuse a claim that cites a held one.
  if (drive !== undefined) return table === "knowledge.documents" ? merged(drive, { pi_owner: ["select"] }) : drive;
  // Projects.
  const projects = PROJECT_TABLE_GRANTS[table];
  if (projects !== undefined) return projects;
  // Areas.
  const areas = AREA_TABLE_GRANTS[table];
  if (areas !== undefined) return areas;
  const memory = MEMORY_TABLE_GRANTS[table];
  if (memory !== undefined) return memory;
  // The learning item's five.
  const learning = LEARNING_TABLE_GRANTS[table];
  if (learning !== undefined) return learning;
  // The send proxy's tables, and what it adds on earlier tables.
  const send = SEND_TABLE_GRANTS[table];
  if (send !== undefined) return send;
  return merged(
    merged(workGrantsOf(table), SEND_GRANTS_ON_EARLIER[table] ?? {}),
    STATE_WAKE_GRANTS_ON_EARLIER[table] ?? {},
  );
}

const merged = (
  left: Partial<Record<Role, Cell[]>>,
  right: Partial<Record<Role, Cell[]>>,
): Partial<Record<Role, Cell[]>> =>
  Object.fromEntries(
    [...new Set([...Object.keys(left), ...Object.keys(right)])].map((role) => [
      role,
      [...(left[role as Role] ?? []), ...(right[role as Role] ?? [])],
    ]),
  ) as Partial<Record<Role, Cell[]>>;

function workGrantsOf(table: string): Partial<Record<Role, Cell[]>> {
  // Durable work's tables, and what it adds on earlier tables.
  const work = WORK_TABLE_GRANTS[table];
  if (work !== undefined) return work;
  return merged(earlierGrantsOf(table), WORK_GRANTS_ON_EARLIER[table] ?? {});
}

function earlierGrantsOf(table: string): Partial<Record<Role, Cell[]>> {
  const tables = OWNER_TABLES[table] ?? ERASURE_TABLES[table] ?? RULING_TABLES[table];
  if (tables !== undefined) return tables;
  const cells = coreGrantsOf(table);
  return OWNER_SELECT_ON.includes(table) ? { ...cells, pi_owner: [...(cells.pi_owner ?? []), "select"] } : cells;
}

function coreGrantsOf(table: string): Partial<Record<Role, Cell[]>> {
  const later = EXTRACTION_TABLE_GRANTS[table] ?? AGENT_RECORD_TABLE_GRANTS[table];
  if (later !== undefined) return later;
  if (table === "policy.migrations") return { pi_admin: ["select"], pi_owner: ["all"] };
  if (table === "policy.clients") return { pi_admin: ["all"], pi_owner: ["select"] };
  if (table === "policy.secrets") return { pi_admin: ["all"], pi_writer: ["select"], pi_pipeline: ["select"] };
  // pi_owner selects, for policy.read_allowance.
  if (table === "policy.calls") return { pi_admin: ["select"], pi_owner: ["select", "insert"] };
  if (table === "policy.tool_names") return { pi_admin: ["select"], pi_owner: ["insert", "select"] };
  if (table === "vault.evidence_items")
    return { pi_admin: ["all"], pi_writer: ["all"], pi_pipeline: ["select", "update"] };
  if (table === "vault.evidence_blobs") return { pi_admin: ["all"], pi_writer: ["all"], pi_pipeline: ["select"] };
  if (table.startsWith("vault.")) return { pi_admin: ["all"], pi_writer: ["all"] };
  if (["knowledge.entities", "knowledge.accounts", "knowledge.messages"].includes(table))
    return { pi_admin: ["all"], pi_writer: ["all"], pi_reader: ["select"], pi_pipeline: ["select"] };
  // The pipeline reads a domain row's fingerprint, entity and compartments, to resolve a domain
  // mention.
  if (table === "knowledge.domains")
    return { pi_admin: ["all"], pi_writer: ["all"], pi_reader: ["select"], pi_pipeline: ["select"] };
  return { pi_admin: ["all"], pi_writer: ["all"], pi_reader: ["select"] };
}

const PRIVILEGES: Record<Cell, string[]> = {
  all: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  select: ["SELECT"],
  insert: ["INSERT"],
  update: ["UPDATE"],
  delete: ["DELETE"],
};
// The privileges granted on columns, not on the table: the reader reads an entity's id and
// kind, and nothing else of it; the pipeline may update one column of an evidence row, which is
// what lets it lock one; and the writer resets one column of a status row.
// The Pipeline's column grants with no pi_restricted copy.
const GROUPING_PIPELINE_ONLY = [
  ...["knowledge.same_fact_judgments"].flatMap((table) =>
    ["band", "rung", "state", "calls", "card_id", "updated_at"].map(
      (column) => `${table} ${column} pi_pipeline UPDATE`,
    ),
  ),
  "policy.owner_settings grouping pi_pipeline SELECT",
];
const COLUMN_GRANTS = [
  "knowledge.entities id pi_reader SELECT",
  "knowledge.entities kind pi_reader SELECT",
  "vault.evidence_items media_type pi_pipeline UPDATE",
  "vault.pipeline_items extractor_generation pi_writer UPDATE",
  // The re-derive's carry of first-known times.
  "vault.pipeline_items first_known pi_writer UPDATE",
  // The admin's update of a veto's two lift columns, and nothing else of it.
  "knowledge.vetoes lift_ruling_id pi_admin UPDATE",
  "knowledge.vetoes lifted_at pi_admin UPDATE",
  // The admin's update of an erasure's two lift columns, and of an agent record's evidence id.
  "knowledge.erasures lift_seq pi_admin UPDATE",
  "knowledge.erasures lifted_at pi_admin UPDATE",
  "ledger.agent_writes evidence_id pi_admin UPDATE",
  "ledger.agent_writes id pi_reader SELECT",
  "ledger.agent_writes client_name pi_reader SELECT",
  "ledger.agent_writes kind pi_reader SELECT",
  "ledger.agent_writes created_at pi_reader SELECT",
  "ledger.agent_writes compartments pi_reader SELECT",
  "ledger.agent_writes writer_views pi_reader SELECT",
  // What a record supersedes, under the table's row policy.
  "ledger.agent_writes supersedes pi_reader SELECT",
  "ledger.agent_writes flagged_at pi_reader SELECT",
  "ledger.agent_writes body_enc pi_reader SELECT",
  "ledger.agent_writes body_enc pi_admin UPDATE",
  "ledger.agent_writes tainted_at pi_admin UPDATE",
  "ledger.agent_writes body_enc pi_writer UPDATE",
  "ledger.agent_writes evidence_id pi_writer UPDATE",
  "ledger.agent_writes refused_code pi_writer UPDATE",
  "ledger.agent_writes intake_tried_at pi_writer UPDATE",
  "ledger.agent_writes tainted_at pi_writer UPDATE",
  // The admin's update of a belief ruling's two lift columns, and the reader's seven columns of a
  // declassified fact.
  "knowledge.belief_rulings lift_ruling_id pi_admin UPDATE",
  "knowledge.belief_rulings lifted_at pi_admin UPDATE",
  // A join's or a split's lift, as a belief ruling's.
  "knowledge.fact_rulings lift_ruling_id pi_admin UPDATE",
  "knowledge.fact_rulings lifted_at pi_admin UPDATE",
  // A release's lift, as a belief ruling's.
  "knowledge.claim_releases lift_ruling_id pi_admin UPDATE",
  "knowledge.claim_releases lifted_at pi_admin UPDATE",
  // A promotion's revoke, sent or taken, and the erased claim ids an erasure replaces in it.
  "ledger.promotions claim_ids pi_admin UPDATE",
  "ledger.promotions revoked_at pi_admin UPDATE",
  "projections.declassified_facts id pi_reader SELECT",
  "projections.declassified_facts claim_fp pi_reader SELECT",
  "projections.declassified_facts evidence_id pi_reader SELECT",
  "projections.declassified_facts type pi_reader SELECT",
  "projections.declassified_facts valid_from pi_reader SELECT",
  "projections.declassified_facts compartments pi_reader SELECT",
  "projections.declassified_facts fact_enc pi_reader SELECT",
  // pi_work's reads of the columns the tick needs, and the reader's five columns of a move.
  ...WORK_COLUMN_GRANTS,
  // pi_proxy's reads of a card, an account and an evidence row by column. pi_work's of a
  // draft and a gate row are every column but one, read from the catalogue in the test.
  ...Object.entries(SEND_PROXY_COLUMNS).flatMap(([table, columns]) =>
    columns.map((column) => `${table} ${column} pi_proxy SELECT`),
  ),
  // The reader's one more column of an agent record, the pipeline's three and its one update, and
  // the pipeline's events of its own cards, every column but body_enc.
  "ledger.agent_writes evidence_id pi_reader SELECT",
  "ledger.agent_writes id pi_pipeline SELECT",
  "ledger.agent_writes evidence_id pi_pipeline SELECT",
  "ledger.agent_writes flagged_at pi_pipeline SELECT",
  "ledger.agent_writes flagged_at pi_pipeline UPDATE",
  ...["id", "row_kind", "row_id", "event", "at", "by", "tainted_at", "compartments"].map(
    (column) => `ledger.record_events ${column} pi_pipeline SELECT`,
  ),
  // The writer's events of system:identity's cards, the same columns.
  ...["id", "row_kind", "row_id", "event", "at", "by", "tainted_at", "compartments"].map(
    (column) => `ledger.record_events ${column} pi_writer SELECT`,
  ),
  // A domain row's four clear columns for the pipeline, never domain_enc.
  ...["id", "domain_fp", "entity_id", "compartments"].map((column) => `knowledge.domains ${column} pi_pipeline SELECT`),
  // Contacts: the admin's lift of a ruling, and the reader's four columns of one.
  "knowledge.identity_rulings lifted_at pi_admin UPDATE",
  "knowledge.identity_rulings lift_ruling_id pi_admin UPDATE",
  // The admin's lift of an ignore ruling.
  "knowledge.ignore_rulings lifted_at pi_admin UPDATE",
  "knowledge.ignore_rulings lift_ruling_id pi_admin UPDATE",
  // The admin's lift of a tier ruling.
  "knowledge.tier_rulings lifted_at pi_admin UPDATE",
  "knowledge.tier_rulings lift_ruling_id pi_admin UPDATE",
  // The admin's lift of the owner's ruling on a goal's key.
  "knowledge.goal_key_rulings lifted_at pi_admin UPDATE",
  "knowledge.goal_key_rulings lift_ruling_id pi_admin UPDATE",
  // A Remove's hide is lifted by its two columns.
  "knowledge.person_hides lifted_at pi_admin UPDATE",
  "knowledge.person_hides lift_ruling_id pi_admin UPDATE",
  "knowledge.person_hides entity_ids pi_admin UPDATE",
  // The admin's rename and delete of a list, and removal of a member.
  ...["name_enc", "named_by", "deleted_at", "delete_ruling_id"].map(
    (column) => `knowledge.owner_lists ${column} pi_admin UPDATE`,
  ),
  "knowledge.owner_list_members removed_at pi_admin UPDATE",
  "knowledge.owner_list_members remove_ruling_id pi_admin UPDATE",
  // The re-key of a domain ruling, by the admin's re-derive and the writer's, which reads five
  // columns of one; and its narrowing to addresses, which the admin's erasure hook also updates.
  "knowledge.ignore_rulings value_fps pi_admin UPDATE",
  "knowledge.ignore_rulings value_fps pi_writer UPDATE",
  "knowledge.ignore_rulings address_fps pi_admin UPDATE",
  "knowledge.ignore_rulings address_fps pi_writer UPDATE",
  ...["ruling_id", "subject", "value_fps", "address_fps", "lifted_at"].map(
    (column) => `knowledge.ignore_rulings ${column} pi_writer SELECT`,
  ),
  ...["verdict", "a_fp", "b_fp", "lifted_at"].map((column) => `knowledge.identity_rulings ${column} pi_reader SELECT`),
  ...["id", "evidence_id", "account_id", "source_contact_fp", "updated_at", "facts_enc", "compartments"].map(
    (column) => `knowledge.contacts ${column} pi_reader SELECT`,
  ),
  // The admin's lift of an organization's name, and the reader's four columns of one.
  "knowledge.organization_names lifted_at pi_admin UPDATE",
  "knowledge.organization_names lift_ruling_id pi_admin UPDATE",
  ...["id", "domain_fp", "name_enc", "compartments"].map(
    (column) => `knowledge.organization_names ${column} pi_reader SELECT`,
  ),
  // The re-key of a name, by the admin's re-derive and the writer's, which reads four columns of a
  // live one.
  "knowledge.organization_names domain_fp pi_admin UPDATE",
  "knowledge.organization_names domain_fp pi_writer UPDATE",
  ...["id", "domain_fp", "created_at", "lifted_at"].map(
    (column) => `knowledge.organization_names ${column} pi_writer SELECT`,
  ),
  // The binding step opens the owner's name to match a name.
  ...["name_enc", "compartments"].map((column) => `knowledge.organization_names ${column} pi_writer SELECT`),
  // The admin's lift of the owner's name for a person, and the reader's five columns of one.
  "knowledge.person_names lifted_at pi_admin UPDATE",
  "knowledge.person_names lift_ruling_id pi_admin UPDATE",
  "knowledge.person_names entity_ids pi_admin UPDATE",
  "knowledge.person_names value_fps pi_admin UPDATE",
  ...["id", "entity_ids", "value_fps", "name_enc", "compartments", "lifted_at"].map(
    (column) => `knowledge.person_names ${column} pi_reader SELECT`,
  ),
  // The admin's update of a finding's flag.
  ...DECISION_COLUMN_GRANTS,
  // The writer's seven columns of a memory projection, and the two column updates of its tables.
  ...MEMORY_COLUMN_GRANTS,
  ...PROJECT_READER_COLUMNS.map((column) => `knowledge.projects ${column} pi_reader SELECT`),
  ...["created_at", "updated_at", "created_by", "owner_role", "goal_id", "due_at"].map(
    (column) => `knowledge.projects ${column} pi_reader SELECT`,
  ),
  "knowledge.projects area_id pi_reader SELECT",
  ...AREA_READER_COLUMNS.map((column) => `knowledge.areas ${column} pi_reader SELECT`),
  // The reader's seven columns of an anchor.
  ...PROJECT_ANCHOR_READER_COLUMNS.map((column) => `knowledge.project_anchors ${column} pi_reader SELECT`),
  // The admin's update of a seal's two lift columns.
  ...FORGETTING_COLUMN_GRANTS,
  // The reader's one column of the owner's settings.
  "policy.owner_settings time_zone pi_reader SELECT",
  // The tick's and the Pipeline's (and so pi_restricted's) of the same column.
  "policy.owner_settings time_zone pi_work SELECT",
  "policy.owner_settings time_zone pi_pipeline SELECT",
  // The writer's, for a national phone number's region.
  "policy.owner_settings time_zone pi_writer SELECT",
  // The Pipeline's (and so pi_restricted's) of the go's time.
  "policy.owner_settings fact_key_v2_at pi_pipeline SELECT",
  // pi_admin's one column, the zone `pi owner timezone` sets.
  "policy.owner_settings time_zone pi_admin UPDATE",
  // Grouping's mode, the Pipeline reads and pi_admin sets; and the six columns of a pair the sweep
  // moves, on the stored grouping and on its judgment. None is pi_restricted's: the restricted
  // worker runs no sweep.
  ...GROUPING_PIPELINE_ONLY,
  "policy.owner_settings grouping pi_admin UPDATE",
];
// The writer's one column, and pi_restricted's copy of each of pi_pipeline's but the sweep's.
const ALL_COLUMN_GRANTS = [
  "knowledge.identity_rulings lifted_by_deletion pi_admin UPDATE",
  // What became of a relayed answer: never its option or its quote.
  ...["ruling_id", "applied_at", "failed_code", "reopened_at", "reopen_request", "reopen_left"].map(
    (column) => `ledger.card_relays ${column} pi_admin UPDATE`,
  ),
  // The owner's mark on a settled card of the week's sample: never the answer.
  "ledger.card_answers owner_mark pi_admin UPDATE",
  "ledger.card_answers marked_at pi_admin UPDATE",
  // What moves of a same-person question, and of a rule; never who or what the row is about.
  ...[
    "evidence_fp",
    "exception",
    "pattern",
    "state",
    "batch",
    "offers",
    "settled_by",
    "passed_code",
    "card_id",
    "updated_at",
    "compartments",
  ].flatMap((column) => [
    `ledger.identity_questions ${column} pi_admin UPDATE`,
    `ledger.identity_questions ${column} pi_writer UPDATE`,
  ]),
  ...["status", "decided_at", "lifted_at"].map((column) => `ledger.question_rules ${column} pi_admin UPDATE`),
  "ledger.identity_answers applied_at pi_admin UPDATE",
  "ledger.identity_answers ruling_id pi_admin UPDATE",
  "ledger.identity_answers refused_code pi_admin UPDATE",
  "ledger.identity_answers applied_at pi_writer UPDATE",
  "ledger.identity_answers ruling_id pi_writer UPDATE",
  "ledger.identity_answers refused_code pi_writer UPDATE",
  ...COLUMN_GRANTS,
  ...RESTRICTED_COLUMN_GRANTS,
  ...RESEARCH_COLUMN_GRANTS,
  ...LENS_COLUMN_GRANTS,
  ...COVERAGE_COLUMN_GRANTS,
  ...TIME_PASS_COLUMN_GRANTS,
  ...NOTICE_COLUMN_GRANTS,
  ...FEWER_CARDS_COLUMN_GRANTS,
  ...WARMTH_COLUMN_GRANTS,
  ...CLOSE_COLUMN_GRANTS,
  ...LASTING_KNOWLEDGE_COLUMN_GRANTS,
  // A belief's inputs: no restricted copy.
  ...BELIEF_INPUTS_COLUMN_GRANTS,
  // The clock's columns of a claim, and the tick's raised mark.
  ...TRIGGER_WORK_CLAIM_COLUMNS.map((column) => `knowledge.claims ${column} pi_work SELECT`),
  "ledger.trigger_log raised_at pi_work UPDATE",
  // The Pipeline's columns of an expectation and a watch, and pi_restricted's copy.
  ...OUTCOME_COLUMN_GRANTS,
  // A settlement's lift and a dream merge candidate's state, pi_admin's.
  ...DREAM_COLUMN_GRANTS,
  ...[...COLUMN_GRANTS, ...RESTRICTED_COLUMN_GRANTS]
    .filter((grant) => grant.includes(" pi_pipeline ") && !GROUPING_PIPELINE_ONLY.includes(grant))
    .map((grant) => grant.replace(" pi_pipeline ", " pi_restricted ")),
];
const isColumnGrant = (table: string, role: string, cell: Cell): boolean =>
  (["ledger.identity_answers", "ledger.identity_questions", "ledger.question_rules"].includes(table) &&
    cell === "update") ||
  (role === "pi_restricted" && isColumnGrant(table, "pi_pipeline", cell)) ||
  (table === "vault.restriction_requests" && role === "pi_writer" && cell === "update") ||
  (table === "vault.restrict_screens" && role === "pi_pipeline" && cell === "update") ||
  (table === "knowledge.entities" && role === "pi_reader") ||
  (table === "vault.evidence_items" && role === "pi_pipeline" && cell === "update") ||
  (table === "vault.pipeline_items" && role === "pi_writer" && cell === "update") ||
  (table === "knowledge.vetoes" && role === "pi_admin" && cell === "update") ||
  (table === "knowledge.erasures" && role === "pi_admin" && cell === "update") ||
  (table === "knowledge.seals" && role === "pi_admin" && cell === "update") ||
  (table === "knowledge.belief_rulings" && role === "pi_admin" && cell === "update") ||
  (table === "knowledge.goal_key_rulings" && role === "pi_admin" && cell === "update") ||
  (table === "knowledge.fact_rulings" && role === "pi_admin" && cell === "update") ||
  (table === "knowledge.claim_releases" && role === "pi_admin" && cell === "update") ||
  (table === "ledger.promotions" && role === "pi_admin" && cell === "update") ||
  (table === "knowledge.same_fact_judgments" && role === "pi_pipeline" && cell === "update") ||
  (table === "projections.declassified_facts" && role === "pi_reader" && cell === "select") ||
  (table === "ledger.agent_writes" &&
    (((role === "pi_reader" || role === "pi_pipeline") && cell === "select") || cell === "update")) ||
  isWorkColumnGrant(table, role, cell) ||
  isSendColumnGrant(table, role, cell) ||
  (table === "ledger.point_verdicts" && role === "pi_admin" && cell === "update") ||
  (table === "ledger.record_events" && (role === "pi_pipeline" || role === "pi_writer") && cell === "select") ||
  (table === "knowledge.domains" && role === "pi_pipeline" && cell === "select") ||
  (table === "knowledge.identity_rulings" &&
    ((role === "pi_admin" && cell === "update") || (role === "pi_reader" && cell === "select"))) ||
  (table === "knowledge.ignore_rulings" && ((role === "pi_admin" && cell === "update") || role === "pi_writer")) ||
  (table === "knowledge.tier_rulings" && role === "pi_admin" && cell === "update") ||
  (table === "knowledge.person_hides" && role === "pi_admin" && cell === "update") ||
  ((table === "knowledge.owner_lists" || table === "knowledge.owner_list_members") &&
    role === "pi_admin" &&
    cell === "update") ||
  (table === "knowledge.organization_names" &&
    ((role === "pi_admin" && cell === "update") ||
      (role === "pi_reader" && cell === "select") ||
      role === "pi_writer")) ||
  (table === "knowledge.person_names" &&
    ((role === "pi_admin" && cell === "update") || (role === "pi_reader" && cell === "select"))) ||
  (table === "knowledge.contacts" && role === "pi_reader" && cell === "select") ||
  isMemoryColumnGrant(table, role, cell) ||
  ((table === "knowledge.projects" || table === "knowledge.project_anchors" || table === "knowledge.areas") &&
    role === "pi_reader" &&
    cell === "select") ||
  ((table === "knowledge.pages" || table === "policy.research_settings" || table === "policy.owner_settings") &&
    role === "pi_reader" &&
    cell === "select") ||
  (table === "policy.owner_settings" &&
    (((role === "pi_work" || role === "pi_pipeline" || role === "pi_writer") && cell === "select") ||
      (role === "pi_admin" && cell === "update"))) ||
  (table === "ledger.research_fetches" && role === "pi_admin" && cell === "update") ||
  (table === "ledger.card_relays" && role === "pi_admin" && cell === "update") ||
  (table === "ledger.card_answers" && role === "pi_admin" && cell === "update") ||
  isLensColumnGrant(table, role, cell) ||
  isCoverageColumnGrant(table, role, cell) ||
  isTimePassColumnGrant(table, role, cell) ||
  isNoticeColumnGrant(table, role, cell) ||
  isFewerCardsColumnGrant(table, role, cell) ||
  isWarmthColumnGrant(table, role, cell) ||
  (role !== "pi_restricted" && isBeliefInputsColumnGrant(table, role, cell)) ||
  (table === "knowledge.claims" && role === "pi_work" && cell === "select") ||
  (table === "ledger.trigger_log" && role === "pi_work" && cell === "update") ||
  isOutcomeColumnGrant(table, role, cell) ||
  isDreamColumnGrant(table, role, cell);
// The policies whose condition is not `true`, beyond the reader's, which read the clearance.
const CONDITIONS: Record<string, { qual: string | null; check: string | null }> = {
  "knowledge.identity_rulings pi_owner_update": {
    qual: "(EXISTS ( SELECT 1\n   FROM knowledge.owner_decisions d\n  WHERE ((d.id = identity_rulings.ruling_id) AND (d.kind = 'identity_policy'::text))))",
    check:
      "((lifted_at IS NOT NULL) AND (lifted_by_deletion OR (EXISTS ( SELECT 1\n   FROM knowledge.owner_decisions d\n  WHERE ((d.id = identity_rulings.lift_ruling_id) AND (d.kind = 'identity_policy'::text))))))",
  },
  "knowledge.entities pi_owner_insert": { qual: null, check: "(kind = 'project'::text)" },
  // The meter's rows hold no restricted one.
  "ledger.surfaced_items pi_admin_select": { qual: "(NOT policy.is_restricted(compartments))", check: null },
  "ledger.surfaced_items pi_admin_insert": { qual: null, check: "(NOT policy.is_restricted(compartments))" },
  "ledger.recall_checks pi_admin_select": { qual: "(NOT policy.is_restricted(compartments))", check: null },
  "ledger.recall_checks pi_pipeline_select": { qual: "(NOT policy.is_restricted(compartments))", check: null },
  "ledger.recall_checks pi_pipeline_insert": { qual: null, check: "(NOT policy.is_restricted(compartments))" },
  // The tick never writes an owner's no with a reason.
  "ledger.record_events pi_work_insert": { qual: null, check: RECORD_EVENTS_WORK_INSERT },
  // The clock reads no restricted claim, and writes only its own rechecks.
  "knowledge.claims pi_work_select": { qual: "(NOT policy.is_restricted(compartments))", check: null },
  "ledger.trigger_rechecks pi_work_insert": {
    qual: null,
    check: "((cause = 'due'::text) AND (NOT policy.is_restricted(compartments)))",
  },
  // The erasure hook's recheck names nothing, so no row names an erased claim, and is never under a
  // restricted label.
  "ledger.trigger_rechecks pi_admin_insert": {
    qual: null,
    check: "((cause = 'erasure'::text) AND (NOT policy.is_restricted(compartments)))",
  },
  "ledger.trigger_log pi_work_select": { qual: "(NOT policy.is_restricted(compartments))", check: null },
  "ledger.trigger_log pi_work_update": {
    qual: "(NOT policy.is_restricted(compartments))",
    check: "(NOT policy.is_restricted(compartments))",
  },
  // The tick reads no restricted goal id row.
  "knowledge.goal_ids pi_work_select": { qual: "(NOT policy.is_restricted(compartments))", check: null },
  // As goal_ids; and a lift is set once.
  "knowledge.goal_key_rulings pi_work_select": { qual: "(NOT policy.is_restricted(compartments))", check: null },
  "knowledge.goal_key_rulings pi_admin_update": { qual: "(lifted_at IS NULL)", check: "(lifted_at IS NOT NULL)" },
  // The Pipeline writes a model's check alone; pi_admin reads no restricted check and writes the
  // owner's audit answers alone.
  "ledger.source_checks pi_pipeline_insert": { qual: null, check: "starts_with(judge, 'model:'::text)" },
  "ledger.source_checks pi_admin_select": { qual: "(NOT policy.is_restricted(compartments))", check: null },
  "ledger.source_checks pi_admin_insert": { qual: null, check: "starts_with(judge, 'owner:'::text)" },
  ...DREAM_CONDITIONS,
  "policy.secrets pi_writer_select": { qual: "starts_with(name, 'google/'::text)", check: null },
  "policy.secrets pi_pipeline_select": { qual: "starts_with(name, 'openrouter/'::text)", check: null },
  "vault.evidence_items pi_pipeline_update": { qual: "true", check: "false" },
  // Lens: `pi erase settle` updates a forget's row alone.
  "ledger.capture_inbox pi_admin_update": { qual: "(kind = 'forget'::text)", check: "(kind = 'forget'::text)" },
  // A ruling's lift is set once, so the rulings mark never falls.
  "knowledge.belief_rulings pi_admin_update": { qual: "(lifted_at IS NULL)", check: "(lifted_at IS NOT NULL)" },
  "knowledge.fact_rulings pi_admin_update": { qual: "(lifted_at IS NULL)", check: "(lifted_at IS NOT NULL)" },
  "knowledge.claim_releases pi_admin_update": { qual: "(lifted_at IS NULL)", check: "(lifted_at IS NOT NULL)" },
  // policy.grant_release, as pi_owner, inserts a standing grant's row alone.
  "knowledge.claim_releases pi_owner_insert": { qual: null, check: "(via = 'grant'::text)" },
  // The pipeline's own agent_claim cards and their events, and a flag it can only set.
  ...PIPELINE_LEDGER_CONDITIONS,
  // The writer's system:identity cards and their events.
  ...WRITER_LEDGER_CONDITIONS,
  // The pair rows of vault.decision_calls.
  ...DECISION_CONDITIONS,
  // The coverage tables: each job's role inserts its own job's runs.
  ...COVERAGE_CONDITIONS,
  ...TIME_PASS_CONDITIONS,
  ...FEWER_CARDS_CONDITIONS,
  ...CLOSE_CONDITIONS,
  ...LASTING_KNOWLEDGE_CONDITIONS,
  // Research: the one switch the reader reads, and the one card kind file_research raises.
  "policy.research_settings pi_reader_select": { qual: "true", check: null },
  // The owner's settings: one row, the same for every client.
  "policy.owner_settings pi_reader_select": { qual: "true", check: null },
  // The writer reads and re-keys a live domain ignore ruling alone.
  "knowledge.ignore_rulings pi_writer_select": { qual: "(lifted_at IS NULL)", check: null },
  "knowledge.ignore_rulings pi_writer_update": {
    qual: "((lifted_at IS NULL) AND (subject = 'domain'::text))",
    check: "((lifted_at IS NULL) AND (subject = 'domain'::text))",
  },
  // And ledger.propose_goal's goal_proposal card.
  "ledger.cards pi_owner_insert": {
    qual: null,
    check: "(kind = ANY (ARRAY['research_request'::text, 'goal_proposal'::text]))",
  },
  // The writer inserts a code binding alone, with no ruling and not lifted.
  "knowledge.mention_bindings pi_writer_insert": {
    qual: null,
    check: "((origin = 'code'::text) AND (ruling_id IS NULL) AND (lifted_at IS NULL))",
  },
  // A live code binding of a source moment alone.
  "knowledge.mention_bindings pi_writer_delete": {
    qual: "((origin = 'code'::text) AND (lifted_at IS NULL) AND (EXISTS ( SELECT 1\n   FROM knowledge.captures c\n  WHERE ((c.evidence_id = mention_bindings.evidence_id) AND (c.source IS NOT NULL)))))",
    check: null,
  },
  // The writer inserts only the claims of a contact's evidence.
  "knowledge.claims pi_writer_insert": {
    qual: null,
    check:
      "(EXISTS ( SELECT 1\n   FROM vault.evidence_items e\n  WHERE ((e.id = claims.evidence_id) AND (e.source_kind = 'crm'::text))))",
  },
  // And a note's link, put back by a re-derive.
  "knowledge.claim_org_names pi_writer_insert": {
    qual: null,
    check:
      "(EXISTS ( SELECT 1\n   FROM (knowledge.claims c\n     JOIN vault.evidence_items e ON ((e.id = c.evidence_id)))\n  WHERE ((c.id = claim_org_names.claim_id) AND (e.source_kind = 'crm'::text))))",
  },
  "knowledge.claim_org_names pi_admin_insert": {
    qual: null,
    check:
      "(EXISTS ( SELECT 1\n   FROM (knowledge.claims c\n     JOIN vault.evidence_items e ON ((e.id = c.evidence_id)))\n  WHERE ((c.id = claim_org_names.claim_id) AND (e.source_kind = 'crm'::text))))",
  },
  "knowledge.claim_entities pi_writer_insert": {
    qual: null,
    check:
      "(EXISTS ( SELECT 1\n   FROM (knowledge.claims c\n     JOIN vault.evidence_items e ON ((e.id = c.evidence_id)))\n  WHERE ((c.id = claim_entities.claim_id) AND ((e.source_kind = 'crm'::text) OR ((e.source_kind = 'owner_command'::text) AND (c.type = 'owner_note'::text))))))",
  },
  // The writer reads and re-keys a live organization name alone.
  "knowledge.organization_names pi_writer_select": { qual: "(lifted_at IS NULL)", check: null },
  "knowledge.organization_names pi_writer_update": { qual: "(lifted_at IS NULL)", check: "(lifted_at IS NULL)" },
};
const urlOf = (db: TestDatabase, role: (typeof RUNTIME_ROLES)[number]): string =>
  role === "pi_admin"
    ? db.urls.admin
    : role === "pi_writer"
      ? db.urls.writer
      : role === "pi_pipeline"
        ? db.urls.pipeline
        : role === "pi_work"
          ? db.urls.work
          : role === "pi_proxy"
            ? db.urls.proxy
            : role === "pi_restricted"
              ? db.urls.restricted
              : db.urls.reader;

// How many rows of each knowledge table one transaction under a token sees.
async function visible(db: TestDatabase, token: string | null): Promise<Record<string, number>> {
  return readAs(db, token, async (query) => {
    const counts: Record<string, number> = {};
    // Each count names a column: the reader holds `knowledge.entities` by column only.
    for (const table of KNOWLEDGE)
      counts[table.name] = one(
        await query<{ n: number }>(`select count(${table.column})::int as n from ${table.name}`),
      ).n;
    return counts;
  });
}

const nothing = Object.fromEntries(KNOWLEDGE.map((table) => [table.name, 0]));

// `not held`, as the catalogue prints a policy's condition, parenthesized or not.
const HIDES_HELD = /\bnot\s*\(*\s*((messages|documents)\.)?held\b/i;

const entitiesSeen = async (db: TestDatabase, client: TestClient): Promise<string[]> =>
  (await readAs(db, client.token, (query) => query<{ id: string }>("select id from knowledge.entities")))
    .map((row) => row.id)
    .sort();

const logCall = (query: Query, tool: string, rows: number, outcome: string): Promise<unknown> =>
  query("select policy.log_call($1::text, $2::integer, $3::text)", [tool, rows, outcome]);

// Hand-written messages for the message tests at the end of this file, on reserved domains.

// Received under `own`, with a text of two lines.
const WITH_TEXT: MailFixture = {
  id: "gm-f3-text-0001",
  threadId: "thread-f3-text-0001",
  messageId: "f3-text-0001@lighthouse.test",
  at: "2026-09-10T09:00:00Z",
  from: QUENTIN,
  to: [{ address: OWNER.personal }],
  subject: "The lamp oil order",
  labels: ["INBOX"],
  text: "The lamp oil order went out on Tuesday.\nIt should reach the quay by Friday.",
};

// Sent by the owner, with the canary body and, under it, a quoted reply: the shared body hash
// drops the quoted lines, so it is not the plain hash of the text.
const SENT_WITH_CANARY_BODY: MailFixture = {
  id: "gm-f3-sent-0002",
  threadId: "thread-f3-text-0001",
  messageId: "f3-sent-0002@hearth-canary.test",
  at: "2026-09-10T10:00:00Z",
  from: { address: OWNER.personal, name: OWNER.name },
  to: [QUENTIN],
  subject: "Re: The lamp oil order",
  labels: ["SENT"],
  text: `${CANARIES.bodyText}\n\nOn Tuesday the keeper wrote:\n> The lamp oil order went out on Tuesday.\n`,
};

// Received under the employer's compartment.
const WORK_WITH_TEXT: MailFixture = {
  id: "gm-f3-work-0003",
  threadId: "thread-f3-work-0003",
  messageId: "f3-work-0003@partner-example.test",
  at: "2026-09-10T11:00:00Z",
  from: { address: "wren@partner-example.test", name: "Wren Partnerfield" },
  to: [{ address: OWNER.work }],
  subject: "Partner notes, with a body",
  labels: ["INBOX"],
  text: "The partner notes are attached to the minutes of the last sync.",
};

// A message whose body could not be read: no text, two attachments.
const UNREADABLE: MailFixture = {
  id: "gm-f3-unreadable-0004",
  threadId: "thread-f3-unreadable-0004",
  messageId: "f3-unreadable-0004@lighthouse.test",
  at: "2026-09-10T12:00:00Z",
  from: QUENTIN,
  to: [{ address: OWNER.personal }],
  subject: "Too large to read",
  labels: ["INBOX"],
  unreadable: true,
  attachments: [
    { name: "rota-september.pdf", type: "application/pdf", size: 120_044 },
    { name: "", type: "image/png", size: 0 },
  ],
};

describe("the personal database", { timeout: TIMEOUT }, () => {
  it("row-level security is enabled and forced on every table", () =>
    withDatabase(async (db) => {
      const tables = await queryAs<{ name: string; enabled: boolean; forced: boolean }>(
        db.urls.admin,
        `select n.nspname || '.' || c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r', 'p') and n.nspname = any($1) order by 1`,
        [SCHEMAS],
      );
      expect(tables.map((table) => table.name).sort()).toEqual(TABLES.map((table) => table.name).sort());
      for (const table of tables) expect(table, table.name).toMatchObject({ enabled: true, forced: true });

      // Exactly the policies of the grants table: table, policy name, role and command.
      const policies = await queryAs<{
        table: string;
        name: string;
        roles: string[];
        cmd: string;
        permissive: string;
        qual: string | null;
        check: string | null;
      }>(
        db.urls.admin,
        `select schemaname || '.' || tablename as "table", policyname as name, roles::text[] as roles, cmd, permissive, qual, with_check as "check"
         from pg_policies where schemaname = any($1)`,
        [SCHEMAS],
      );
      const expectedPolicies: string[] = [];
      const expectedPrivileges: string[] = [];
      for (const table of TABLES) {
        for (const [role, cells] of Object.entries(grantsOf(table.name))) {
          for (const cell of cells) {
            expectedPolicies.push(`${table.name} ${role}_${cell} ${role} ${cell.toUpperCase()}`);
            if (role === "pi_owner" || isColumnGrant(table.name, role, cell)) continue;
            for (const privilege of PRIVILEGES[cell]) expectedPrivileges.push(`${table.name} ${role} ${privilege}`);
          }
        }
      }
      expect(
        policies.map((policy) => `${policy.table} ${policy.name} ${policy.roles.join(",")} ${policy.cmd}`).sort(),
      ).toEqual(expectedPolicies.sort());

      // The tables with a label, whose pi_pipeline policies leave out every restricted row.
      const labelled = new Set(
        (
          await queryAs<{ name: string }>(
            db.urls.admin,
            "select table_schema || '.' || table_name as name from information_schema.columns where column_name = 'compartments' and table_schema = any($1)",
            [SCHEMAS],
          )
        ).map((row) => row.name),
      );
      expect(labelled.has("knowledge.claims") && !labelled.has("policy.secrets")).toBe(true);

      // Each is permissive and unconditional, except the reader's, which reads the clearance
      // once per query.
      for (const policy of policies) {
        const label = `${policy.table} ${policy.name}`;
        expect(policy.permissive, label).toBe("PERMISSIVE");
        // A pi_pipeline policy on a table with a label keeps its condition and leaves out every
        // restricted row, in each half it has; pi_restricted's copy keeps the same condition and
        // reads or writes only a restricted row (of `audience` on the tables built per audience).
        if (policy.roles.includes("pi_pipeline") || policy.roles.includes("pi_restricted")) {
          const pipeline = `${policy.table} ${policy.name.replace(/^pi_restricted_/, "pi_pipeline_")}`;
          // A pi_restricted policy the restricted migration made and left has its own entry.
          const before = CONDITIONS[label] ??
            CONDITIONS[pipeline] ?? {
              qual: policy.cmd === "INSERT" ? null : "true",
              check: policy.cmd === "SELECT" || policy.cmd === "DELETE" ? null : "true",
            };
          expect({ qual: bareCondition(policy.qual), check: bareCondition(policy.check) }, label).toEqual({
            qual: bareCondition(before.qual),
            check: bareCondition(before.check),
          });
          const halves = [policy.qual, policy.check].filter((text): text is string => text !== null);
          for (const text of halves) {
            // An erasure labels a suppression with the union of what it removed, so hiding a
            // restricted one would leave its person unsuppressed; the Pipeline reads a fingerprint.
            if (label === "knowledge.suppressions pi_pipeline_select") continue;
            if (!labelled.has(policy.table)) expect(text, label).not.toMatch(/is_restricted/);
            else if (policy.roles.includes("pi_pipeline")) {
              expect(text, label).toMatch(/NOT policy\.is_restricted\(compartments\)/);
            } else expect(text, label).toMatch(/AND policy\.is_restricted\(compartments\)/);
          }
          continue;
        }
        // The send proxy's conditions, matched by their patterns.
        const send = SEND_CONDITIONS[label];
        if (send !== undefined) {
          for (const [text, patterns] of [
            [policy.qual, send.qual],
            [policy.check, send.check],
          ] as const) {
            if (patterns === null) expect(text, label).toBeNull();
            else for (const pattern of patterns) expect(text, `${label}: ${pattern.source}`).toMatch(pattern);
          }
          continue;
        }
        const condition = CONDITIONS[label];
        if (condition !== undefined) {
          expect({ qual: policy.qual, check: policy.check }, label).toEqual(condition);
          continue;
        }
        // Durable work's reader policies each say their own condition.
        const work = policy.roles.includes("pi_reader") ? WORK_READER_CONDITIONS[policy.table] : undefined;
        if (work !== undefined) {
          for (const pattern of work) expect(policy.qual, `${label}: ${pattern.source}`).toMatch(pattern);
          expect(policy.qual, label).not.toMatch(/\bheld\b/i);
          expect(policy.check, label).toBeNull();
          continue;
        }
        if (policy.roles.includes("pi_reader")) {
          expect(policy.qual, label).toMatch(/select\s+(policy\.)?client_clearance\(\)/i);
          expect(policy.check, label).toBeNull();
          // The account-recovery hold is a row policy: the reader's policy on
          // `knowledge.messages` and on `knowledge.documents`, and no other, also says `not held`.
          if (["knowledge.messages", "knowledge.documents"].includes(policy.table))
            expect(policy.qual, label).toMatch(HIDES_HELD);
          else expect(policy.qual, label).not.toMatch(/\bheld\b/i);
          continue;
        }
        expect(policy.qual, label).toBe(policy.cmd === "INSERT" ? null : "true");
        expect(policy.check, label).toBe(policy.cmd === "SELECT" || policy.cmd === "DELETE" ? null : "true");
      }

      // Exactly the table privileges of the grants table, leaving out the owner's own entries.
      const privileges = await queryAs<{ table: string; grantee: string; privilege: string; grantable: boolean }>(
        db.urls.admin,
        `select n.nspname || '.' || c.relname as "table", coalesce(g.rolname, 'PUBLIC') as grantee, a.privilege_type as privilege, a.is_grantable as grantable
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join lateral aclexplode(c.relacl) a
         left join pg_roles g on g.oid = a.grantee
         where c.relkind in ('r', 'p') and n.nspname = any($1) and a.grantee <> c.relowner`,
        [SCHEMAS],
      );
      expect(privileges.map((grant) => `${grant.table} ${grant.grantee} ${grant.privilege}`).sort()).toEqual(
        onTable(expectedPrivileges).sort(),
      );
      expect(privileges.filter((grant) => grant.grantable)).toEqual([]);

      // Column privileges, read as pi_owner, who granted them all: beyond what each table
      // privilege gives on every column, exactly the column grants above.
      const columns = await asOwner(db, (query) =>
        query<{ table: string; column: string; grantee: string; privilege: string }>(
          `select table_schema || '.' || table_name as "table", column_name::text as "column", grantee::text as grantee, privilege_type::text as privilege
           from information_schema.column_privileges where table_schema = any($1) and grantee <> 'pi_owner'`,
          [SCHEMAS],
        ),
      );
      const byTable = new Set([...onTable(expectedPrivileges), "projections.reverse_dependency_index pi_admin SELECT"]);
      const onColumns = columns.filter((grant) => !byTable.has(`${grant.table} ${grant.grantee} ${grant.privilege}`));
      // pi_work reads every column of a draft but its body, and of a gate row but its facts.
      const workSend: string[] = [];
      for (const [table, but] of Object.entries(SEND_WORK_COLUMNS_BUT)) {
        const all = await queryAs<{ column: string }>(
          db.urls.admin,
          "select attname::text as column from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped",
          [table],
        );
        expect(
          all.map((one) => one.column),
          table,
        ).toContain(but);
        for (const { column } of all) if (column !== but) workSend.push(`${table} ${column} pi_work SELECT`);
      }
      expect(
        onColumns.map((grant) => `${grant.table} ${grant.column} ${grant.grantee} ${grant.privilege}`).sort(),
      ).toEqual([...ALL_COLUMN_GRANTS, ...workSend, ...(await session(db.urls.admin, labelFixedColumnGrants))].sort());
      // The control for that read: it does see the table privileges, column by column.
      expect(
        columns.filter((grant) => grant.table === "knowledge.accounts" && grant.grantee === "pi_reader").length,
      ).toBeGreaterThan(0);
    }));

  describe("pi_reader sees a row of knowledge only when its compartments are within the current client's", () => {
    it("pi_reader sees a row of knowledge only when its compartments are within the current client's", () =>
      withDatabase(async (db) => {
        const { own, employer } = await seedBothCompartments(db);
        // A person whose one account row carries both compartments, and an entity with no
        // account and no domain at all.
        const { both, orphan } = await session(db.urls.admin, async (query) => {
          const seed = seeder(db, query);
          const person = await seed.entity("person");
          await seed.account(["own", "employer:example"], person);
          return { both: person, orphan: await seed.entity("person") };
        });
        const ownClient = await insertClient(db, "own-only", ["own"]);
        const employerClient = await insertClient(db, "employer-only", ["employer:example"]);
        const bothClient = await insertClient(db, "both", ["own", "employer:example"]);

        // Every row a client sees lies within its clearance, and it sees some in every table.
        for (const [client, allowed] of [
          [ownClient, [["own"]]],
          [employerClient, [["employer:example"]]],
        ] as const) {
          await readAs(db, client.token, async (query) => {
            for (const table of KNOWLEDGE.filter((one) => one.name !== "knowledge.entities")) {
              const rows = await query<{ compartments: string[] }>(`select compartments from ${table.name}`);
              expect(rows.length, `${client.name}: ${table.name}`).toBeGreaterThan(0);
              for (const row of rows) expect(allowed, `${client.name}: ${table.name}`).toContainEqual(row.compartments);
            }
          });
        }

        // An entity is seen only through one of its account or domain rows.
        expect(await entitiesSeen(db, ownClient)).toEqual([own.person, own.organization].sort());
        expect(await entitiesSeen(db, employerClient)).toEqual([employer.person, employer.organization].sort());
        // The positive control: a client cleared for both sees both, and the two-compartment row.
        expect(await entitiesSeen(db, bothClient)).toEqual(
          [own.person, own.organization, employer.person, employer.organization, both].sort(),
        );
        expect(await entitiesSeen(db, bothClient)).not.toContain(orphan);
        const widest = await visible(db, bothClient.token);
        const narrow = await visible(db, ownClient.token);
        expect(widest["knowledge.accounts"]).toBe(3);
        expect(narrow["knowledge.accounts"]).toBe(1);
      }));

    it("no token sees nothing", () =>
      withDatabase(async (db) => {
        await seedBothCompartments(db);
        const client = await insertClient(db, "own-only", ["own"]);

        for (const token of [null, "", "pit_no-such-token", sha256Hex(client.token)]) {
          expect(await visible(db, token), String(token)).toEqual(nothing);
          await readAs(db, token, async (query) => {
            expect(await query("select * from policy.current_client()")).toEqual([]);
            expect(
              one(await query<{ clearance: string[] }>("select policy.client_clearance() as clearance")).clearance,
            ).toEqual([]);
          });
        }

        // The positive control: the same reads under the client's token.
        const seen = await visible(db, client.token);
        for (const table of KNOWLEDGE) expect(seen[table.name], table.name).toBeGreaterThan(0);
        await readAs(db, client.token, async (query) => {
          expect(await query("select * from policy.current_client()")).toEqual([
            { id: client.id, name: client.name, compartments: ["own"], views: ALL_VIEWS, tools: ALL_TOOLS },
          ]);
          expect(
            one(await query<{ clearance: string[] }>("select policy.client_clearance() as clearance")).clearance,
          ).toEqual(["own"]);
        });
      }));

    it("a revoked token sees nothing", () =>
      withDatabase(async (db) => {
        await seedBothCompartments(db);
        const client = await insertClient(db, "to-revoke", ["own", "employer:example"]);

        // The positive control: the token while its client is active.
        const before = await visible(db, client.token);
        for (const table of KNOWLEDGE) expect(before[table.name], table.name).toBeGreaterThan(0);

        await revokeClient(db, client);
        expect(await visible(db, client.token)).toEqual(nothing);
        await readAs(db, client.token, async (query) => {
          expect(await query("select * from policy.current_client()")).toEqual([]);
          expect(
            one(await query<{ clearance: string[] }>("select policy.client_clearance() as clearance")).clearance,
          ).toEqual([]);
        });
      }));

    it("a `public` client sees no `own` row", () =>
      withDatabase(async (db) => {
        await seedBothCompartments(db);
        const publicClient = await insertClient(db, "public-only", ["public"]);
        const ownClient = await insertClient(db, "own-only", ["own"]);

        expect(await visible(db, publicClient.token)).toEqual(nothing);
        // It is a client: the function knows it, and its clearance is `public` alone.
        await readAs(db, publicClient.token, async (query) => {
          expect(one(await query<{ id: string }>("select id from policy.current_client()")).id).toBe(publicClient.id);
          expect(
            one(await query<{ clearance: string[] }>("select policy.client_clearance() as clearance")).clearance,
          ).toEqual(["public"]);
        });

        // The positive control: the same reads by a client cleared for `own`.
        const seen = await visible(db, ownClient.token);
        for (const table of KNOWLEDGE) expect(seen[table.name], table.name).toBeGreaterThan(0);
      }));
  });

  it("pi_reader cannot insert, update or delete in any table", () =>
    withDatabase(async (db) => {
      await seedBothCompartments(db);
      const client = await insertClient(db, "own-only", ["own"]);

      // Every write of every table, under a token that is cleared to read.
      const writes = await readerWriteProbes(db, client.token);
      expect(writes).toHaveLength(TABLES.length * 3);
      for (const probe of writes) {
        expect(probe.refused, probe.sql).toBe("42501");
        expect(probe.control, `control: ${probe.sql}`).toBeNull();
      }

      // It cannot select from `vault` or `policy`.
      const reads = await readerReadProbes(db, client.token);
      expect(reads).toHaveLength(tablesIn("policy", "vault").length);
      for (const probe of reads) {
        expect(probe.refused, probe.sql).toBe("42501");
        expect(probe.control, `control: ${probe.sql}`).toBeNull();
      }
      // The one exception, a column and not a table: pi_reader selects policy.research_settings'
      // client_link_requests, read before any lookup of a link request. No other column of it.
      expect(
        await sqlState(() =>
          readAs(db, client.token, (query) => query("select client_link_requests from policy.research_settings")),
        ),
      ).toBeNull();
      expect(
        await sqlState(() => readAs(db, client.token, (query) => query("select * from policy.research_settings"))),
      ).toBe("42501");
      // And the owner's time zone, and no other column of the owner's settings.
      expect(
        await sqlState(() => readAs(db, client.token, (query) => query("select time_zone from policy.owner_settings"))),
      ).toBeNull();
      expect(
        await sqlState(() => readAs(db, client.token, (query) => query("select * from policy.owner_settings"))),
      ).toBe("42501");
      // The control for the reader itself: it reads every `knowledge` table.
      for (const table of KNOWLEDGE) {
        expect(
          await sqlState(() =>
            readAs(db, client.token, (query) => query(`select count(${table.column}) from ${table.name}`)),
          ),
          table.name,
        ).toBeNull();
      }

      // It cannot make a temporary table. The bootstrap, which owns the database, can.
      const temporary = "create temporary table probe (x integer)";
      expect(await sqlState(() => readAs(db, client.token, (query) => query(temporary)))).toBe("42501");
      expect(await sqlState(() => queryAs(db.urls.reader, temporary))).toBe("42501");
      expect(await sqlState(() => queryAs(db.urls.bootstrap, temporary))).toBeNull();
    }));

  it("the reader cannot read an entity's created_at", () =>
    withDatabase(async (db) => {
      const { own } = await seedBothCompartments(db);
      const client = await insertClient(db, "own-only", ["own"]);

      for (const sql of [
        "select created_at from knowledge.entities",
        "select * from knowledge.entities",
        "select id from knowledge.entities order by created_at",
      ]) {
        expect(await sqlState(() => readAs(db, client.token, (query) => query(sql))), sql).toBe("42501");
        // The positive control for the statement: pi_admin reads every column.
        expect(await sqlState(() => queryAs(db.urls.admin, sql)), `control: ${sql}`).toBeNull();
      }
      // The positive control for the reader: the two columns it is granted.
      const seen = await readAs(db, client.token, (query) =>
        query<{ id: string; kind: string }>("select id, kind from knowledge.entities"),
      );
      expect(seen.sort((left, right) => (left.id < right.id ? -1 : 1))).toEqual(
        [
          { id: own.person, kind: "person" },
          { id: own.organization, kind: "organization" },
        ].sort((left, right) => (left.id < right.id ? -1 : 1)),
      );
    }));

  describe("a temporary table named like a policy table changes nothing a definer function returns", () => {
    it("a temporary `clients` table grants nothing", () =>
      withDatabase(async (db) => {
        const { own } = await seedBothCompartments(db);
        const client = await insertClient(db, "own-only", ["own"]);
        const forged = "pit_forged-token";
        await queryAs(db.urls.bootstrap, `grant temporary on database "${db.name}" to pi_reader`);

        await session(db.urls.reader, async (query) => {
          await query(
            "create temporary table clients (id text, name text, token_hash text, status text, compartments text[], views text[], tools text[])",
          );
          const wide = ["own", "employer:example"];
          // A client that does not exist, and the real client's token with a wider clearance.
          await query("insert into clients values ($1, $2, $3, 'active', $4, $5, $6)", [
            "cli_forged",
            "forged",
            sha256Hex(forged),
            wide,
            ALL_VIEWS,
            ALL_TOOLS,
          ]);
          await query("insert into clients values ($1, $2, $3, 'active', $4, $5, $6)", [
            client.id,
            client.name,
            sha256Hex(client.token),
            wide,
            ALL_VIEWS,
            ALL_TOOLS,
          ]);
          // The control: the temporary table is there, and is what the bare name now means.
          expect(one(await query<{ n: number }>("select count(*)::int as n from clients")).n).toBe(2);

          for (const path of [null, "pg_temp, policy, pg_catalog"]) {
            const setPath = async (run: Query): Promise<void> => {
              if (path !== null) await run(`set local search_path = ${path}`);
            };
            await withToken(query, forged, async (run) => {
              await setPath(run);
              expect(await run("select * from policy.current_client()"), String(path)).toEqual([]);
              expect(
                one(await run<{ clearance: string[] }>("select policy.client_clearance() as clearance")).clearance,
              ).toEqual([]);
              expect(one(await run<{ n: number }>("select count(*)::int as n from knowledge.accounts")).n).toBe(0);
            });
            // The real token still gives the real row and the real clearance.
            await withToken(query, client.token, async (run) => {
              await setPath(run);
              expect(await run("select * from policy.current_client()"), String(path)).toEqual([
                { id: client.id, name: client.name, compartments: ["own"], views: ALL_VIEWS, tools: ALL_TOOLS },
              ]);
              expect(
                one(await run<{ clearance: string[] }>("select policy.client_clearance() as clearance")).clearance,
              ).toEqual(["own"]);
              expect(
                (await run<{ id: string }>("select id from knowledge.entities")).map((row) => row.id).sort(),
              ).toEqual([own.person, own.organization].sort());
              await logCall(run, "search", 1, "ok");
            });
          }
        });

        // The call log names the real client, both times.
        const calls = await queryAs<{ client_id: string }>(db.urls.admin, "select client_id from policy.calls");
        expect(calls.map((call) => call.client_id)).toEqual([client.id, client.id]);
      }));
  });

  describe("log_call records the token's client", () => {
    it("log_call refuses an unknown tool, an unknown outcome and negative rows", () =>
      withDatabase(async (db) => {
        const first = await insertClient(db, "first", ["own"]);
        const second = await insertClient(db, "second", ["employer:example"]);
        const outcomes = ["ok", "unauthorized", "not_permitted", "invalid_request", "not_found", "unavailable"];

        // The positive controls: every tool and every outcome of the closed lists, and zero rows.
        for (const tool of ALL_TOOLS) await readAs(db, first.token, (query) => logCall(query, tool, 3, "ok"));
        for (const outcome of outcomes) await readAs(db, second.token, (query) => logCall(query, "search", 0, outcome));
        const logged = await queryAs<{ client_id: string; tool: string; rows: number; outcome: string }>(
          db.urls.admin,
          "select client_id, tool, rows, outcome from policy.calls order by id",
        );
        expect(logged).toEqual([
          ...ALL_TOOLS.map((tool) => ({ client_id: first.id, tool, rows: 3, outcome: "ok" })),
          ...outcomes.map((outcome) => ({ client_id: second.id, tool: "search", rows: 0, outcome })),
        ]);

        const refused: [string, number, string][] = [
          ["drop_everything", 0, "ok"],
          ["", 0, "ok"],
          ["search", 0, "fine"],
          ["search", -1, "ok"],
        ];
        // A tool that is no row of `policy.tool_names` fails the foreign key; an outcome or a
        // count the table's checks refuse fails them.
        for (const [tool, rows, outcome] of refused) {
          const expected = tool === "search" ? "23514" : "23503";
          expect(
            await sqlState(() => readAs(db, first.token, (query) => logCall(query, tool, rows, outcome))),
            `${tool} ${rows} ${outcome}`,
          ).toBe(expected);
        }
        expect(one(await queryAs<{ n: number }>(db.urls.admin, "select count(*)::int as n from policy.calls")).n).toBe(
          logged.length,
        );
      }));

    it("log_call with no client is refused", () =>
      withDatabase(async (db) => {
        const client = await insertClient(db, "active", ["own"]);
        const revoked = await insertClient(db, "revoked", ["own"]);
        await revokeClient(db, revoked);

        for (const token of [null, "", "pit_no-such-token", revoked.token]) {
          expect(
            await sqlState(() => readAs(db, token, (query) => logCall(query, "search", 0, "ok"))),
            String(token),
          ).toBe("42501");
        }
        // The positive control: the same call under an active client's token.
        expect(await sqlState(() => readAs(db, client.token, (query) => logCall(query, "search", 0, "ok")))).toBeNull();
        const calls = await queryAs<{ client_id: string }>(db.urls.admin, "select client_id from policy.calls");
        expect(calls).toEqual([{ client_id: client.id }]);
      }));
  });

  it("a token hash that is not 64 hex characters is refused", () =>
    withDatabase(async (db) => {
      const good = sha256Hex("pit_some-token");
      const insert = (name: string, hash: string): Promise<unknown> =>
        queryAs(
          db.urls.admin,
          `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools)
           values ($1, $2, $3, 'active', 'none', 'local', '{own}', $4, $5)`,
          [testId("cli"), name, hash, ALL_VIEWS, ALL_TOOLS],
        );
      const refused: [string, string][] = [
        ["empty", ""],
        ["a token itself", "pit_some-token"],
        ["63 characters", good.slice(1)],
        ["65 characters", `${good}0`],
        ["upper case", good.toUpperCase()],
        ["not hex", `${good.slice(0, 63)}g`],
        ["padded", ` ${good.slice(2)} `],
      ];
      for (const [label, hash] of refused)
        expect(await sqlState(() => insert(`bad-${refused.findIndex(([one]) => one === label)}`, hash)), label).toBe(
          "23514",
        );
      expect(await queryAs(db.urls.admin, "select id from policy.clients")).toEqual([]);
      // The positive control: the same row with the hex SHA-256 of a token.
      expect(/^[0-9a-f]{64}$/.test(good)).toBe(true);
      expect(await sqlState(() => insert("good", good))).toBeNull();
    }));

  it("pi_writer cannot select from policy.clients or policy.calls", () =>
    withDatabase(async (db) => {
      const probes = await writerPolicyProbes(db);
      expect(probes).toHaveLength(5);
      for (const probe of probes) {
        expect(probe.refused, probe.sql).toBe("42501");
        expect(probe.control, `control: ${probe.sql}`).toBeNull();
      }
      // The control for the writer itself: it reads `policy.secrets`.
      expect(await sqlState(() => queryAs(db.urls.writer, "select count(*) from policy.secrets"))).toBeNull();
    }));

  it("no runtime role owns a table or has BYPASSRLS", () =>
    withDatabase(async (db) => {
      const owners = await queryAs<{ name: string; owner: string }>(
        db.urls.admin,
        `select schemaname || '.' || tablename as name, tableowner as owner from pg_tables where schemaname = any($1)`,
        [SCHEMAS],
      );
      expect(owners).toHaveLength(TABLES.length);
      for (const table of owners) expect(table.owner, table.name).toBe("pi_owner");
      const owned = await queryAs<{ n: number }>(
        db.urls.admin,
        "select count(*)::int as n from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = any($1)",
        [RUNTIME_ROLES],
      );
      expect(one(owned).n).toBe(0);

      const roles = await queryAs<{ role: string; bypass: boolean; superuser: boolean }>(
        db.urls.admin,
        "select rolname as role, rolbypassrls as bypass, rolsuper as superuser from pg_roles where rolname = any($1) order by 1",
        [[...RUNTIME_ROLES, "pi_owner"]],
      );
      expect(roles).toEqual(
        ["pi_admin", "pi_owner", "pi_pipeline", "pi_proxy", "pi_reader", "pi_restricted", "pi_work", "pi_writer"].map(
          (role) => ({ role, bypass: false, superuser: false }),
        ),
      );

      // The functions of `policy`: definer, owned by pi_owner, with exactly the search path. The
      // core's three are executed by pi_reader alone; extraction's audiences() by pi_pipeline alone,
      // and withheld_items() by no role.
      const functions = await queryAs<{
        name: string;
        definer: boolean;
        owner: string;
        config: string[] | null;
        volatility: string;
        language: string;
        grantees: string[] | null;
      }>(
        db.urls.admin,
        `select p.proname as name, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner, p.proconfig::text[] as config, p.provolatile::text as volatility,
                l.lanname::text as language,
                (select array_agg(coalesce(g.rolname::text, 'PUBLIC') || ' ' || a.privilege_type order by 1)
                 from aclexplode(p.proacl) a left join pg_roles g on g.oid = a.grantee where a.grantee <> p.proowner) as grantees
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
         where n.nspname = 'policy' order by 1`,
      );
      // policy.vetoed and policy.vetoed_by: definer, stable, sql, for pi_admin alone.
      expect(functions.map((one) => one.name).sort()).toEqual([
        // The clearance of the client an agent-app rule names, for the drain alone.
        "agent_app_label",
        // The owner's standing release, for the pipeline's label check and the admin.
        "agent_closes_on",
        // What a second agent confirmed on an agent's claim, for the belief build.
        "agent_confirmed_claims",
        // The records the owner answered, for the belief build alone.
        "answered_records",
        "append_record",
        "audiences",
        // A belief's inputs under the caller's clearance, for pi_reader alone.
        "belief_inputs",
        "belief_inputs_core",
        // Its body under a given clearance, for the shadow sampler (pi_pipeline alone).
        "belief_inputs_under",
        "belief_rulings_mark",
        // The device's erased keys for push_capture's ack, for pi_reader alone.
        "capture_erased_since_push",
        // The items of the vetoes and retires in force, for the belief rebuild alone.
        "carried_ruling_items",
        // What a generation would do to each ruling in force, for the owner's report and the
        // extraction run that must refuse it: ids and states, nothing sealed.
        "carry_gate",
        // Whether a model relation's census check held, for both workers and the admin.
        "census_held",
        // The caller's keys, the id mode and the two handle functions.
        "clearance_keys",
        "client_clearance",
        // The label check's close branch, for the pipeline; what closed a commitment, for the
        // reader and the admin.
        "close_claim_allowed",
        "commitment_closes",
        // The owner's confirm rates, for pi_admin; the inner count, for no role; an agent's own, for pi_reader.
        "confirm_rates",
        "confirm_rates_within",
        "confirmed_claims",
        // The current client's confirmed client-scoped preferences, for pi_reader alone.
        "confirmed_preferences",
        "current_client",
        // The current client's kind, for pi_reader alone.
        "current_client_kind",
        "current_id_mode",
        // The caller's roles and every active agent's, for pi_reader alone.
        "current_roles",
        // The caller's own rejected goal proposals, for pi_reader alone.
        "declined_goal_proposals",
        // Whether every reader withholds a person or an organization the caller sees, for
        // pi_reader's policy on knowledge.entities and get_commitments.
        "entity_withheld",
        "erasure_mark",
        // The answer from the owner in force on a match key, for the Pipeline alone.
        "fact_answer",
        // The retires in force, for the belief rebuild alone.
        // The domain and kind rulings in force, for the belief rebuild alone.
        "fact_reclassifications",
        "fact_retirements",
        // The owner's strongest ruling on a fact, for the pipeline's card raise alone.
        "fact_ruled",
        // The joins and splits in force, for the belief rebuild alone.
        "fact_rulings",
        "fact_vetoes",
        // A release under the owner's standing grant, and those in force, for the pipeline alone.
        "grant_release",
        "granted_releases",
        // Whether a group's chat lines are newer than the caller's warmth build, for pi_reader alone.
        "group_chat_newer",
        // The owner's ignored people within a clearance, for the warmth build.
        "ignored_people_in",
        "import_memory",
        // Whether a label holds a restricted compartment, for every runtime role's policies, and a
        // worker's request for a restriction.
        "is_restricted",
        // The start check's mark over every kind of journal entry.
        "journal_mark",
        // The names the pseudonymiser replaces, for pi_pipeline alone.
        "known_identities",
        "label_key",
        // pi status's count of label keys policy.labels lacks.
        "labels_missing",
        // The trigger that keeps a device's backfill vouch once, for no role.
        "lens_vouch_once",
        // The levers' stored values and each one's last change, for pi_reader alone.
        "levers_read",
        // A record's live corrections, the one definition, for pi_reader alone.
        "live_corrections",
        // The three overloads of log_call: alone, with chars, with why.
        "log_call",
        "log_call",
        "log_call",
        "log_pack",
        "log_read",
        // Lens's mirror migration: a mirror call's two reads of the client's own mirror state, for
        // pi_reader alone.
        "mirror_cursor",
        "mirror_tokens",
        // A source moment's handles' names, for the pipeline alone.
        "moment_handle_names",
        "my_confirm_rates",
        // Which given runs name someone a label can see, for the pipeline alone.
        "named_fps",
        // The trigger function that keeps policy.labels, for no role.
        "note_labels",
        // pi http's five OAuth functions, for pi_reader alone.
        "oauth_authorize",
        "oauth_exchange",
        "oauth_refresh",
        "oauth_register",
        "oauth_registration",
        // The owner's Done or Drop in force on an open item, for the reader and the admin.
        "open_item_closes",
        "open_session",
        // The owner's own closes in force, for the reader and the admin.
        "owner_commitment_closes",
        // The owner's set and undo of a lever, for pi_admin alone.
        "owner_set_lever",
        "propose_about_you",
        // An agent's proposal of a person, for pi_reader alone.
        "propose_person",
        // Lens's inbox migration: the device's push, for pi_reader alone.
        "push_capture",
        // The read quota check, for pi_reader alone.
        "read_allowance",
        // Whether a label is connected for reading, for pi_proxy alone.
        "read_connected",
        "record_label",
        // Read receipts of the caller's own agent records, for pi_reader alone.
        "record_reads",
        "rejected_claims",
        // Whether a relation takes effect at a read, for both workers and the admin.
        "relation_effective",
        // What the owner's confirm relayed by an agent answered, for the belief build.
        "relayed_claims",
        // The owner's releases in force, for the pipeline alone.
        "released_records",
        "request_restriction",
        // One sync of the current client's memory file, for pi_reader alone.
        "serve_memory",
        // Lens's mirror migration: one call of a mirror client's read, for pi_reader alone.
        "serve_mirror",
        // An agent's change to a lever, for pi_reader alone.
        "set_lever",
        // The caller's own settled records, for pi_reader alone.
        "settled_records",
        // The owner's tier rulings within a clearance, for the warmth build.
        "tier_rulings_in",
        "vetoed",
        "vetoed_by",
        "view_keys",
        // The owner's ignored people and tier rulings under the caller's own clearance, for the warmth
        // ranked at read, for pi_reader alone.
        "warmth_ignored",
        "warmth_rulings",
        // The entities every reader withholds from the caller, once per statement, for pi_reader's
        // policy on knowledge.entities.
        "withheld_entities",
        "withheld_items",
        // A finding's typed claims, for pi_reader alone.
        "write_typed_claims",
      ]);
      const plpgsql = [
        // Each checks its caller or its arguments before it reads or writes a setting.
        "set_lever",
        "owner_set_lever",
        "levers_read",
        "agent_confirmed_claims",
        "relayed_claims",
        // It refuses a caller with no client, and reads the build before the lines.
        "group_chat_newer",
        // Each answers nothing to a caller whose clearance no key opens, before it reads.
        "warmth_ignored",
        "warmth_rulings",
        "write_typed_claims",
        "belief_inputs",
        "belief_inputs_under",
        "belief_inputs_core",
        // fact_answer asks in steps, the open card first, then the owner's latest answer; and settled_records
        // checks its caller first.
        "settled_records",
        // declined_goal_proposals checks its caller first too.
        "declined_goal_proposals",
        "fact_answer",
        // A release under the owner's standing grant, in steps.
        "grant_release",
        // withheld_entities keeps the caller's keys in a variable too.
        "withheld_entities",
        // commitment_closes and owner_commitment_closes keep the caller's keys in a variable too.
        "commitment_closes",
        "owner_commitment_closes",
        // Refuses a reader session with no client before it reads.
        "open_item_closes",
        "log_call",
        "withheld_items",
        "log_read",
        "open_session",
        "record_label",
        "append_record",
        "record_reads",
        "live_corrections",
        "log_pack",
        "confirmed_claims",
        "answered_records",
        "serve_memory",
        "read_allowance",
        "propose_about_you",
        "propose_person",
        "import_memory",
        "confirmed_preferences",
        "request_restriction",
        "oauth_register",
        "oauth_authorize",
        "oauth_exchange",
        "oauth_refresh",
        "push_capture",
        "capture_erased_since_push",
        "serve_mirror",
        "mirror_cursor",
        "mirror_tokens",
        "note_labels",
        "lens_vouch_once",
      ];
      const grantees: Record<string, string[] | null> = {
        // pi_restricted holds every function right pi_pipeline holds.
        audiences: ["pi_pipeline EXECUTE", "pi_restricted EXECUTE"],
        // Which claim keys the owner confirmed, for the belief build; pi_admin too, for the items a
        // veto or a retire records; and pi_reader, for find_facts' tier of a confirmed person proposal.
        confirmed_claims: ["pi_admin EXECUTE", "pi_pipeline EXECUTE", "pi_reader EXECUTE", "pi_restricted EXECUTE"],
        answered_records: ["pi_admin EXECUTE", "pi_pipeline EXECUTE", "pi_restricted EXECUTE"],
        is_restricted: [
          "pi_admin EXECUTE",
          "pi_pipeline EXECUTE",
          "pi_proxy EXECUTE",
          "pi_reader EXECUTE",
          "pi_restricted EXECUTE",
          "pi_work EXECUTE",
          "pi_writer EXECUTE",
        ],
        request_restriction: ["pi_pipeline EXECUTE", "pi_restricted EXECUTE"],
        withheld_items: null,
        // The veto lookups and the erasure mark, for the tick.
        vetoed: ["pi_admin EXECUTE", "pi_work EXECUTE"],
        vetoed_by: ["pi_admin EXECUTE", "pi_work EXECUTE"],
        // The erasure mark, for the start check of every role's commands, pi send's included.
        erasure_mark: [
          "pi_admin EXECUTE",
          "pi_pipeline EXECUTE",
          "pi_proxy EXECUTE",
          "pi_reader EXECUTE",
          "pi_restricted EXECUTE",
          "pi_work EXECUTE",
          "pi_writer EXECUTE",
        ],
        // The start check's mark, for exactly the roles that execute the erasure mark.
        journal_mark: [
          "pi_admin EXECUTE",
          "pi_pipeline EXECUTE",
          "pi_proxy EXECUTE",
          "pi_reader EXECUTE",
          "pi_restricted EXECUTE",
          "pi_work EXECUTE",
          "pi_writer EXECUTE",
        ],
        read_connected: ["pi_proxy EXECUTE"],
        // The rulings in force and their mark, for the belief rebuild alone; pi_admin too, for
        // `pi self review`, which reads the same rule.
        rejected_claims: ["pi_admin EXECUTE", "pi_pipeline EXECUTE", "pi_restricted EXECUTE"],
        fact_vetoes: ["pi_pipeline EXECUTE", "pi_restricted EXECUTE"],
        // The Pipeline alone, not pi_restricted (the grants name it alone).
        fact_answer: ["pi_pipeline EXECUTE"],
        // The agent lane's card raise, the Pipeline alone.
        fact_ruled: ["pi_pipeline EXECUTE"],
        grant_release: ["pi_pipeline EXECUTE"],
        granted_releases: ["pi_pipeline EXECUTE"],
        // The warmth build, by each worker for its own audiences, and the owner's reads.
        ignored_people_in: ["pi_admin EXECUTE", "pi_pipeline EXECUTE", "pi_restricted EXECUTE"],
        // The owner's tier rulings, for the same build and reads.
        tier_rulings_in: ["pi_admin EXECUTE", "pi_pipeline EXECUTE", "pi_restricted EXECUTE"],
        // The same under the calling client's own clearance, for pi_reader alone.
        warmth_ignored: ["pi_reader EXECUTE"],
        warmth_rulings: ["pi_reader EXECUTE"],
        // pi_admin too, for the owner's beliefs as of a time.
        belief_inputs_under: ["pi_admin EXECUTE", "pi_pipeline EXECUTE"],
        fact_retirements: ["pi_pipeline EXECUTE", "pi_restricted EXECUTE"],
        fact_reclassifications: ["pi_pipeline EXECUTE", "pi_restricted EXECUTE"],
        carried_ruling_items: ["pi_pipeline EXECUTE", "pi_restricted EXECUTE"],
        fact_rulings: ["pi_pipeline EXECUTE", "pi_restricted EXECUTE"],
        belief_rulings_mark: ["pi_pipeline EXECUTE", "pi_restricted EXECUTE"],
        // The carry-over gate: the owner's report, and a run that refuses a generation.
        carry_gate: ["pi_admin EXECUTE", "pi_pipeline EXECUTE", "pi_restricted EXECUTE"],
        // The reader, not pi_restricted; and pi_writer, for the sync's confirmed people.
        released_records: ["pi_admin EXECUTE", "pi_pipeline EXECUTE", "pi_reader EXECUTE", "pi_writer EXECUTE"],
        // The label key, for every runtime role, which a policy and an index expression call. The
        // other new handle functions are pi_reader's alone, the default.
        label_key: [
          "pi_admin EXECUTE",
          "pi_pipeline EXECUTE",
          "pi_proxy EXECUTE",
          "pi_reader EXECUTE",
          "pi_restricted EXECUTE",
          "pi_work EXECUTE",
          "pi_writer EXECUTE",
        ],
        // A trigger fires it; no role executes it.
        note_labels: null,
        // A trigger fires it; no role executes it.
        lens_vouch_once: null,
        // pi status's coverage check, for pi_admin alone.
        labels_missing: ["pi_admin EXECUTE"],
        // The names the pseudonymiser replaces, for the pipeline alone: no restricted run pseudonymises.
        known_identities: ["pi_pipeline EXECUTE"],
        // The drain's label of an agent-app moment, for pi_writer alone.
        agent_app_label: ["pi_writer EXECUTE"],
        // What a second agent confirmed, as confirmed_claims, for whoever executes that.
        agent_confirmed_claims: ["pi_admin", "pi_pipeline", "pi_reader", "pi_restricted"].map(
          (role) => `${role} EXECUTE`,
        ),
        // What the owner's relayed confirm answered, the same.
        relayed_claims: ["pi_admin", "pi_pipeline", "pi_reader", "pi_restricted"].map((role) => `${role} EXECUTE`),
        // The activity step's person check, and the restricted worker's copy.
        named_fps: ["pi_pipeline EXECUTE", "pi_restricted EXECUTE"],
        // The slot's names, and the restricted worker's copy.
        moment_handle_names: ["pi_pipeline EXECUTE", "pi_restricted EXECUTE"],
        // The standing release, for the label check (the pipeline) and the admin; the label check's
        // close branch, for the pipeline alone; what closed a commitment, for the reader and the
        // admin. Not pi_restricted: no close is restricted.
        agent_closes_on: ["pi_admin EXECUTE", "pi_pipeline EXECUTE"],
        close_claim_allowed: ["pi_pipeline EXECUTE"],
        commitment_closes: ["pi_admin EXECUTE", "pi_reader EXECUTE"],
        open_item_closes: ["pi_admin EXECUTE", "pi_reader EXECUTE"],
        owner_commitment_closes: ["pi_admin EXECUTE", "pi_reader EXECUTE"],
        // The owner's confirm rates, pi_admin's; the inner count, no role's (an agent's own is the reader's).
        confirm_rates: ["pi_admin EXECUTE"],
        confirm_rates_within: null,
        // The owner's set and undo of a lever.
        owner_set_lever: ["pi_admin EXECUTE"],
        belief_inputs_core: null,
        census_held: ["pi_admin EXECUTE", "pi_pipeline EXECUTE", "pi_restricted EXECUTE"],
        relation_effective: ["pi_admin EXECUTE", "pi_pipeline EXECUTE", "pi_restricted EXECUTE"],
      };
      for (const fn of functions) {
        // is_restricted reads nothing: an immutable SQL function, run as the role whose policy calls
        // it, naming pg_catalog's functions itself and setting no search path, so the planner can
        // inline it.
        if (fn.name === "is_restricted") {
          expect(fn, fn.name).toMatchObject({ definer: false, owner: "pi_owner", volatility: "i", language: "sql" });
          expect(fn.config, fn.name).toBeNull();
          expect([...(fn.grantees ?? [])].sort(), fn.name).toEqual([...(grantees.is_restricted ?? [])].sort());
          continue;
        }
        // The label key is the other invoker and immutable function: an index expression calls it.
        expect(fn, fn.name).toMatchObject({ definer: fn.name !== "label_key", owner: "pi_owner" });
        expect(
          (fn.config ?? []).map((setting) => setting.replaceAll(/[\s"]/g, "")),
          fn.name,
        ).toEqual(["search_path=pg_catalog,policy,pg_temp"]);
        const volatile = [
          "log_call",
          "log_read",
          "open_session",
          "append_record",
          "log_pack",
          "serve_memory",
          "propose_about_you",
          "propose_person",
          "import_memory",
          "request_restriction",
          "oauth_register",
          "oauth_authorize",
          "oauth_exchange",
          "oauth_refresh",
          "push_capture",
          // It marks the keys it returns.
          "capture_erased_since_push",
          "serve_mirror",
          "note_labels",
          "lens_vouch_once",
          // It writes a finding's typed claims.
          "write_typed_claims",
          // It writes a release under the owner's standing grant.
          "grant_release",
          // Each writes a setting and its history row.
          "set_lever",
          "owner_set_lever",
        ];
        expect(fn.volatility, fn.name).toBe(fn.name === "label_key" ? "i" : volatile.includes(fn.name) ? "v" : "s");
        expect(fn.language, fn.name).toBe(plpgsql.includes(fn.name) ? "plpgsql" : "sql");
        // EXECUTE is granted by name only: not to PUBLIC, and not left at its default.
        // Compared as sets: the catalogue keeps grants in no order a test may rely on.
        const granted = fn.grantees === null ? null : [...fn.grantees].sort();
        const want = fn.name in grantees ? grantees[fn.name] : ["pi_reader EXECUTE"];
        expect(granted, fn.name).toEqual(want === null || want === undefined ? want : [...want].sort());
      }

      // Of the runtime roles, only pi_reader can execute them.
      const calls = [
        "select * from policy.current_client()",
        "select policy.client_clearance()",
        "select policy.log_call('search', 0, 'ok')",
      ];
      const client = await insertClient(db, "own-only", ["own"]);
      for (const sql of calls) {
        expect(await sqlState(() => queryAs(db.urls.admin, sql)), `pi_admin: ${sql}`).toBe("42501");
        expect(await sqlState(() => queryAs(db.urls.writer, sql)), `pi_writer: ${sql}`).toBe("42501");
        expect(await sqlState(() => readAs(db, client.token, (query) => query(sql))), `pi_reader: ${sql}`).toBeNull();
      }
    }));

  describe("a token set with set_config(..., true) is gone after commit or rollback", () => {
    it("the token does not survive the transaction on a pooled connection", () =>
      withDatabase(async (db) => {
        await seedBothCompartments(db);
        const client = await insertClient(db, "own-only", ["own"]);
        const pool = new pg.Pool({ connectionString: db.urls.reader, max: 1 });
        try {
          const read = async (): Promise<{ pid: number; clients: number; accounts: number; token: string | null }> => {
            const pid = one((await pool.query<{ pid: number }>("select pg_backend_pid() as pid")).rows).pid;
            const clients = (await pool.query("select * from policy.current_client()")).rows.length;
            const accounts = one(
              (await pool.query<{ n: number }>("select count(*)::int as n from knowledge.accounts")).rows,
            ).n;
            const token = one(
              (await pool.query<{ token: string | null }>("select current_setting('pi.client_token', true) as token"))
                .rows,
            ).token;
            return { pid, clients, accounts, token };
          };

          for (const end of ["commit", "rollback"]) {
            const connection = await pool.connect();
            let pid: number;
            try {
              await connection.query("begin");
              await connection.query("select set_config('pi.client_token', $1, true)", [client.token]);
              pid = one((await connection.query<{ pid: number }>("select pg_backend_pid() as pid")).rows).pid;
              // The positive control: inside the transaction the token is the client.
              expect((await connection.query("select * from policy.current_client()")).rows).toHaveLength(1);
              expect(
                one((await connection.query<{ n: number }>("select count(*)::int as n from knowledge.accounts")).rows)
                  .n,
              ).toBe(1);
              await connection.query(end);
            } finally {
              connection.release();
            }

            // The next transaction on the same connection sees no client and no row.
            const after = await read();
            expect(after.pid, end).toBe(pid);
            expect(after.clients, end).toBe(0);
            expect(after.accounts, end).toBe(0);
            expect(after.token ?? "", end).toBe("");
          }
        } finally {
          await pool.end();
        }
      }));

    it("an empty token is no client, even if a client is stored with the hash of the empty string", () =>
      withDatabase(async (db) => {
        await seedBothCompartments(db);
        // The SHA-256 of the empty string is a well-formed hash, so the row is accepted.
        const empty = await insertClient(db, "empty-token", ["own", "employer:example"], "");
        expect(sha256Hex(empty.token)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        const real = await insertClient(db, "own-only", ["own"]);
        const noClient = async (query: Query, label: string): Promise<void> => {
          expect(await query("select * from policy.current_client()"), label).toEqual([]);
          expect(
            one(await query<{ clearance: string[] }>("select policy.client_clearance() as clearance")).clearance,
            label,
          ).toEqual([]);
          for (const table of KNOWLEDGE)
            expect(
              one(await query<{ n: number }>(`select count(${table.column})::int as n from ${table.name}`)).n,
              `${label}: ${table.name}`,
            ).toBe(0);
        };

        // The token unset, and set to the empty string.
        await readAs(db, null, (query) => noClient(query, "unset"));
        await readAs(db, "", (query) => noClient(query, "empty"));
        expect(await sqlState(() => readAs(db, null, (query) => logCall(query, "search", 0, "ok")))).toBe("42501");
        expect(await sqlState(() => readAs(db, "", (query) => logCall(query, "search", 0, "ok")))).toBe("42501");

        // After a transaction that set another token, on the same connection: the setting is
        // then the empty string, which is still no client.
        await session(db.urls.reader, async (query) => {
          await withToken(query, real.token, async (run) => {
            // The positive control: inside it, the token is its client.
            expect(one(await run<{ id: string }>("select id from policy.current_client()")).id).toBe(real.id);
            expect(one(await run<{ n: number }>("select count(id)::int as n from knowledge.accounts")).n).toBe(1);
            // And the call that is refused below, and was refused above, is logged for it.
            await logCall(run, "search", 0, "ok");
          });
          expect(
            one(await query<{ token: string | null }>("select current_setting('pi.client_token', true) as token"))
              .token ?? "",
          ).toBe("");
          await noClient(query, "after another token, outside a transaction");
          await withToken(query, null, (run) => noClient(run, "after another token, in a new transaction"));
          expect(await sqlState(() => logCall(query, "search", 0, "ok"))).toBe("42501");
        });
        // The one call that was logged is the real client's: none was logged for the empty token's.
        expect(await queryAs(db.urls.admin, "select client_id from policy.calls")).toEqual([{ client_id: real.id }]);
        expect(empty.id).not.toBe(real.id);
      }));
  });

  it("a row with an empty compartments is refused", () =>
    withDatabase(async (db) => {
      const constrained = await queryAs<{ name: string }>(
        db.urls.admin,
        `select n.nspname || '.' || c.relname as name
         from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
         where k.conname = 'compartments_not_empty' and k.contype = 'c' order by 1`,
      );
      const tables = await queryAs<{ name: string }>(
        db.urls.admin,
        `select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r', 'p') and n.nspname in ('vault', 'knowledge', 'projections', 'ledger')`,
      );
      // Exactly every `vault`, `knowledge` and `projections` table but `knowledge.entities`, and
      // `policy.clients` and `policy.retention_rules`. A ruling of contacts and identity has no
      // compartments: it is seen through the account rows of its addresses. Nor has
      // vault.screen_passes, a term list's version and the on categories, which names no item. The
      // calibration reports and proposals are counts and the owner's, with no compartments. The
      // coverage job tables and the work notice tables have no label either. ledger.mirror_cursors
      // holds a client's pass position and the ids it sent, no label.
      const unlabelled = [
        "knowledge.entities",
        "knowledge.identity_rulings",
        "knowledge.ignore_rulings",
        "ledger.calibration_reports",
        "ledger.threshold_proposals",
        "vault.screen_passes",
        "ledger.mirror_cursors",
        "ledger.job_runs",
        "ledger.coverage_states",
        "ledger.work_notices",
        "ledger.work_declines",
        "ledger.health_notices",
        "ledger.batch_notices",
        "ledger.ping_walks",
        "ledger.change_cursors",
        "ledger.agent_message_reads",
        "ledger.agent_spend",
        "policy.settings",
        "policy.setting_changes",
        "ledger.measure_readings",
        "knowledge.person_hides",
        "ledger.card_name_holds",
        "policy.fact_ruling_marks",
        "ledger.dream_subjects",
        "ledger.dream_nights",
        "ledger.session_taint_counts",
      ];
      const expected = [
        ...tables.map((table) => table.name).filter((name) => !unlabelled.includes(name)),
        "policy.clients",
        "policy.retention_rules",
      ].sort();
      // Pinned by what the list includes, not its length, so that adding an entry breaks nothing; the
      // rule under test is the next line. Fact settlements are labelled with their claim's label,
      // tier rulings with their person's account rows, and chat lines with their moment's label.
      expect(constrained.map((table) => table.name)).toEqual(
        expect.arrayContaining([
          "ledger.fact_settlements",
          "knowledge.tier_rulings",
          "knowledge.chat_lines",
          "knowledge.owner_lists",
          "knowledge.owner_list_members",
        ]),
      );
      expect(constrained.map((table) => table.name).sort()).toEqual(expected);

      await session(db.urls.admin, async (query) => {
        const seed = seeder(db, query);
        for (const { name } of constrained) {
          // knowledge.pages takes a row only for a request that runs, by a trigger that fires
          // before the checks: an empty label is refused there, and the constraint is in the
          // catalogue above.
          if (name === "knowledge.pages") {
            const page =
              "insert into knowledge.pages (id, evidence_id, request_id, url_fp, host_fp, fetched_at, media_type, page_enc, names_enc, compartments) values ($1, $2, $3, $4, $4, now(), 'text/plain', '{}', '{}', '{}')";
            expect(
              await sqlState(() => query(page, [testId("pag"), testId("evi"), testId("rsq"), "0".repeat(64)])),
              name,
            ).toBe("42501");
            continue;
          }
          const insert = seed.into(name);
          // Lens's inbox row is checked `{own}` too, which may be the check that fires first; so
          // is an area's.
          if (name === "ledger.capture_inbox" || name === "knowledge.areas")
            expect((await refusal(() => insert([])))?.code, name).toBe("23514");
          else
            expect(await refusal(() => insert([])), name).toEqual({
              code: "23514",
              constraint: "compartments_not_empty",
            });
          // The positive control: the same row with one compartment.
          expect(await refusal(() => insert(["own"])), `control: ${name}`).toBeNull();
          expect(
            one(
              await query<{ n: number }>(`select count(*)::int as n from ${name} where cardinality(compartments) = 0`),
            ).n,
            name,
          ).toBe(0);
        }
      });
    }));

  describe("an envelope moved to another row or column fails to open", () => {
    it("a moved envelope does not open", () =>
      withStore(async ({ db, writer }) => {
        // Three accounts under one compartment, so one key seals all three: only the binding differs.
        const a = await writer.ensureSourceAccount("alpha", "google_mail", "own", "owner-alpha@moved-envelope.test");
        const b = await writer.ensureSourceAccount("bravo", "google_mail", "own", "owner-bravo@moved-envelope.test");
        const c = await writer.ensureSourceAccount(
          "charlie",
          "google_mail",
          "own",
          "owner-charlie@moved-envelope.test",
        );
        const cursors = {
          a: ConnectorCursor.parse("cursor-alpha"),
          b: ConnectorCursor.parse("cursor-bravo"),
          c: ConnectorCursor.parse("cursor-charlie"),
        };
        await writer.setCursor(a, cursors.a);
        await writer.setCursor(b, cursors.b);
        await writer.setCursor(c, cursors.c);
        // The positive control: each opens at its own row and column.
        expect(await writer.cursor(a)).toBe(cursors.a);
        expect(await writer.cursor(b)).toBe(cursors.b);
        expect(await writer.cursor(c)).toBe(cursors.c);

        // A's cursor to B's row, same column; C's address to C's own cursor column.
        await queryAs(
          db.urls.admin,
          "update vault.source_accounts set cursor_enc = (select cursor_enc from vault.source_accounts where id = $1) where id = $2",
          [a.id, b.id],
        );
        await queryAs(db.urls.admin, "update vault.source_accounts set cursor_enc = address_enc where id = $1", [c.id]);

        await expect(writer.cursor(b)).rejects.toMatchObject({ name: "CryptoError", code: "open_failed" });
        await expect(writer.cursor(c)).rejects.toMatchObject({ name: "CryptoError", code: "open_failed" });
        expect(await writer.cursor(a)).toBe(cursors.a);
      }));
  });

  it("a second evidence row for one blob is refused", () =>
    withDatabase(async (db) =>
      session(db.urls.admin, async (query) => {
        const seed = seeder(db, query);
        const account = await seed.sourceAccount(["own"]);
        const blob = await seed.blob(["own"]);
        const citing = async (): Promise<number> =>
          one(
            await query<{ n: number }>("select count(*)::int as n from vault.evidence_items where blob_ref = $1", [
              blob,
            ]),
          ).n;

        // The positive control: the first evidence row that cites the blob.
        expect(await refusal(() => seed.evidence(["own"], account, blob))).toBeNull();
        expect(await citing()).toBe(1);
        // A second row, another source item in every other respect, citing the same blob.
        expect((await refusal(() => seed.evidence(["own"], account, blob)))?.code).toBe("23505");
        expect(await citing()).toBe(1);
        // And the same row with a blob of its own is accepted.
        expect(await refusal(() => seed.evidence(["own"], account))).toBeNull();
        expect(one(await query<{ n: number }>("select count(*)::int as n from vault.evidence_items")).n).toBe(2);
      }),
    ));

  it("only the four runtime roles and the bootstrap role can connect to the database", () =>
    withDatabase(async (db) => {
      const bootstrap = one(
        await queryAs<{ role: string }>(db.urls.bootstrap, "select current_user::text as role"),
      ).role;
      // A login role that was granted nothing, so the check below has one it must refuse.
      const stranger = `pit${randomBytes(3).toString("hex")}_stranger`;
      await queryAs(db.urls.bootstrap, `create role ${stranger} login`);
      try {
        // Every login role of the server. A superuser passes every check, so none is counted.
        const logins = await queryAs<{ role: string; connect: boolean | null }>(
          db.urls.bootstrap,
          `select rolname::text as role, has_database_privilege(oid, current_database(), 'CONNECT') as connect
           from pg_roles where rolcanlogin and not rolsuper`,
        );
        expect(logins.map((login) => login.role)).toContain(stranger);
        expect(
          logins
            .filter((login) => login.connect === true)
            .map((login) => login.role)
            .sort(),
        ).toEqual([bootstrap, ...RUNTIME_ROLES, "pi_notify"].sort());
      } finally {
        await queryAs(db.urls.bootstrap, `drop role ${stranger}`);
      }
      // pi_owner cannot log in.
      expect(
        one(
          await queryAs<{ login: boolean }>(
            db.urls.bootstrap,
            "select rolcanlogin as login from pg_roles where rolname = 'pi_owner'",
          ),
        ).login,
      ).toBe(false);

      // No runtime role can create in the database, in any of its schemas, or a temporary table.
      const schemas = (
        await queryAs<{ name: string }>(
          db.urls.bootstrap,
          "select nspname::text as name from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'",
        )
      ).map((schema) => schema.name);
      expect(schemas).toEqual(expect.arrayContaining([...SCHEMAS, "public"]));
      for (const role of RUNTIME_ROLES) {
        const database = one(
          await queryAs<{ create: boolean; temporary: boolean }>(
            db.urls.bootstrap,
            "select has_database_privilege($1, current_database(), 'CREATE') as create, has_database_privilege($1, current_database(), 'TEMPORARY') as temporary",
            [role],
          ),
        );
        expect(database, role).toEqual({ create: false, temporary: false });
        for (const schema of schemas) {
          const allowed = one(
            await queryAs<{ create: boolean }>(
              db.urls.bootstrap,
              "select has_schema_privilege($1, $2, 'CREATE') as create",
              [role, schema],
            ),
          ).create;
          expect(allowed, `${role}: ${schema}`).toBe(false);
        }
      }
      // The positive controls for those checks: the owner role creates, and the bootstrap may
      // make a temporary table.
      const owner = one(
        await queryAs<{ database: boolean; policy: boolean; vault: boolean; knowledge: boolean; temporary: boolean }>(
          db.urls.bootstrap,
          `select has_database_privilege('pi_owner', current_database(), 'CREATE') as database,
                  has_schema_privilege('pi_owner', 'policy', 'CREATE') as policy,
                  has_schema_privilege('pi_owner', 'vault', 'CREATE') as vault,
                  has_schema_privilege('pi_owner', 'knowledge', 'CREATE') as knowledge,
                  has_database_privilege(current_user, current_database(), 'TEMPORARY') as temporary`,
        ),
      );
      expect(owner).toEqual({ database: true, policy: true, vault: true, knowledge: true, temporary: true });

      // And each statement itself, as each runtime role.
      const statements = [
        "create schema probe",
        "create table public.probe (x integer)",
        "create table policy.probe (x integer)",
        "create table vault.probe (x integer)",
        "create table knowledge.probe (x integer)",
        "create temporary table probe (x integer)",
      ];
      for (const role of RUNTIME_ROLES) {
        for (const sql of statements)
          expect(await sqlState(() => queryAs(urlOf(db, role), sql)), `${role}: ${sql}`).toBe("42501");
      }
      // The positive controls: pi_owner in its schemas, and the bootstrap, which owns the
      // database, in `public` and for a temporary table. Each is rolled back.
      for (const sql of [
        "create schema probe",
        "create table policy.probe (x integer)",
        "create table vault.probe (x integer)",
        "create table knowledge.probe (x integer)",
      ]) {
        expect(await sqlState(() => asOwner(db, (query) => query(sql))), `pi_owner: ${sql}`).toBeNull();
      }
      for (const sql of ["create table public.probe (x integer)", "create temporary table probe (x integer)"]) {
        const control = await sqlState(() =>
          session(db.urls.bootstrap, async (query) => {
            await query("begin");
            try {
              await query(sql);
            } finally {
              await query("rollback");
            }
          }),
        );
        expect(control, `bootstrap: ${sql}`).toBeNull();
      }
    }));

  describe("an address seen under two compartments is one entity with one accounts row per compartment", () => {
    it("a person seen under `own` and under `employer:<slug>` is one entity with two account rows", () =>
      withStore(async ({ db, writer }) => {
        const accounts = await connect(writer);
        await ingestMail(writer, accounts.personalMail, MAIL.canary);
        await ingestMail(writer, accounts.workMail, MAIL.workCanary);
        // Seen again under `own`: no third row.
        await ingestMail(writer, accounts.personalMail, MAIL.reply);

        const rows = await queryAs<{ entity_id: string; compartments: string[]; kind: string }>(
          db.urls.admin,
          `select a.entity_id, a.compartments, e.kind from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id
           where a.value_fp = $1 order by a.compartments`,
          [fingerprint(db.keys, "address", CANARY_PERSON.address)],
        );
        expect(rows.map((row) => row.compartments)).toEqual([["employer:example"], ["own"]]);
        expect(new Set(rows.map((row) => row.entity_id)).size).toBe(1);
        expect(rows.map((row) => row.kind)).toEqual(["person", "person"]);

        // The person's organization is one entity too, with one domain row per compartment: not
        // one organization per compartment.
        const domains = await queryAs<{ entity_id: string; compartments: string[]; kind: string }>(
          db.urls.admin,
          `select d.entity_id, d.compartments, e.kind from knowledge.domains d join knowledge.entities e on e.id = d.entity_id
           where d.domain_fp = $1 order by d.compartments`,
          [fingerprint(db.keys, "domain", CANARIES.domain)],
        );
        expect(domains.map((row) => row.compartments)).toEqual([["employer:example"], ["own"]]);
        expect(new Set(domains.map((row) => row.entity_id)).size).toBe(1);
        expect(domains.map((row) => row.kind)).toEqual(["organization", "organization"]);
        expect(domains[0]?.entity_id).not.toBe(rows[0]?.entity_id);
        // Quentin and Rhea share the other organization, seen under `own` alone: two in all.
        expect(
          one(
            await queryAs<{ n: number }>(
              db.urls.admin,
              "select count(*)::int as n from knowledge.entities where kind = 'organization'",
            ),
          ).n,
        ).toBe(2);
      }));

    it("a reader cleared for `own` sees the entity and only the `own` rows", () =>
      withStore(async ({ db, writer }) => {
        const accounts = await connect(writer);
        await ingestMail(writer, accounts.personalMail, MAIL.canary);
        await ingestMail(writer, accounts.workMail, MAIL.workCanary);
        // A person seen under `own` alone.
        await ingestMail(writer, accounts.personalMail, MAIL.solo);

        const addressFp = fingerprint(db.keys, "address", CANARY_PERSON.address);
        const soloFp = fingerprint(db.keys, "address", SOLO.address);
        const person = one(
          await queryAs<{ id: string }>(
            db.urls.admin,
            "select distinct entity_id as id from knowledge.accounts where value_fp = $1",
            [addressFp],
          ),
        ).id;
        const solo = one(
          await queryAs<{ id: string }>(
            db.urls.admin,
            "select distinct entity_id as id from knowledge.accounts where value_fp = $1",
            [soloFp],
          ),
        ).id;

        const seenBy = (client: TestClient) =>
          readAs(db, client.token, async (query) => ({
            entity: (await query("select id from knowledge.entities where id = $1", [person])).length,
            accounts: (
              await query<{ compartments: string[] }>(
                "select compartments from knowledge.accounts where entity_id = $1 order by compartments",
                [person],
              )
            ).map((row) => row.compartments),
            interactions: (
              await query<{ compartments: string[] }>(
                "select distinct compartments from knowledge.interaction_log where entity_id = $1 order by compartments",
                [person],
              )
            ).map((row) => row.compartments),
            solo: (await query("select id from knowledge.entities where id = $1", [solo])).length,
            soloAccounts: (await query("select id from knowledge.accounts where entity_id = $1", [solo])).length,
          }));

        const own = await seenBy(await insertClient(db, "own-only", ["own"]));
        expect(own).toEqual({ entity: 1, accounts: [["own"]], interactions: [["own"]], solo: 1, soloAccounts: 1 });

        // The positive control: a client cleared for both sees both rows.
        const both = await seenBy(await insertClient(db, "both", ["own", "employer:example"]));
        expect(both).toEqual({
          entity: 1,
          accounts: [["employer:example"], ["own"]],
          interactions: [["employer:example"], ["own"]],
          solo: 1,
          soloAccounts: 1,
        });

        // A client cleared for the employer alone sees the shared person through the employer's
        // row, and no `own`-only person.
        const employer = await seenBy(await insertClient(db, "employer-only", ["employer:example"]));
        expect(employer).toEqual({
          entity: 1,
          accounts: [["employer:example"]],
          interactions: [["employer:example"]],
          solo: 0,
          soloAccounts: 0,
        });
      }));
  });

  // ---------------------------------------------------------------------------------------------
  // A row for every message: the tool names' table, the hold's column, no unkeyed hash
  // ---------------------------------------------------------------------------------------------

  describe("log_call accepts only a tool named in policy.tool_names", () => {
    it("log_call accepts every tool name the migrations add and no other", () =>
      withDatabase(async (db) => {
        const client = await insertClient(db, "caller", ["own"]);
        // The migrations put exactly the tools served there, and request_research.
        expect(
          (await queryAs<{ name: string }>(db.urls.admin, "select name from policy.tool_names"))
            .map((row) => row.name)
            .sort(),
        ).toEqual([...SERVED_TOOLS, "request_research"].sort());

        // `policy.calls.tool` references the table: a plain foreign key, and no check on the tool.
        const constraints = await queryAs<{ type: string; definition: string }>(
          db.urls.admin,
          "select contype::text as type, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'policy.calls'::regclass",
        );
        const onTool = constraints.filter(
          (constraint) => constraint.type === "f" && constraint.definition.includes("(tool)"),
        );
        expect(onTool).toHaveLength(1);
        expect(onTool[0]?.definition).toMatch(/^FOREIGN KEY \(tool\) REFERENCES (policy\.)?tool_names\(name\)$/);
        expect(
          constraints.filter((constraint) => constraint.type === "c" && /\btool\b/.test(constraint.definition)),
        ).toEqual([]);
        // The checks on the count and the outcome stay.
        expect(
          constraints.filter(
            (constraint) => constraint.type === "c" && /\b(rows|outcome)\b/.test(constraint.definition),
          ).length,
        ).toBeGreaterThanOrEqual(2);

        // Neither the function's caller nor anyone it runs as can read the table through a policy:
        // row-level security is forced on it, and pi_reader has no privilege on it at all.
        const guarded = one(
          await queryAs<{ forced: boolean; reader: boolean }>(
            db.urls.admin,
            `select c.relforcerowsecurity as forced, has_table_privilege('pi_reader', c.oid, 'SELECT') as reader
             from pg_class c where c.oid = 'policy.tool_names'::regclass`,
          ),
        );
        expect(guarded).toEqual({ forced: true, reader: false });

        // The positive control, and the proof that the foreign key is checked all the same: each
        // name the migrations add writes its row as pi_reader through the function.
        for (const tool of TOOL_NAMES)
          expect(
            await sqlState(() => readAs(db, client.token, (query) => logCall(query, tool, 2, "ok"))),
            tool,
          ).toBeNull();
        const logged = await queryAs<{ client_id: string; tool: string; rows: number; outcome: string }>(
          db.urls.admin,
          "select client_id, tool, rows, outcome from policy.calls order by id",
        );
        expect(logged).toEqual(TOOL_NAMES.map((tool) => ({ client_id: client.id, tool, rows: 2, outcome: "ok" })));

        // Any other name, well formed or not, is no row of the table: the foreign key refuses it.
        for (const tool of ["send_message", "get_secrets", "Search", "search ", ""]) {
          expect(
            await sqlState(() => readAs(db, client.token, (query) => logCall(query, tool, 0, "ok"))),
            `tool "${tool}"`,
          ).toBe("23503");
        }
        // An unknown outcome and a negative count still fail the table's checks.
        expect(
          await sqlState(() => readAs(db, client.token, (query) => logCall(query, "find_messages", 0, "fine"))),
        ).toBe("23514");
        expect(
          await sqlState(() => readAs(db, client.token, (query) => logCall(query, "read_message", -1, "ok"))),
        ).toBe("23514");
        expect(one(await queryAs<{ n: number }>(db.urls.admin, "select count(*)::int as n from policy.calls")).n).toBe(
          TOOL_NAMES.length,
        );
      }));
  });

  describe("policy.tool_names has row-level security forced and exactly three policies", () => {
    it("only a migration adds a tool name", () =>
      withDatabase(async (db) => {
        const client = await insertClient(db, "own-only", ["own"]);
        const names = async (): Promise<string[]> =>
          (await queryAs<{ name: string }>(db.urls.admin, "select name from policy.tool_names"))
            .map((row) => row.name)
            .sort();
        const migrated = [...SERVED_TOOLS, "request_research"].sort();
        // As pi_reader under a client's token, as pi_writer and as pi_admin.
        const as = {
          pi_reader: (sql: string) => sqlState(() => readAs(db, client.token, (query) => query(sql))),
          pi_writer: (sql: string) => sqlState(() => queryAs(db.urls.writer, sql)),
          pi_admin: (sql: string) => sqlState(() => queryAs(db.urls.admin, sql)),
        };
        const asOwnerState = (sql: string) => sqlState(() => asOwner(db, (query) => query(sql)));

        // The table: forced row-level security, exactly the three policies, and one grant.
        expect(
          await queryAs(
            db.urls.admin,
            "select relrowsecurity as enabled, relforcerowsecurity as forced, pg_get_userbyid(relowner)::text as owner from pg_class where oid = 'policy.tool_names'::regclass",
          ),
        ).toEqual([{ enabled: true, forced: true, owner: "pi_owner" }]);
        const policies = await queryAs<{
          name: string;
          roles: string[];
          cmd: string;
          qual: string | null;
          check: string | null;
        }>(
          db.urls.admin,
          `select policyname::text as name, roles::text[] as roles, cmd, qual, with_check as "check" from pg_policies
           where schemaname = 'policy' and tablename = 'tool_names' order by 1`,
        );
        expect(policies).toEqual([
          { name: "pi_admin_select", roles: ["pi_admin"], cmd: "SELECT", qual: "true", check: null },
          { name: "pi_owner_insert", roles: ["pi_owner"], cmd: "INSERT", qual: null, check: "true" },
          // The read allowance reads which tools are reads, as its owner.
          { name: "pi_owner_select", roles: ["pi_owner"], cmd: "SELECT", qual: "true", check: null },
        ]);
        const grants = await queryAs<{ grantee: string; privilege: string }>(
          db.urls.admin,
          `select coalesce(g.rolname::text, 'PUBLIC') as grantee, a.privilege_type::text as privilege
           from pg_class c cross join lateral aclexplode(c.relacl) a left join pg_roles g on g.oid = a.grantee
           where c.oid = 'policy.tool_names'::regclass and a.grantee <> c.relowner`,
        );
        expect(grants).toEqual([{ grantee: "pi_admin", privilege: "SELECT" }]);

        // A select: pi_admin reads every name the migrations add; pi_reader and pi_writer are refused.
        const select = "select name from policy.tool_names";
        expect(await as.pi_reader(select)).toBe("42501");
        expect(await as.pi_writer(select)).toBe("42501");
        expect(await as.pi_admin(select)).toBeNull();
        expect(await names()).toEqual(migrated);

        // An insert: no runtime role may. The positive control is the same statement as pi_owner,
        // as a migration runs it (rolled back here).
        const insert = "insert into policy.tool_names (name) values ('probe_tool')";
        for (const role of ["pi_admin", "pi_writer", "pi_reader"] as const)
          expect(await as[role](insert), role).toBe("42501");
        expect(await asOwnerState(insert)).toBeNull();

        // A name already there fails as a duplicate: there is no `on conflict`.
        expect(await asOwnerState("insert into policy.tool_names (name) values ('search')")).toBe("23505");
        // A name that is not lower snake case, or too long, fails the table's check.
        for (const bad of ["Probe_Tool", "probe-tool", "9lives", "", `p${"x".repeat(64)}`]) {
          expect(await asOwnerState(`insert into policy.tool_names (name) values ('${bad}')`), `name "${bad}"`).toBe(
            "23514",
          );
        }
        expect(await asOwnerState(`insert into policy.tool_names (name) values ('p${"x".repeat(63)}')`)).toBeNull();

        // No runtime role can change or remove a name.
        for (const sql of [
          "update policy.tool_names set name = 'renamed_tool' where name = 'search'",
          "delete from policy.tool_names where name = 'search'",
        ]) {
          for (const role of ["pi_admin", "pi_writer", "pi_reader"] as const)
            expect(await as[role](sql), `${role}: ${sql}`).toBe("42501");
        }
        // Nor can the owner, who has a policy to read and none to change or remove: it sees every name
        // (the read allowance reads which are reads) and can touch none.
        const owner = await asOwner(db, async (query) => ({
          seen: one(await query<{ n: number }>("select count(*)::int as n from policy.tool_names")).n,
          updated: one(
            await query<{ n: number }>(
              "with changed as (update policy.tool_names set name = name || '_x' returning 1) select count(*)::int as n from changed",
            ),
          ).n,
          deleted: one(
            await query<{ n: number }>(
              "with gone as (delete from policy.tool_names returning 1) select count(*)::int as n from gone",
            ),
          ).n,
        }));
        expect(owner).toEqual({ seen: migrated.length, updated: 0, deleted: 0 });

        // After all of it the table holds those names, as they were.
        expect(await names()).toEqual(migrated);
      }));
  });

  it("a message's category is one of the five", () =>
    withDatabase((db) =>
      session(db.urls.admin, async (query) => {
        const seed = seeder(db, query);
        // The positive control: each of the five is accepted.
        for (const category of ["primary", "updates", "social", "forums", "promotions"]) {
          expect(await refusal(() => seed.message(["own"], undefined, { category })), category).toBeNull();
        }
        for (const category of ["spam", "Primary", "inbox", "", "primary "]) {
          expect(
            (await refusal(() => seed.message(["own"], undefined, { category })))?.code,
            `category "${category}"`,
          ).toBe("23514");
        }
        // And it is never null: a message always has one.
        expect((await refusal(() => seed.message(["own"], undefined, { category: null })))?.code).toBe("23502");
        expect(
          (await query<{ category: string }>("select distinct category from knowledge.messages order by 1")).map(
            (row) => row.category,
          ),
        ).toEqual(["forums", "primary", "promotions", "social", "updates"]);
      }),
    ));

  describe("a message's text is stored twice, sealed both times and nowhere else", () => {
    it("a body envelope moved to the blob's row, and the blob's to the body column, does not open", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const raw = mailItem(WITH_TEXT, personalMail);
        expect(await ingestMail(writer, personalMail, WITH_TEXT)).toBe("stored");

        const stored = one(
          await queryAs<{ id: string; body_enc: unknown; blob_ref: string; envelope: unknown }>(
            db.urls.admin,
            `select m.id, m.body_enc, e.blob_ref, b.envelope from knowledge.messages m
             join vault.evidence_items e on e.id = m.evidence_id join vault.evidence_blobs b on b.blob_ref = e.blob_ref
             where m.evidence_id = $1`,
            [evidenceIdOf(personalMail, raw.sourceItemId)],
          ),
        );
        const body = { table: "knowledge.messages", id: stored.id, column: "body_enc" };
        const blob = { table: "vault.evidence_blobs", id: stored.blob_ref, column: "envelope" };

        // The positive control: each opens at its own row and column, under the one key that
        // sealed both. The text in `knowledge` is the facts' text; the blob holds the payload.
        expect(opened(db, "own", body, stored.body_enc)).toBe(WITH_TEXT.text);
        expect(opened(db, "own", blob, stored.envelope)).toBe(raw.payload);

        // Neither opens as the other.
        expect(thrownBy(() => opened(db, "own", blob, stored.body_enc))).toMatchObject({
          name: "CryptoError",
          code: "open_failed",
        });
        expect(thrownBy(() => opened(db, "own", body, stored.envelope))).toMatchObject({
          name: "CryptoError",
          code: "open_failed",
        });

        // And nowhere else: no column holds the text in clear.
        expect(await scanForPlaintext(db.urls.admin, [WITH_TEXT.text ?? "", "lamp oil order went out"])).toEqual([]);
      }));
  });

  describe("pi_reader reads a message's row, its text included, only when the row's compartments are within the current client's", () => {
    it("the reader reads a message's text within its clearance, and no vault table", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail, workMail } = await connect(writer);
        expect(await ingestMail(writer, personalMail, WITH_TEXT)).toBe("stored");
        // A message the owner sent, so `vault.sent_recipients` holds a row, and one under the
        // employer's compartment.
        expect(await ingestMail(writer, personalMail, SENT_WITH_CANARY_BODY)).toBe("stored");
        expect(await ingestMail(writer, workMail, WORK_WITH_TEXT)).toBe("stored");
        expect(
          one(await queryAs<{ n: number }>(db.urls.admin, "select count(*)::int as n from vault.sent_recipients")).n,
        ).toBe(1);

        const ownClient = await insertClient(db, "own-only", ["own"]);
        const employerClient = await insertClient(db, "employer-only", ["employer:example"]);
        const publicClient = await insertClient(db, "public-only", ["public"]);
        const texts = async (client: TestClient): Promise<string[]> => {
          const rows = await readAs(db, client.token, (query) =>
            query<{ id: string; compartments: string[]; body_enc: unknown }>(
              "select id, compartments, body_enc from knowledge.messages where body_enc is not null",
            ),
          );
          return rows
            .map((row) =>
              opened(
                db,
                row.compartments[0] ?? "",
                { table: "knowledge.messages", id: row.id, column: "body_enc" },
                row.body_enc,
              ),
            )
            .sort();
        };

        // The positive control: the row's `body_enc`, read as the reader under a token cleared
        // for it, opens to the text.
        expect(await texts(ownClient)).toEqual([WITH_TEXT.text, SENT_WITH_CANARY_BODY.text].sort());
        // A client cleared for another compartment sees none of those rows, and one cleared for
        // neither sees none at all.
        expect(await texts(employerClient)).toEqual([WORK_WITH_TEXT.text]);
        expect(await texts(publicClient)).toEqual([]);
        expect(await readAs(db, publicClient.token, (query) => query("select id from knowledge.messages"))).toEqual([]);

        // No vault table: the same client that reads the text may read neither the payload nor
        // whom the owner wrote to. pi_admin, who may, is the control for each statement.
        for (const sql of [
          "select count(*) from vault.evidence_blobs",
          "select envelope from vault.evidence_blobs",
          "select count(*) from vault.sent_recipients",
          "select address_fp from vault.sent_recipients",
        ]) {
          expect(await sqlState(() => readAs(db, ownClient.token, (query) => query(sql))), sql).toBe("42501");
          expect(await sqlState(() => queryAs(db.urls.admin, sql)), `control: ${sql}`).toBeNull();
        }
        expect(
          await queryAs(
            db.urls.admin,
            `select has_table_privilege('pi_reader', 'vault.evidence_blobs', 'SELECT') as blobs, has_table_privilege('pi_reader', 'vault.sent_recipients', 'SELECT') as recipients,
                    has_schema_privilege('pi_reader', 'vault', 'USAGE') as vault`,
          ),
        ).toEqual([{ blobs: false, recipients: false, vault: false }]);
      }));
  });

  describe("no column holds an unkeyed hash of content", () => {
    it("no hash of a canary is in any column", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const raw = mailItem(SENT_WITH_CANARY_BODY, personalMail);
        const body = SENT_WITH_CANARY_BODY.text ?? "";
        // The plain hashes whoever holds the database could test a guess against: of the payload,
        // of the body as it is, and the shared body hash, which drops the quoted reply first.
        const hashes = {
          payload: createHash("sha256").update(Buffer.from(raw.payload, "base64")).digest("hex"),
          body: sha256Hex(body),
          shared: await messageBodyHash(body),
        };
        expect(hashes.shared).not.toBe(hashes.body);
        expect(await ingestMail(writer, personalMail, SENT_WITH_CANARY_BODY)).toBe("stored");

        // Both columns are filled for it, so the scan has something to find a hash in.
        const evidenceId = evidenceIdOf(personalMail, raw.sourceItemId);
        const evidence = one(
          await queryAs<{ content_hash: string }>(
            db.urls.admin,
            "select content_hash from vault.evidence_items where id = $1",
            [evidenceId],
          ),
        );
        const interaction = one(
          await queryAs<{ id: string; body_hash: string | null }>(
            db.urls.admin,
            "select id, body_hash from knowledge.interaction_log where evidence_id = $1",
            [evidenceId],
          ),
        );
        expect(evidence.content_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(interaction.body_hash).toMatch(/^[0-9a-f]{64}$/);

        const needles = Object.values(hashes);
        expect(await scanForPlaintext(db.urls.admin, needles)).toEqual([]);

        // The positive control: the same scan finds each plain hash once it is planted.
        const found = async (needle: string): Promise<string[]> =>
          (await scanForPlaintext(db.urls.admin, [needle]))
            .map((hit) => `${hit.table.split(".").pop() ?? ""}.${hit.column}`)
            .sort();
        // The database refuses a changed content hash: planted with the content triggers off.
        await tampering(db, () =>
          queryAs(db.urls.admin, "update vault.evidence_items set content_hash = $1 where id = $2", [
            hashes.payload,
            evidenceId,
          ]),
        );
        expect(await found(hashes.payload)).toEqual(["evidence_items.content_hash"]);
        await queryAs(db.urls.admin, "update knowledge.interaction_log set body_hash = $1 where id = $2", [
          hashes.shared,
          interaction.id,
        ]);
        expect(await found(hashes.shared)).toEqual(["interaction_log.body_hash"]);
        await queryAs(db.urls.admin, "update knowledge.interaction_log set body_hash = $1 where id = $2", [
          hashes.body,
          interaction.id,
        ]);
        expect(await found(hashes.body)).toEqual(["interaction_log.body_hash"]);
      }));
  });

  it("a message's length, attachment count and unreadable mark are in no clear column", () =>
    withStore(async ({ db, writer }) => {
      const columns = await queryAs<{ name: string; type: string; required: boolean }>(
        db.urls.admin,
        `select a.attname::text as name, t.typname::text as type, a.attnotnull as required
         from pg_attribute a join pg_type t on t.oid = a.atttypid
         where a.attrelid = 'knowledge.messages'::regclass and a.attnum > 0 and not a.attisdropped order by 1`,
      );
      const column = (name: string, type: string, required: boolean) => ({ name, type, required });
      expect(columns).toEqual(
        [
          column("id", "text", true),
          column("evidence_id", "text", true),
          column("sent_at", "timestamptz", true),
          column("direction", "text", true),
          column("bulk", "bool", true),
          column("category", "text", true),
          column("held", "bool", true),
          // A worker asked to restrict it, and sync has not yet relabelled it.
          column("restricting", "bool", true),
          column("thread_fp", "text", false),
          column("sender_fp", "text", false),
          column("sender_domain_fp", "text", false),
          column("compartments", "_text", true),
          column("subject_enc", "jsonb", false),
          column("thread_id_enc", "jsonb", false),
          column("sender_enc", "jsonb", false),
          column("sender_name_enc", "jsonb", false),
          column("body_enc", "jsonb", false),
          column("facts_enc", "jsonb", true),
          // Whether it authenticates, a word, read by the evidence order.
          column("auth", "text", true),
        ].sort((left, right) => (left.name < right.name ? -1 : 1)),
      );
      // So no column could hold a length or a count: none is a number.
      expect(columns.filter((one) => /^(int|numeric|float)/.test(one.type))).toEqual([]);
      expect(
        await queryAs(
          db.urls.admin,
          "select column_default from information_schema.columns where table_schema = 'knowledge' and table_name = 'messages' and column_name = 'held'",
        ),
      ).toEqual([{ column_default: "false" }]);

      // Where they are instead: sealed, with the message's other facts.
      const { personalMail } = await connect(writer);
      expect(await ingestMail(writer, personalMail, UNREADABLE)).toBe("stored");
      const row = one(
        await queryAs<{ id: string; facts_enc: unknown }>(
          db.urls.admin,
          "select id, facts_enc from knowledge.messages where evidence_id = $1",
          [evidenceIdOf(personalMail, mailSourceId(UNREADABLE))],
        ),
      );
      const facts = JSON.parse(
        opened(db, "own", { table: "knowledge.messages", id: row.id, column: "facts_enc" }, row.facts_enc),
      ) as Record<string, unknown>;
      expect(facts).toMatchObject({ chars: 0, unreadable: true, attachments: UNREADABLE.attachments });
    }));

  describe("knowledge.messages.held and vault.evidence_items.answers_system are clear booleans, and hold_released_at a clear time", () => {
    it("the reader cannot change a held mark", () =>
      withDatabase(async (db) => {
        const { held, evidenceId } = await session(db.urls.admin, async (query) => {
          const seed = seeder(db, query);
          const account = await seed.sourceAccount(["own"]);
          const evidence = await seed.evidence(["own"], account);
          return { held: await seed.message(["own"], evidence, { held: true }), evidenceId: evidence };
        });
        const client = await insertClient(db, "own-only", ["own"]);

        // The three columns, with their expected types.
        const typed = await queryAs<{ place: string; type: string; required: boolean }>(
          db.urls.admin,
          `select c.relname || '.' || a.attname as place, t.typname::text as type, a.attnotnull as required
           from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_type t on t.oid = a.atttypid
           where (a.attrelid = 'knowledge.messages'::regclass and a.attname = 'held')
              or (a.attrelid = 'vault.evidence_items'::regclass and a.attname in ('answers_system', 'hold_released_at'))
           order by 1`,
        );
        expect(typed).toEqual([
          { place: "evidence_items.answers_system", type: "bool", required: true },
          { place: "evidence_items.hold_released_at", type: "timestamptz", required: false },
          { place: "messages.held", type: "bool", required: true },
        ]);

        const statements: [string, unknown[]][] = [
          ["update knowledge.messages set held = false where id = $1", [held]],
          ["update vault.evidence_items set answers_system = true where id = $1", [evidenceId]],
          ["update vault.evidence_items set hold_released_at = now() where id = $1", [evidenceId]],
        ];
        // As pi_reader, under a token cleared for the row's compartment: no privilege changes one.
        for (const [sql, values] of statements) {
          expect(await sqlState(() => readAs(db, client.token, (query) => query(sql, values))), sql).toBe("42501");
        }
        const marks = () =>
          queryAs(
            db.urls.admin,
            `select m.held, e.answers_system, e.hold_released_at is not null as released
             from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where m.id = $1`,
            [held],
          );
        expect(await marks()).toEqual([{ held: true, answers_system: false, released: false }]);

        // The positive control: the same statements as pi_admin, who releases a message.
        for (const [sql, values] of statements)
          expect(await sqlState(() => queryAs(db.urls.admin, sql, values)), `control: ${sql}`).toBeNull();
        expect(await marks()).toEqual([{ held: false, answers_system: true, released: true }]);
      }));

    // The hold is enforced by the reader's own row policy on `knowledge.messages`, which carries
    // `and not held`.
    it("the reader's row policy returns no held message", () =>
      withDatabase(async (db) => {
        const { held, free } = await session(db.urls.admin, async (query) => {
          const seed = seeder(db, query);
          const account = await seed.sourceAccount(["own"]);
          return {
            held: await seed.message(["own"], await seed.evidence(["own"], account), { held: true }),
            free: await seed.message(["own"], await seed.evidence(["own"], account), { held: false }),
          };
        });
        const ownClient = await insertClient(db, "own-only", ["own"]);
        const bothClient = await insertClient(db, "both", ["own", "employer:example"]);
        const seen = async (client: TestClient): Promise<string[]> =>
          (
            await readAs(db, client.token, (query) =>
              query<{ id: string }>("select id from knowledge.messages order by id"),
            )
          ).map((row) => row.id);

        // The positive control: both rows are there, under the one compartment, one of them held.
        expect(
          await queryAs(
            db.urls.admin,
            "select count(*)::int as n, count(*) filter (where held)::int as held, array_agg(distinct compartments::text) as compartments from knowledge.messages",
          ),
        ).toEqual([{ n: 2, held: 1, compartments: ["{own}"] }]);

        // A reader cleared for that compartment selects exactly the one that is not held,
        // however it asks, and however wide its clearance.
        expect(await seen(ownClient)).toEqual([free]);
        expect(await seen(bothClient)).toEqual([free]);
        await readAs(db, ownClient.token, async (query) => {
          expect(await query("select count(id)::int as n from knowledge.messages")).toEqual([{ n: 1 }]);
          expect(await query("select id from knowledge.messages where id = $1", [held])).toEqual([]);
          expect(await query("select id from knowledge.messages where held")).toEqual([]);
        });

        // Once the owner's role releases it, the same session reads both.
        await queryAs(db.urls.admin, "update knowledge.messages set held = false where id = $1", [held]);
        expect(await seen(ownClient)).toEqual([held, free].sort());
      }));
  });
});
