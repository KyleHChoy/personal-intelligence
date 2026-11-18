import { seedClaim } from "./seed-claim.ts";
import { checkSeeds } from "./seeder-checks.ts";
// Rows written in SQL as pi_admin, for the rules that are about the database alone.

import { randomBytes } from "node:crypto";
import type { Envelope } from "@intelligence/contracts";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import { SourceAccountId } from "@intelligence/contracts/personal";
import { sealUnder } from "../core/seal.ts";
import { ALL_TOOLS, ALL_VIEWS, hashFingerprint, sha256Hex, testId } from "./clients.ts";
import { one, type Query, session } from "./connections.ts";
import { fingerprint, queryAs, sealRow, type TestDatabase } from "./database.ts";
import { measureSeeds } from "./seeder-measure.ts";
import { promotionSeeds } from "./seeder-promotion.ts";
import { timeSeeds } from "./seeder-time.ts";
import { warmthSeeds } from "./seeder-warmth.ts";
import { interactionId } from "./values.ts";

// ---------------------------------------------------------------------------------------------
// Rows written in SQL as pi_admin, for the rules that are about the database alone
// ---------------------------------------------------------------------------------------------

const SEED_AT = "2026-09-01T00:00:00Z";

// One well-formed row per call, with the compartments given and fresh parents under `own`
// where none are handed in. Each statement commits by itself, so a refused row leaves the
// rest standing.
// A Lens device as the seeder registers it: its two clients, with their tokens, and its three
// source accounts by the kind of item each holds.
export type LensDevice = {
  name: string;
  capture: { id: string; token: string };
  mirror: { id: string; token: string };
  accounts: { meeting: string; moment: string; block: string };
};

export function seeder(db: TestDatabase, query: Query) {
  let serial = 0;
  const own = ["own"];
  const seal = (compartments: string[], table: string, id: string, column: string, value: string): Envelope =>
    sealRow(db.keys, compartments[0] ?? "own", { table, id, column }, value);
  const insert = async (table: string, row: Record<string, unknown>): Promise<void> => {
    const columns = Object.keys(row);
    const values = columns.map((column) => row[column]);
    await query(
      `insert into ${table} (${columns.join(", ")}) values (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
      values,
    );
  };

  const client = async (compartments: string[]): Promise<string> => {
    const id = testId("cli");
    serial += 1;
    await insert("policy.clients", {
      id,
      // Unique across seeders, each counting from one; lower case, as a client name must be.
      name: `seed-client-${serial}-${id.slice(-8).toLowerCase()}`,
      token_hash: sha256Hex(`seed-token-${serial}-${id}`),
      vendor_retention: "none",
      runtime: "local",
      compartments,
      views: ALL_VIEWS,
      tools: ALL_TOOLS,
    });
    return id;
  };

  const sourceAccount = async (compartments: string[] = own): Promise<SourceAccountId> => {
    const id = SourceAccountId.parse(testId("acc"));
    serial += 1;
    const address = `seed-owner-${serial}@seed-accounts.test`;
    await insert("vault.source_accounts", {
      id,
      // The id's tail too: two seeders on one database count from one each.
      label: `seed-${serial}-${id.slice(-8)}`,
      connector: "google_mail",
      source_kind: "email",
      compartments,
      address_fp: fingerprint(db.keys, "address", address),
      address_enc: seal(compartments, "vault.source_accounts", id, "address_enc", address),
    });
    return id;
  };

  const blob = async (compartments: string[] = own): Promise<string> => {
    const blobRef = testId("blb");
    serial += 1;
    await insert("vault.evidence_blobs", {
      blob_ref: blobRef,
      compartments,
      envelope: seal(
        compartments,
        "vault.evidence_blobs",
        blobRef,
        "envelope",
        Buffer.from(`seed payload ${serial}`).toString("base64"),
      ),
    });
    return blobRef;
  };

  // With no blob handed in, the row gets a blob of its own.
  const evidence = async (
    compartments: string[] = own,
    account?: SourceAccountId,
    citedBlob?: string,
  ): Promise<string> => {
    const sourceAccountId = account ?? (await sourceAccount());
    const blobRef = citedBlob ?? (await blob());
    serial += 1;
    const sourceItemId = `seed-item-${serial}`;
    const at = { vault: "personal" as const, sourceAccount: sourceAccountId, sourceItemId };
    const id = evidenceIdFor({ ...at, revision: 0 });
    await insert("vault.evidence_items", {
      id,
      source_account_id: sourceAccountId,
      source_kind: "email",
      source_item_fp: fingerprint(db.keys, "source_id", sourceItemId),
      revision_tag_fp: fingerprint(db.keys, "revision_tag", `h:${sourceItemId}`),
      revision: 0,
      next_revision_id: evidenceIdFor({ ...at, revision: 1 }),
      content_hash: hashFingerprint(db.keys, "content_hash", sha256Hex(`seed payload ${serial}`)),
      media_type: "message/rfc822",
      observed_at: SEED_AT,
      change_kind: "backfill",
      participant_members: ["m-owner"],
      system_originated: false,
      answers_system: false,
      payload_state: "present",
      compartments,
      readers: ["m-owner"],
      blob_ref: blobRef,
      item_enc: seal(
        compartments,
        "vault.evidence_items",
        id,
        "item_enc",
        JSON.stringify({ sourceItemId, markers: [] }),
      ),
    });
    return id;
  };

  const listedItem = async (compartments: string[], account?: SourceAccountId): Promise<void> => {
    serial += 1;
    await insert("vault.listed_items", {
      account_id: account ?? (await sourceAccount()),
      source_item_fp: fingerprint(db.keys, "source_id", `seed-listed-${serial}`),
      compartments,
    });
  };

  // One address the owner wrote to in a stored sent message: by its fingerprint alone.
  const sentRecipient = async (
    compartments: string[],
    evidenceId?: string,
    account?: SourceAccountId,
  ): Promise<void> => {
    const accountId = account ?? (await sourceAccount());
    serial += 1;
    await insert("vault.sent_recipients", {
      evidence_id: evidenceId ?? (await evidence(own, accountId)),
      address_fp: fingerprint(db.keys, "address", `seed-recipient-${serial}@seed-recipients.test`),
      account_id: accountId,
      compartments,
    });
  };

  const entity = async (kind: "person" | "organization" | "project" = "person"): Promise<string> => {
    const id = testId("ent");
    await insert("knowledge.entities", { id, kind });
    return id;
  };
  const account = async (compartments: string[], entityId?: string): Promise<string> => {
    const id = testId("adr");
    serial += 1;
    const domain = `seed-org-${serial}.test`;
    const address = `seed-person-${serial}@${domain}`;
    await insert("knowledge.accounts", {
      id,
      entity_id: entityId ?? (await entity("person")),
      kind: "email",
      value_fp: fingerprint(db.keys, "address", address),
      domain_fp: fingerprint(db.keys, "domain", domain),
      compartments,
      value_enc: seal(compartments, "knowledge.accounts", id, "value_enc", address),
    });
    return id;
  };

  const domain = async (compartments: string[], entityId?: string): Promise<string> => {
    const id = testId("dom");
    serial += 1;
    const value = `seed-domain-${serial}.test`;
    await insert("knowledge.domains", {
      id,
      domain_fp: fingerprint(db.keys, "domain", value),
      entity_id: entityId ?? (await entity("organization")),
      compartments,
      domain_enc: seal(compartments, "knowledge.domains", id, "domain_enc", value),
    });
    return id;
  };

  const alias = async (compartments: string[], entityId?: string, evidenceId?: string, as?: string) => {
    const id = testId("als");
    serial += 1;
    const name = as ?? `Seed Name ${serial}`;
    await insert("knowledge.aliases", {
      id,
      entity_id: entityId ?? (await entity("person")),
      value_fp: fingerprint(db.keys, "name", name),
      evidence_id: evidenceId ?? (await evidence()),
      compartments,
      value_enc: seal(compartments, "knowledge.aliases", id, "value_enc", name),
    });
    return id;
  };

  // `category` is written as given, so a test can hand in one the table must refuse.
  const message = async (
    compartments: string[],
    evidenceId?: string,
    options?: { held?: boolean; category?: string | null; text?: string },
  ): Promise<string> => {
    const id = testId("msg");
    serial += 1;
    const thread = `seed-thread-${serial}`;
    const domain = `seed-senders-${serial}.test`;
    const sender = `seed-sender-${serial}@${domain}`;
    const text = options?.text ?? `Seed body ${serial}`;
    await insert("knowledge.messages", {
      id,
      evidence_id: evidenceId ?? (await evidence()),
      sent_at: SEED_AT,
      direction: "inbound",
      bulk: false,
      category: options?.category === undefined ? "primary" : options.category,
      held: options?.held ?? false,
      thread_fp: fingerprint(db.keys, "thread", thread),
      sender_fp: fingerprint(db.keys, "address", sender),
      sender_domain_fp: fingerprint(db.keys, "domain", domain),
      compartments,
      subject_enc: seal(compartments, "knowledge.messages", id, "subject_enc", `Seed subject ${serial}`),
      thread_id_enc: seal(compartments, "knowledge.messages", id, "thread_id_enc", thread),
      sender_enc: seal(compartments, "knowledge.messages", id, "sender_enc", sender),
      sender_name_enc: seal(compartments, "knowledge.messages", id, "sender_name_enc", `Seed Sender ${serial}`),
      body_enc: seal(compartments, "knowledge.messages", id, "body_enc", text),
      facts_enc: seal(
        compartments,
        "knowledge.messages",
        id,
        "facts_enc",
        JSON.stringify({ chars: [...text].length, unreadable: false, attachments: [] }),
      ),
    });
    return id;
  };

  const interaction = async (compartments: string[], evidenceId?: string, entityId?: string): Promise<string> => {
    const evidenceRef = evidenceId ?? (await evidence());
    const entityRef = entityId ?? (await entity("person"));
    const id = interactionId(evidenceRef, entityRef);
    await insert("knowledge.interaction_log", {
      id,
      evidence_id: evidenceRef,
      member_id: "m-owner",
      entity_id: entityRef,
      direction: "inbound",
      channel: "email",
      occurred_at: SEED_AT,
      compartments,
      readers: ["m-owner"],
      entity_role: "sender",
    });
    return id;
  };

  const event = async (compartments: string[], evidenceId?: string): Promise<string> => {
    const id = testId("evt");
    await insert("knowledge.events", {
      id,
      event_kind: "meeting",
      occurred_at: SEED_AT,
      evidence_id: evidenceId ?? (await evidence()),
      compartments,
      readers: ["m-owner"],
    });
    return id;
  };

  const eventDetails = async (
    compartments: string[],
    eventId?: string,
    accountId?: SourceAccountId,
  ): Promise<string> => {
    const id = eventId ?? (await event(own));
    serial += 1;
    await insert("knowledge.event_details", {
      event_id: id,
      account_id: accountId ?? (await sourceAccount()),
      source_event_fp: fingerprint(db.keys, "source_id", `seed-event-${serial}`),
      starts_at: SEED_AT,
      ends_at: "2026-09-01T01:00:00Z",
      all_day: false,
      cancelled: false,
      compartments,
      title_enc: seal(compartments, "knowledge.event_details", id, "title_enc", `Seed title ${serial}`),
    });
    return id;
  };

  const eventParticipant = async (compartments: string[], eventId?: string, entityId?: string): Promise<void> => {
    await insert("knowledge.event_participants", {
      event_id: eventId ?? (await event(own)),
      entity_id: entityId ?? (await entity("person")),
      participant_role: "participant",
      compartments,
    });
  };

  // From the extraction migration. A row of each, under the compartments given, with its parent
  // made under the same ones where none is handed in: a claim's label is its evidence's.
  const sealedJson = (compartments: string[], table: string, id: string, column: string, value: unknown) =>
    seal(compartments, table, id, column, JSON.stringify(value));
  const parentEvidence = async (compartments: string[], evidenceId?: string): Promise<string> =>
    evidenceId ??
    (await evidence(
      compartments.length === 0 ? own : compartments,
      await sourceAccount(compartments.length === 0 ? own : compartments),
    ));

  const pipelineItem = async (compartments: string[], evidenceId?: string): Promise<string> => {
    const id = await parentEvidence(compartments, evidenceId);
    await insert("vault.pipeline_items", {
      evidence_id: id,
      waiting: false,
      withheld: false,
      screened: true,
      extractor_generation: 1,
      compartments,
      facts_enc: sealedJson(compartments, "vault.pipeline_items", id, "facts_enc", {
        lane: "correspondence",
        override: false,
        status: "done",
        attempts: 0,
        claims: 0,
        unmapped: 0,
        unresolved: 0,
      }),
    });
    return id;
  };

  const modelCall = async (compartments: string[], evidenceId?: string): Promise<string> => {
    const id = testId("mcl");
    serial += 1;
    await insert("vault.model_calls", {
      id,
      evidence_id: await parentEvidence(compartments, evidenceId),
      revision: 0,
      prompt_id: "personal_correspondence",
      prompt_version: "1",
      input_fp: fingerprint(db.keys, "model_input", sha256Hex(`seed input ${serial}`)),
      model_id: "seed/model",
      compartments,
      output_enc: seal(compartments, "vault.model_calls", id, "output_enc", '{"claims":[],"narrowing":"none"}'),
    });
    return id;
  };

  // One member of a group's saved call, the call and the member's evidence row its own.
  const modelCallMember = async (compartments: string[]): Promise<string> => {
    const label = compartments.length === 0 ? own : compartments;
    const call = await modelCall(label);
    const evidenceId = await parentEvidence(label);
    await insert("vault.model_call_members", { call_id: call, evidence_id: evidenceId, compartments });
    return `${call}/${evidenceId}`;
  };

  const modelUsage = async (compartments: string[]): Promise<string> => {
    const id = testId("mus");
    await insert("vault.model_usage", {
      id,
      prompt_id: "personal_correspondence",
      prompt_version: "1",
      model_id: "seed/model",
      input_tokens: 10,
      output_tokens: 5,
      cost_microusd: 100,
      outcome: "ok",
      day: SEED_AT.slice(0, 10),
      compartments,
    });
    return id;
  };

  const extractionRun = async (compartments: string[]): Promise<void> => {
    const counts = [
      "done",
      "skipped",
      "withheld",
      "failed",
      "waiting",
      "claims",
      "unmapped",
      "unresolved",
      "live_calls",
      "beliefs",
      "beliefs_changed",
      "beliefs_mixed",
      "beliefs_failed",
      "beliefs_removed",
      "rebuild_ms",
    ];
    await insert("vault.extraction_runs", {
      day: SEED_AT.slice(0, 10),
      code: "ok",
      ...Object.fromEntries(counts.map((name) => [name, 0])),
      compartments,
    });
  };

  const unmappedClaim = async (compartments: string[], evidenceId?: string): Promise<string> => {
    serial += 1;
    const id = fingerprint(db.keys, "claim", sha256Hex(`seed unmapped ${serial}`));
    await insert("vault.unmapped_claims", {
      id,
      evidence_id: await parentEvidence(compartments, evidenceId),
      extractor_generation: 1,
      compartments,
      facts_enc: sealedJson(compartments, "vault.unmapped_claims", id, "facts_enc", {
        proposedType: "commitment",
        reason: "bad_fields",
        pipelineVersion: "1",
      }),
    });
    return id;
  };

  const review = async (compartments: string[], evidenceId?: string): Promise<string> => {
    const id = testId("rvw");
    await insert("vault.extraction_reviews", {
      id,
      evidence_id: await parentEvidence(compartments, evidenceId),
      claim_id: null,
      extractor_generation: 1,
      compartments,
      facts_enc: sealedJson(compartments, "vault.extraction_reviews", id, "facts_enc", {
        type: "commitment",
        verdict: "missed",
        modelId: "seed/model",
      }),
    });
    return id;
  };

  // A claim, its record sealed whole, of the shape the pipeline seals.
  const claim = async (compartments: string[], evidenceId?: string, type = "plan"): Promise<string> => {
    const n = ++serial;
    const id = fingerprint(db.keys, "claim", sha256Hex(`seed claim ${n}`));
    const content = seedClaim(n, await parentEvidence(compartments, evidenceId), compartments, type);
    await insert("knowledge.claims", {
      id,
      evidence_id: content.claim.primaryEvidenceId,
      // A plan, by default, builds no belief; a commitment does, computed when asked.
      type,
      valid_from: SEED_AT,
      fact_key_fp: fingerprint(db.keys, "fact", content.factKey),
      extractor_generation: 1,
      readers: ["m-owner"],
      compartments,
      content_enc: sealedJson(compartments, "knowledge.claims", id, "content_enc", content),
    });
    return id;
  };

  // Each returns the claim key it made.
  const claimValue = async (compartments: string[], claimId?: string): Promise<string> => {
    const claimRef = claimId ?? (await claim(compartments.length === 0 ? own : compartments));
    serial += 1;
    const claimKey = sha256Hex(`seed claim key ${serial} ${claimRef}`);
    await insert("knowledge.claim_values", {
      claim_id: claimRef,
      claim_key: claimKey,
      value_fp: sha256Hex(`seed value ${serial}`),
      compartments,
    });
    return claimKey;
  };
  // Each returns its row's key.
  const claimOrgName = async (compartments: string[]): Promise<string> => {
    const claimRef = await claim(compartments.length === 0 ? own : compartments);
    serial += 1;
    await queryAs(
      db.urls.pipeline,
      "insert into knowledge.claim_org_names (claim_id, name_fp, compartments) values ($1, $2, $3)",
      [claimRef, fingerprint(db.keys, "name", `Seed Org ${serial}`), compartments],
    );
    return claimRef;
  };
  const orgName = async (compartments: string[]): Promise<string> => {
    const organization = await entity("organization");
    const item = await evidence(compartments.length === 0 ? own : compartments);
    const id = testId("onn");
    serial += 1;
    await queryAs(
      db.urls.writer,
      "insert into knowledge.org_names (id, entity_id, name_fp, name_enc, evidence_id, compartments) values ($1, $2, $3, $4, $5, $6)",
      [
        id,
        organization,
        fingerprint(db.keys, "name", `Seed Org ${serial}`),
        seal(compartments, "knowledge.org_names", id, "name_enc", `Seed Org ${serial}`),
        item,
        compartments,
      ],
    );
    return id;
  };
  const claimRelation = async (compartments: string[]): Promise<string> => {
    const label = compartments.length === 0 ? own : compartments;
    const from = await claimValue(label);
    await query(
      "insert into knowledge.claim_relations (from_claim_key, to_claim_key, kind, judged_by, version, compartments) values ($1, $2, 'same_fact', 'rule:seed', 1, $3)",
      [from, await claimValue(label), compartments.length === 0 ? [] : [...new Set(compartments)].sort()],
    );
    return from;
  };

  const sameFactJudgment = async (compartments: string[]): Promise<string> => {
    const label = compartments.length === 0 ? own : compartments;
    const [row] = await queryAs<{ a: string }>(
      db.urls.pipeline,
      `insert into knowledge.same_fact_judgments (a_fp, b_fp, a_claim, b_claim, band, rung, state, pair_at, compartments)
       select min(fact_key_fp), max(fact_key_fp), (array_agg(id order by fact_key_fp))[1], (array_agg(id order by fact_key_fp))[2],
         'accept', 1, 'proposed', $2, $3 from knowledge.claims where id = any ($1) returning a_fp as a`,
      [[await claim(label), await claim(label)], SEED_AT, compartments.length === 0 ? [] : [...new Set(label)].sort()],
    );
    return row?.a ?? "";
  };

  const relationCheck = async (compartments: string[]): Promise<string> => {
    const claimKey = await claimValue(compartments.length === 0 ? own : compartments);
    await queryAs(
      db.urls.pipeline,
      "insert into ledger.relation_checks (claim_key, claim_id, judge, state, compartments) values ($1, 'seed-claim', 'model:seed/model@personal_claim_relations@1', 'unjudged', $2)",
      [claimKey, compartments.length === 0 ? [] : [...new Set(compartments)].sort()],
    );
    return claimKey;
  };

  const outcomeCheck = async (compartments: string[]): Promise<void> => {
    const label = compartments.length === 0 ? own : compartments;
    await expectedOutcome(label);
    const [expectation] = await query<{ id: string }>(
      "select id::text from ledger.expected_outcomes order by id desc limit 1",
    );
    await queryAs(
      db.urls.pipeline,
      "insert into ledger.outcome_checks (expected_outcome_id, evidence_id, path, judge, state, compartments) values ($1::bigint, $2, 'open', 'model:seed/model@personal_outcome_judge@1', 'unjudged', $3)",
      [
        expectation?.id,
        await parentEvidence(label),
        compartments.length === 0 ? [] : [...new Set(compartments)].sort(),
      ],
    );
  };

  const { sourceCheck, recallCheck, surfacedItem } = checkSeeds(db, claimValue, own);

  const goalKeyRuling = async (compartments: string[]): Promise<string> => {
    const ruling = await decision(compartments.length === 0 ? own : compartments);
    await insert("knowledge.goal_key_rulings", {
      ruling_id: ruling,
      verdict: "hide",
      fact_key_fp: sha256Hex(`seed goal key ${ruling}`),
      created_at: SEED_AT,
      compartments,
    });
    return ruling;
  };
  const goalKeyRank = async (compartments: string[]): Promise<string> => {
    const key = sha256Hex(`seed goal rank ${testId("gol")}`);
    await insert("projections.goal_key_ranks", { fact_key_fp: key, rank: 1, compartments });
    return key;
  };

  const goalIdRow = async (compartments: string[]): Promise<string> => {
    const claimRef = await claim(compartments.length === 0 ? own : compartments);
    const [row] = await query<{ evidence_id: string; fact_key_fp: string }>(
      "select evidence_id, fact_key_fp from knowledge.claims where id = $1",
      [claimRef],
    );
    const ruling = await decision(compartments.length === 0 ? own : compartments);
    await insert("knowledge.goal_ids", {
      claim_id: claimRef,
      goal_id: testId("gol"),
      ruling_id: ruling,
      evidence_id: row?.evidence_id,
      fact_key_fp: row?.fact_key_fp,
      compartments,
    });
    return claimRef;
  };

  const claimEntity = async (compartments: string[], claimId?: string, entityId?: string): Promise<void> => {
    await insert("knowledge.claim_entities", {
      claim_id: claimId ?? (await claim(compartments.length === 0 ? own : compartments)),
      entity_id: entityId ?? (await entity("person")),
      compartments,
    });
  };

  // The Drive's two tables. A root of a label, its folder id (or `my-drive`, `shared-with-me`)
  // sealed under the `own` key and fingerprinted as a source id, as the admin writes one.
  const driveRoot = async (
    label: string,
    root?: string,
    mode: "extract" | "reference" = "extract",
  ): Promise<string> => {
    const id = testId("drt");
    serial += 1;
    const value = root ?? `seed-folder-${serial}`;
    const kind = value === "my-drive" || value === "shared-with-me" ? value : "folder";
    await insert("policy.drive_roots", {
      id,
      label,
      kind,
      root_fp: fingerprint(db.keys, "source_id", value),
      mode,
      created_at: SEED_AT,
      root_enc: seal(own, "policy.drive_roots", id, "root_enc", value),
    });
    return id;
  };

  // A Drive account: the third connector, with source kind `document`.
  const documentAccount = async (compartments: string[] = own): Promise<{ id: SourceAccountId; label: string }> => {
    const id = SourceAccountId.parse(testId("acc"));
    serial += 1;
    const label = `seed-drive-${serial}`;
    const address = `seed-drive-owner-${serial}@seed-accounts.test`;
    await insert("vault.source_accounts", {
      id,
      label,
      connector: "google_docs",
      source_kind: "document",
      compartments,
      address_fp: fingerprint(db.keys, "address", address),
      address_enc: seal(compartments, "vault.source_accounts", id, "address_enc", address),
    });
    return { id, label };
  };

  // One stored document: its evidence row (source kind `document`, its blob present), and its
  // row of knowledge.documents under its account's compartments and a root of its account's label.
  // The values sealed are the seeder's own unless given. The evidence is under its account's
  // compartments; with empty compartments and no account handed in, the account and the evidence
  // are made under `own`, so only the document row is refused.
  const document = async (
    compartments: string[],
    options?: {
      accountId?: SourceAccountId;
      rootId?: string;
      held?: boolean;
      title?: string;
      text?: string;
      fileId?: string;
      folderId?: string;
      owner?: { address?: string; name?: string };
    },
  ): Promise<string> => {
    const account =
      options?.accountId === undefined
        ? {
            ...(await documentAccount(compartments.length === 0 ? own : compartments)),
            compartments: compartments.length === 0 ? own : compartments,
          }
        : one(
            await query<{ id: SourceAccountId; label: string; compartments: string[] }>(
              "select id, label, compartments from vault.source_accounts where id = $1",
              [options.accountId],
            ),
          );
    const parent = account.compartments;
    serial += 1;
    const folderId = options?.folderId ?? `seed-folder-${serial}`;
    const rootId = options?.rootId ?? (await driveRoot(account.label, folderId));
    const fileId = options?.fileId ?? `seed-file-${serial}`;
    const title = options?.title ?? `Seed document ${serial}`;
    const text = options?.text ?? `Seed document text ${serial}`;
    const owner = options?.owner ?? {
      address: `seed-doc-owner-${serial}@seed-documents.test`,
      name: `Seed Owner ${serial}`,
    };
    const blobRef = await blob(parent);
    const sourceItemId = `drive-file:${fileId}`;
    const at = { vault: "personal" as const, sourceAccount: account.id, sourceItemId };
    const evidenceId = evidenceIdFor({ ...at, revision: 0 });
    await insert("vault.evidence_items", {
      id: evidenceId,
      source_account_id: account.id,
      source_kind: "document",
      source_item_fp: fingerprint(db.keys, "source_id", sourceItemId),
      revision_tag_fp: fingerprint(db.keys, "revision_tag", `d1:${sourceItemId}`),
      revision: 0,
      next_revision_id: evidenceIdFor({ ...at, revision: 1 }),
      content_hash: hashFingerprint(db.keys, "content_hash", sha256Hex(`seed document ${serial}`)),
      media_type: "text/html",
      observed_at: SEED_AT,
      change_kind: "backfill",
      participant_members: ["m-owner"],
      system_originated: false,
      answers_system: false,
      payload_state: "present",
      compartments: parent,
      readers: ["m-owner"],
      blob_ref: blobRef,
      item_enc: seal(
        parent,
        "vault.evidence_items",
        evidenceId,
        "item_enc",
        JSON.stringify({ sourceItemId, markers: ["drive"] }),
      ),
    });
    const id = testId("doc");
    const sealed = (column: string, value: string) => seal(compartments, "knowledge.documents", id, column, value);
    await insert("knowledge.documents", {
      id,
      evidence_id: evidenceId,
      source_account_id: account.id,
      compartments,
      kind: "doc",
      modified_at: SEED_AT,
      created_at: SEED_AT,
      mine: false,
      edited_by_me: false,
      reference: false,
      held: options?.held ?? false,
      root_id: rootId,
      file_fp: fingerprint(db.keys, "source_id", fileId),
      folder_fp: fingerprint(db.keys, "source_id", folderId),
      owner_fp: owner.address === undefined ? null : fingerprint(db.keys, "address", owner.address),
      sharer_fp: null,
      title_enc: sealed("title_enc", title),
      file_id_enc: sealed("file_id_enc", fileId),
      owner_enc: sealed("owner_enc", JSON.stringify(owner)),
      sharer_enc: null,
      body_enc: sealed("body_enc", text),
      outline_enc: sealed("outline_enc", JSON.stringify([{ heading: "", start: 0, end: text.length }])),
      facts_enc: sealed("facts_enc", JSON.stringify({ chars: text.length, sections: 1, size: null, unreadable: null })),
    });
    return id;
  };

  // Whether the documents migration has run: a test that applies only the earlier ones seeds a
  // world with no document.
  const documentsMigrated = async (): Promise<boolean> =>
    one(await query<{ there: boolean }>("select to_regclass('knowledge.documents') is not null as there")).there;

  // One row in every knowledge table under one compartment: a person with an account, a name, a
  // message, an interaction and a meeting, and an organization with a domain.
  const world = async (compartments: string[]) => {
    const accountId = await sourceAccount(compartments);
    const evidenceId = await evidence(compartments, accountId);
    const person = await entity("person");
    const organization = await entity("organization");
    await account(compartments, person);
    await domain(compartments, organization);
    await alias(compartments, person, evidenceId);
    await message(compartments, evidenceId);
    await interaction(compartments, evidenceId, person);
    const eventId = await event(compartments, evidenceId);
    await eventDetails(compartments, eventId, accountId);
    await eventParticipant(compartments, eventId, person);
    // From the extraction: a claim of the message that names the person.
    const claimId = await claim(compartments, evidenceId);
    await claimEntity(compartments, claimId, person);
    // From the documents migration: a document, not held, under a Drive account of the same
    // compartments.
    const documentId = (await documentsMigrated()) ? await document(compartments) : null;
    return { person, organization, evidenceId, eventId, accountId, claimId, documentId };
  };

  // The ledger's tables take rows only as pi_owner, the role the definer functions write them as.
  const asLedger = async (table: string, row: Record<string, unknown>): Promise<void> => {
    const columns = Object.keys(row);
    await session(db.urls.bootstrap, async (owner) => {
      await owner("set role pi_owner");
      await owner(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
        columns.map((column) => row[column]),
      );
    });
  };
  const ledgerSession = async (compartments: string[]): Promise<{ id: string; clientId: string }> => {
    const clientId = await client(own);
    const id = testId("ses");
    await asLedger("ledger.sessions", { id, client_id: clientId, compartments });
    return { id, clientId };
  };
  const readLog = async (compartments: string[]): Promise<void> => {
    const { id, clientId } = await ledgerSession(own);
    await asLedger("ledger.read_log", {
      session_id: id,
      client_id: clientId,
      tool: "search",
      compartments,
      bound: [],
      shown: [],
      fact_key_fps: [],
    });
  };

  // The projects' three, as pi_admin: a project and its entity, an anchor of a made-up thread, and
  // a binding of a claim of the given compartments (its label is the claim's, by binding_label).
  const project = async (compartments: string[]): Promise<string> => {
    const id = await entity("project");
    await insert("knowledge.projects", {
      id,
      status: "active",
      name_enc: seal(compartments, "knowledge.projects", id, "name_enc", "Seed project"),
      compartments,
      readers: ["m-owner"],
    });
    return id;
  };
  const projectAnchor = async (compartments: string[], projectId?: string, threadFp?: string): Promise<string> => {
    serial += 1;
    const id = testId("pan");
    await insert("knowledge.project_anchors", {
      id,
      project_id: projectId ?? (await project(compartments.length === 0 ? own : compartments)),
      kind: "email_thread",
      anchor_fp: threadFp ?? fingerprint(db.keys, "thread", `seed-thread-${serial}`),
      ruling_id: await decision(own),
      created_at: SEED_AT,
      compartments,
    });
    return id;
  };
  const projectBinding = async (compartments: string[], claimId?: string, projectId?: string): Promise<void> => {
    const claimed = claimId ?? (await claim(compartments));
    await insert("knowledge.project_bindings", {
      claim_id: claimed,
      project_id: projectId ?? (await project(compartments.length === 0 ? own : compartments)),
      anchor_kind: "email_thread",
      anchor_fp: fingerprint(db.keys, "thread", `seed-binding-${claimed}`),
      basis: "anchor",
      compartments,
      readers: ["m-owner"],
    });
  };

  // The owner surface's five tables: a decision, a veto and a card as pi_admin, which inserts them;
  // a basis row as pi_owner, as ledger.add_basis writes it.
  const decision = async (compartments: string[]): Promise<string> => {
    const id = testId("rul");
    await insert("knowledge.owner_decisions", {
      id,
      request_id: testId("req"),
      kind: "release",
      queue_depth: 0,
      labels: [],
      details: {},
      decided_at: SEED_AT,
      compartments,
    });
    return id;
  };
  // The mentions' two: a filed mention as the pipeline writes it, and a binding as the owner's bind
  // writes it, its decision under a compartment so only the binding's own label is tested.
  const unresolvedMention = async (compartments: string[]): Promise<void> => {
    const id = testId("umn");
    await insert("vault.unresolved_mentions", {
      id,
      evidence_id: await parentEvidence(compartments),
      extractor_generation: 1,
      name_fp: sha256Hex(`seed mention ${id}`),
      facts_enc: sealedJson(
        compartments.length === 0 ? own : compartments,
        "vault.unresolved_mentions",
        id,
        "facts_enc",
        { name: "Canary Name", type: "role", field: "subject" },
      ),
      compartments,
    });
  };
  const mentionBinding = async (compartments: string[]): Promise<void> => {
    const id = testId("mbd");
    await insert("knowledge.mention_bindings", {
      id,
      ruling_id: await decision(compartments.length === 0 ? own : compartments),
      evidence_id: sha256Hex(`seed binding evidence ${id}`),
      mention_fp: sha256Hex(`seed binding mention ${id}`),
      address_fp: sha256Hex(`seed binding address ${id}`),
      created_at: SEED_AT,
      compartments,
    });
  };
  // The forgetting tables, as pi_admin: a retention rule, a seal of an address and a signature of
  // a message. Each journal sequence number is random, so two seeders on one database never meet.
  const journalSeq = (): number => 1 + randomBytes(4).readUInt32BE(0);
  const plannerMission = async (compartments: string[]): Promise<void> => {
    await insert("projections.planner_mission", {
      one: true,
      set_at: SEED_AT,
      compartments,
      text_enc: sealRow(
        db.keys,
        compartments[0] ?? "own",
        { table: "projections.planner_mission", id: "mission", column: "text_enc" },
        "a made-up mission",
      ),
    });
  };
  const retentionRule = async (compartments: string[]): Promise<void> => {
    await insert("policy.retention_rules", {
      id: testId("rtr"),
      class: "mail_held",
      days: 7,
      ruling_id: await decision(own),
      journal_seq: journalSeq(),
      created_at: SEED_AT,
      compartments,
    });
  };
  const sealOf = async (compartments: string[]): Promise<void> => {
    serial += 1;
    await insert("knowledge.seals", {
      id: testId("sel"),
      kind: "address",
      value_fp: fingerprint(
        db.keys,
        "address",
        `seed-sealed-${serial}-${randomBytes(4).toString("hex")}@seed-seals.test`,
      ),
      ruling_id: await decision(own),
      journal_seq: journalSeq(),
      sealed_at: SEED_AT,
      compartments,
    });
  };
  const signature = async (compartments: string[]): Promise<void> => {
    await insert("knowledge.signatures", {
      evidence_id: await parentEvidence(compartments),
      sender_fp: null,
      sent_at: SEED_AT,
      found: false,
      compartments,
    });
  };
  // A research request and fetch, as pi_admin: an owner's search, and its search fetch.
  const researchRequest = async (compartments: string[]): Promise<string> => {
    const id = testId("rsq");
    await insert("ledger.research_requests", {
      id,
      request_id: testId("req"),
      author: "owner",
      kind: "search",
      template_id: "person_profile",
      template_version: 1,
      query_fp: sha256Hex(`seed research query ${id}`),
      body_enc: seal(compartments.length === 0 ? own : compartments, "ledger.research_requests", id, "body_enc", "{}"),
      compartments,
    });
    return id;
  };
  const researchFetch = async (compartments: string[]): Promise<void> => {
    await insert("ledger.research_fetches", {
      id: testId("rft"),
      research_request_id: await researchRequest(own),
      kind: "search",
      compartments,
    });
  };
  const veto = async (compartments: string[]): Promise<void> => {
    serial += 1;
    await insert("knowledge.vetoes", {
      ruling_id: await decision(own),
      subject: "person",
      value_fps: [fingerprint(db.keys, "address", `seed-vetoed-${serial}@seed-vetoes.test`)],
      created_at: SEED_AT,
      compartments,
    });
  };
  const card = async (compartments: string[]): Promise<string> => {
    const id = testId("crd");
    await insert("ledger.cards", {
      id,
      request_id: testId("req"),
      created_at: SEED_AT,
      created_by: "system:seed",
      kind: "notice",
      options: ["acknowledge"],
      compartments,
    });
    return id;
  };
  const recordEvent = async (compartments: string[]): Promise<void> => {
    await insert("ledger.record_events", {
      row_kind: "card",
      row_id: await card(own),
      event: "pending",
      at: SEED_AT,
      by: "system:seed",
      compartments,
    });
  };
  const basis = async (compartments: string[]): Promise<void> => {
    await asLedger("ledger.basis", {
      row_kind: "card",
      row_id: await card(own),
      ref_kind: "entity",
      ref_id: testId("ent"),
      source_class: "derived",
      compartments,
    });
  };

  // One agent record, as policy.append_record writes it, under the given label.
  const agentWrite = async (compartments: string[]): Promise<{ id: string; clientId: string }> => {
    const { id: sessionId, clientId } = await ledgerSession(own);
    const id = testId("rec");
    await asLedger("ledger.agent_writes", {
      id,
      client_id: clientId,
      client_name: `seed-writer-${id}`,
      session_id: sessionId,
      request_id: `seed-request-${id.slice(-12)}`,
      tool: "record",
      kind: "note",
      compartments,
      writer_views: ALL_VIEWS,
      content_fp: fingerprint(db.keys, "content_hash", sha256Hex(id)),
      cites_fp: fingerprint(db.keys, "cites", ""),
      cites: [],
      body_enc:
        compartments.length === 0 ? null : seal(compartments, "ledger.agent_writes", id, "body_enc", "seed note"),
    });
    return { id, clientId };
  };

  // The agent records' further two, as pi_owner, the role ledger.check_restatement and
  // policy.import_memory write them as: a `new` mark of one agent record, and one removed memory
  // entry.
  const restatementCheck = async (compartments: string[]): Promise<void> => {
    const { id, clientId } = await agentWrite(own);
    await asLedger("ledger.restatement_checks", {
      client_id: clientId,
      record_id: id,
      claim_key: sha256Hex(`seed claim key ${id}`),
      answer: "new",
      decision_version: 1,
      checked_at: SEED_AT,
      compartments,
    });
  };
  const memoryImport = async (compartments: string[]): Promise<void> => {
    serial += 1;
    await asLedger("ledger.memory_imports", {
      client_id: await client(own),
      request_id: `seed-import-${serial}`,
      locator_fp: sha256Hex(`seed locator ${serial}`),
      change: "removed",
      mark: "new",
      matched_projection_ids: [],
      compartments,
    });
  };

  // One pack served, as policy.log_pack writes it.
  const contextPack = async (compartments: string[]): Promise<void> => {
    const { id: sessionId, clientId } = await ledgerSession(own);
    await asLedger("ledger.context_packs", {
      client_id: clientId,
      session_id: sessionId,
      purpose: "agent_bootstrap",
      template: "agent_bootstrap@1",
      selector: "in_order",
      pack_fp: fingerprint(db.keys, "content_hash", sha256Hex(sessionId)),
      item_ids: [],
      compartments,
    });
  };

  // The erasure's three tables, as an erasure writes them as pi_admin: each erasure at the next
  // journal sequence number.
  const erasure = async (compartments: string[]): Promise<string> => {
    const id = testId("ers");
    const [next] = await query<{ seq: number }>(
      "select coalesce(max(journal_seq), 0)::int + 1 as seq from knowledge.erasures",
    );
    await insert("knowledge.erasures", {
      id,
      ruling_id: await decision(own),
      kind: "item",
      journal_seq: next?.seq ?? 1,
      erased_at: SEED_AT,
      items: 0,
      suppressed: 0,
      tainted_rows: 0,
      compartments,
    });
    return id;
  };
  const removedEvidence = async (compartments: string[]): Promise<void> => {
    serial += 1;
    await insert("knowledge.removed_evidence", {
      id: testId("rme"),
      erasure_id: await erasure(own),
      source_account_id: await sourceAccount(),
      source_item_fp: fingerprint(db.keys, "source_id", `seed-erased-${serial}`),
      evidence_ids: [],
      reason: "owner_erasure",
      removed_at: SEED_AT,
      compartments,
    });
  };
  const suppression = async (compartments: string[]): Promise<void> => {
    serial += 1;
    await insert("knowledge.suppressions", {
      id: testId("sup"),
      erasure_id: await erasure(own),
      kind: "address",
      value_fp: fingerprint(db.keys, "address", `seed-suppressed-${serial}@seed-erasures.test`),
      added_at: SEED_AT,
      compartments,
    });
  };

  // The belief rulings' two tables, as the owner's commands write them as pi_admin: a fact veto, and a
  // declassified fact. The table takes `declassified` alone, so any label but the empty one is given as that;
  // the row is sealed under the `own` key, a stand-in, as these rows are for the rules about the database
  // alone.
  const beliefRuling = async (compartments: string[]): Promise<void> => {
    serial += 1;
    await insert("knowledge.belief_rulings", {
      ruling_id: await decision(own),
      verdict: "veto",
      claim_fp: fingerprint(db.keys, "claim", sha256Hex(`seed ruled claim ${serial}`)),
      fact_key_fp: fingerprint(db.keys, "fact", sha256Hex(`seed ruled fact ${serial}`)),
      created_at: SEED_AT,
      compartments,
    });
  };
  // A join of two fact keys, as `pi facts join` writes it as pi_admin.
  const factRuling = async (compartments: string[]): Promise<void> => {
    serial += 1;
    const [a, b] = [
      fingerprint(db.keys, "fact", sha256Hex(`seed joined a ${serial}`)),
      fingerprint(db.keys, "fact", sha256Hex(`seed joined b ${serial}`)),
    ].sort();
    await insert("knowledge.fact_rulings", {
      ruling_id: await decision(own),
      verdict: "join",
      a_fp: a,
      b_fp: b,
      created_at: SEED_AT,
      compartments,
    });
  };
  // A release, as the owner's confirm writes it as pi_admin: an agent
  // record's evidence row under `agent:` and `own`, its about_you card of system:extract's, and the
  // owner's confirm of it, which the release's insert check reads. The table takes `own` alone, so
  // any label but the empty one is given as that; the evidence's sealed item is under the `own` key,
  // a stand-in, as these rows are for the rules about the database alone.
  const claimRelease = async (compartments: string[]): Promise<void> => {
    serial += 1;
    const label = ["agent:seed", "own"];
    const account = SourceAccountId.parse(testId("acc"));
    // An agent's source account holds its one compartment; its records hold the writer's clearance.
    await insert("vault.source_accounts", {
      id: account,
      label: `seed-agent-${serial}-${account.slice(-8)}`,
      connector: "agent",
      source_kind: "agent_record",
      compartments: ["agent:seed"],
    });
    const sourceItemId = `seed-record-${serial}`;
    const at = { vault: "personal" as const, sourceAccount: account, sourceItemId };
    const evidenceId = evidenceIdFor({ ...at, revision: 0 });
    await insert("vault.evidence_items", {
      id: evidenceId,
      source_account_id: account,
      source_kind: "agent_record",
      source_item_fp: fingerprint(db.keys, "source_id", sourceItemId),
      revision_tag_fp: fingerprint(db.keys, "revision_tag", `h:${sourceItemId}`),
      revision: 0,
      next_revision_id: evidenceIdFor({ ...at, revision: 1 }),
      content_hash: hashFingerprint(db.keys, "content_hash", sha256Hex(`seed record ${serial}`)),
      media_type: "application/json",
      observed_at: SEED_AT,
      change_kind: "live",
      participant_members: ["m-owner"],
      system_originated: false,
      answers_system: false,
      payload_state: "present",
      compartments: label,
      readers: ["m-owner"],
      blob_ref: await blob(),
      item_enc: sealRow(
        db.keys,
        "own",
        { table: "vault.evidence_items", id: evidenceId, column: "item_enc" },
        JSON.stringify({ seed: true }),
      ),
    });
    const card = testId("crd");
    // Its target a claim since removed (a generation raise remade it), which the check allows.
    await insert("ledger.cards", {
      id: card,
      request_id: testId("req"),
      created_at: SEED_AT,
      created_by: "system:extract",
      kind: "about_you",
      target_kind: "claim",
      target_id: sha256Hex(`seed claim ${serial}`),
      options: ["confirm", "reject"],
      compartments: label,
    });
    const ruling = testId("rul");
    await insert("knowledge.owner_decisions", {
      id: ruling,
      request_id: testId("req"),
      kind: "answer",
      answer: "confirm",
      card_id: card,
      queue_depth: 0,
      labels: [],
      details: {},
      decided_at: SEED_AT,
      compartments: label,
    });
    await insert("knowledge.claim_releases", {
      ruling_id: ruling,
      evidence_id: evidenceId,
      via: "card",
      created_at: SEED_AT,
      compartments: compartments.length === 0 ? [] : ["own"],
    });
  };
  // A journalled lift of a release, as `pi correct lift` writes it:
  // a sequence number and the release's ruling id. The table takes `own` alone.
  const releaseLift = async (compartments: string[]): Promise<void> => {
    serial += 1;
    await insert("knowledge.release_lifts", {
      seq: 1_000_000 + serial,
      ruling_id: testId("rul"),
      compartments: compartments.length === 0 ? [] : ["own"],
    });
  };
  // The owner's name for an organization, as `pi org name` writes it
  // as pi_admin, each on a domain of its own, since one name is live for a domain.
  const organizationName = async (compartments: string[]): Promise<void> => {
    serial += 1;
    const id = testId("onm");
    await insert("knowledge.organization_names", {
      id,
      ruling_id: await decision(own),
      domain_fp: fingerprint(db.keys, "domain", `seed-named-${serial}.test`),
      name_enc: seal(compartments, "knowledge.organization_names", id, "name_enc", `Seed Named ${serial}`),
      created_at: SEED_AT,
      compartments,
    });
  };
  const personName = async (compartments: string[]): Promise<void> => {
    serial += 1;
    const id = testId("pnm");
    await insert("knowledge.person_names", {
      id,
      ruling_id: await decision(own),
      entity_ids: [testId("ent")],
      value_fps: [fingerprint(db.keys, "address", `seed-named-${serial}@example.test`)],
      name_enc: seal(compartments, "knowledge.person_names", id, "name_enc", `Seed Person ${serial}`),
      created_at: SEED_AT,
      compartments,
    });
  };
  const declassifiedFact = async (compartments: string[]): Promise<void> => {
    serial += 1;
    const id = testId("dcl");
    await insert("projections.declassified_facts", {
      id,
      ruling_id: await decision(own),
      claim_fp: fingerprint(db.keys, "claim", sha256Hex(`seed declassified claim ${serial}`)),
      evidence_id: sha256Hex(`seed declassified evidence ${serial}`),
      type: "commitment",
      valid_from: SEED_AT,
      created_at: SEED_AT,
      fact_enc: seal(own, "projections.declassified_facts", id, "fact_enc", '{"seed":true}'),
      compartments: compartments.length === 0 ? [] : ["declassified"],
    });
  };

  // The durable-work tables: one row with the pattern columns, and fresh parents under `own`. A
  // ledger row goes in as pi_owner where the functions write it, and as pi_admin where the grants
  // table gives pi_admin the insert and pi_owner none (runs, the kill switch and decisions). The
  // about of every case is a fresh goal id, so no two seeded cases share a key.
  const pattern = (compartments: string[]) => ({ request_id: testId("req"), created_by: "system:seed", compartments });
  const intent = async (clientId?: string): Promise<string> => {
    const id = testId("int");
    await insert("policy.intents", {
      id,
      goal_id: null,
      opportunity_kinds: ["follow_up"],
      recipient_classes: ["none"],
      client_ids: [clientId ?? (await client(own))],
      mode: "owner_decides",
      max_open: 1,
      confirmed_at: SEED_AT,
      revoked_at: null,
    });
    return id;
  };
  const harnessMode = async (clientId?: string): Promise<string> => {
    const id = testId("hrn");
    await insert("policy.harness_modes", {
      id,
      client_id: clientId ?? (await client(own)),
      opportunity_kind: "follow_up",
      stage: "investigate",
      mode: "act",
      granted_at: SEED_AT,
      revoked_at: null,
    });
    return id;
  };
  const goalState = async (compartments: string[]): Promise<string> => {
    const goalId = testId("gol");
    await insert("projections.goal_state", {
      goal_id: goalId,
      status: "active",
      ruling_id: await decision(own),
      stated_at: SEED_AT,
      updated_at: SEED_AT,
      compartments,
      statement_enc: seal(compartments, "projections.goal_state", goalId, "statement_enc", "Seed goal statement"),
    });
    return goalId;
  };
  const killSwitch = (compartments: string[]): Promise<void> =>
    insert("ledger.kill_switch", { ...pattern(compartments), state: "off" });
  const run = async (compartments: string[]): Promise<string> => {
    const id = testId("run");
    await insert("ledger.runs", {
      id,
      ...pattern(compartments),
      wake_source: "daily_sweep",
      wake_key: `seed:${id}`,
      decision_point: "wake_worth_run",
      definition_version: 1,
      prompt_id: "personal_run",
      prompt_version: "1",
    });
    return id;
  };
  const runAttempt = async (
    compartments: string[],
    runId?: string,
  ): Promise<{ runId: string; clientId: string; sessionId: string }> => {
    const id = runId ?? (await run(own));
    const { id: sessionId, clientId } = await ledgerSession(own);
    await asLedger("ledger.run_attempts", {
      run_id: id,
      attempt: 1,
      ...pattern(compartments),
      client_id: clientId,
      taken_at: SEED_AT,
      session_id: sessionId,
      erasure_mark: 0,
    });
    return { runId: id, clientId, sessionId };
  };
  const runStep = async (compartments: string[]): Promise<void> => {
    const { runId, clientId, sessionId } = await runAttempt(own);
    await asLedger("ledger.run_steps", {
      ...pattern(compartments),
      run_id: runId,
      session_id: sessionId,
      attempt: 1,
      ordinal: 1,
      client_id: clientId,
      kind: "tool_call",
      status: "ok",
      tool: "search",
      code: null,
    });
  };
  const silence = async (compartments: string[]): Promise<void> => {
    serial += 1;
    await asLedger("ledger.silences", {
      ...pattern(compartments),
      reason: "budget",
      wake_source: "daily_sweep",
      wake_key: `seed:silence-${serial}`,
      day: SEED_AT.slice(0, 10),
    });
  };
  const workCase = async (
    compartments: string[],
    rowKind: "hypothesis" | "opportunity" | "intention" = "hypothesis",
  ): Promise<{ id: string; aboutId: string }> => {
    const id = testId("cas");
    const aboutId = testId("gol");
    const kind = { hypothesis: "open_loop", opportunity: "follow_up", intention: "remind" }[rowKind];
    await asLedger("ledger.cases", {
      id,
      ...pattern(compartments),
      row_kind: rowKind,
      kind,
      about_kind: "goal",
      about_id: aboutId,
      author: "run",
    });
    return { id, aboutId };
  };
  const hypothesis = async (compartments: string[]): Promise<string> => {
    const { id: caseId, aboutId } = await workCase(own);
    const id = testId("hyp");
    await asLedger("ledger.hypotheses", {
      id,
      ...pattern(compartments),
      case_id: caseId,
      kind: "open_loop",
      about_kind: "goal",
      about_id: aboutId,
      about_owner: false,
      body_enc: seal(compartments, "ledger.hypotheses", id, "body_enc", "Seed hypothesis"),
    });
    return id;
  };
  const hypothesisTest = async (compartments: string[]): Promise<void> => {
    await asLedger("ledger.hypothesis_tests", {
      id: testId("tst"),
      ...pattern(compartments),
      hypothesis_id: await hypothesis(own),
      result: "supports",
      counts: true,
    });
  };
  const opportunity = async (compartments: string[]): Promise<string> => {
    const { id: caseId, aboutId } = await workCase(own, "opportunity");
    const id = testId("opp");
    await asLedger("ledger.opportunities", {
      id,
      ...pattern(compartments),
      case_id: caseId,
      kind: "follow_up",
      hypothesis_id: null,
      about_kind: "goal",
      about_id: aboutId,
      goal_id: null,
      due_at: null,
      proposed_by_class: "run",
      probability: null,
      probability_if_waiting: null,
      body_enc: seal(compartments, "ledger.opportunities", id, "body_enc", "Seed opportunity"),
    });
    return id;
  };
  // As pi_admin, which inserts decisions; their id is the table's identity.
  const opportunityDecision = async (
    compartments: string[],
    opportunityId?: string,
    intentId?: string,
  ): Promise<string> => {
    const [row] = await query<{ id: string }>(
      `insert into ledger.opportunity_decisions (request_id, created_by, compartments, opportunity_id, decision, decided_by, rung, reason, intent_id)
       values ($1, $2, $3, $4, 'go', 'owner', 4, 'owner_answer', $5) returning id::text as id`,
      [testId("req"), "system:seed", compartments, opportunityId ?? (await opportunity(own)), intentId ?? null],
    );
    if (row === undefined) throw new Error("no decision row");
    return row.id;
  };
  const assignment = async (
    compartments: string[],
    opportunityId?: string,
    clientId?: string,
    intentId?: string,
  ): Promise<string> => {
    const id = testId("asg");
    const holder = clientId ?? (await client(own));
    await asLedger("ledger.assignments", {
      id,
      ...pattern(compartments),
      opportunity_id: opportunityId ?? (await opportunity(own)),
      client_id: holder,
      intent_id: intentId ?? (await intent(holder)),
    });
    return id;
  };
  const move = async (compartments: string[]): Promise<void> => {
    const opportunityId = await opportunity(own);
    const holder = await client(own);
    const intentId = await intent(holder);
    await asLedger("ledger.moves", {
      id: testId("mov"),
      ...pattern(compartments),
      opportunity_id: opportunityId,
      assignment_id: await assignment(own, opportunityId, holder, intentId),
      stage: "investigate",
      harness_mode_id: await harnessMode(holder),
      decision_id: await opportunityDecision(own, opportunityId, intentId),
      intent_id: intentId,
      effect_class: "internal_reversible",
    });
  };
  const intention = async (compartments: string[]): Promise<void> => {
    const id = testId("itn");
    await asLedger("ledger.intentions", {
      id,
      ...pattern(compartments),
      opportunity_id: null,
      case_id: null,
      kind: "remind",
      due_at: SEED_AT,
      client_id: null,
      chain_depth: 0,
      body_enc: seal(compartments, "ledger.intentions", id, "body_enc", "Seed reminder"),
    });
  };
  const decisionPointCall = async (compartments: string[]): Promise<void> => {
    serial += 1;
    await insert("ledger.decision_point_calls", {
      id: testId("dpc"),
      ...pattern(compartments),
      point: "wake_worth_run",
      version: 1,
      definition_hash: sha256Hex(`seed definition ${serial}`),
      rung: 0,
      input_hash: sha256Hex(`seed input ${serial}`),
      output: "run",
      effect: "start_run",
      effect_class: "internal_reversible",
      escalated: false,
      card_id: null,
      subject_kind: "run",
      subject_id: testId("run"),
    });
  };

  // The send proxy's four, as pi_owner, the role the send functions write them as. A draft with no
  // session, its account fresh under `own`.
  const draft = async (compartments: string[]): Promise<string> => {
    const id = testId("drf");
    serial += 1;
    const recipient = fingerprint(db.keys, "address", `seed-recipient-${serial}@seed-drafts.test`);
    await asLedger("ledger.drafts", {
      id,
      ...pattern(compartments),
      created_by: `client:${testId("cli")}`,
      source_account_id: await sourceAccount(),
      thread_fp: null,
      recipient_fps: [recipient],
      recipient_domain_fps: [fingerprint(db.keys, "domain", "seed-drafts.test")],
      payload_fp: sha256Hex(`seed payload ${serial}`),
      body_fp: sha256Hex(`seed body ${serial}`),
      case_key: sha256Hex(`seed case ${serial}`),
      body_enc: seal(compartments, "ledger.drafts", id, "body_enc", "Seed draft"),
    });
    return id;
  };
  const draftBelief = async (compartments: string[]): Promise<void> => {
    serial += 1;
    await asLedger("ledger.draft_beliefs", {
      draft_id: await draft(own),
      fact_key_fp: sha256Hex(`seed fact ${serial}`),
      state_fp: sha256Hex(`seed state ${serial}`),
      compartments,
    });
  };
  const gateCheck = async (compartments: string[]): Promise<void> => {
    await asLedger("ledger.gate_checks", {
      created_by: `client:${testId("cli")}`,
      compartments,
      decision_id: testId("gdc"),
      phase: "draft",
      kind: "authority",
      passed: true,
      draft_id: await draft(own),
      payload_fp: sha256Hex(`seed payload ${serial}`),
      facts: null,
    });
  };
  const sentMessage = async (compartments: string[]): Promise<void> => {
    const draftId = await draft(own);
    const [row] = await query<{ account: string; recipients: string[]; payload: string; body: string }>(
      "select source_account_id as account, recipient_fps as recipients, payload_fp as payload, body_fp as body from ledger.drafts where id = $1",
      [draftId],
    );
    await asLedger("ledger.sent_messages", {
      id: testId("snt"),
      request_id: testId("req"),
      created_by: "owner",
      compartments,
      draft_id: draftId,
      ruling_id: await decision(own),
      decision_id: testId("gdc"),
      source_account_id: row?.account,
      recipient_fps: row?.recipients,
      payload_fp: row?.payload,
      body_fp: row?.body,
      begun_at: SEED_AT,
    });
  };

  // The memory adapters' two, as pi_owner, the role policy.serve_memory and ledger.taint_citing
  // write them as.
  const memoryProjection = async (compartments: string[]): Promise<string> => {
    serial += 1;
    const id = `mpr_${sha256Hex(`seed projection ${serial}`).slice(0, 40)}`;
    await asLedger("ledger.memory_projections", {
      id,
      client_id: await client(own),
      audience: own,
      template: "active_memory@1",
      fact_key_fp: sha256Hex(`seed fact ${serial}`),
      state_fp: sha256Hex(`seed state ${serial}`),
      belief_id: `blf_${sha256Hex(`seed belief ${serial}`).slice(0, 40)}`,
      evidence_ids: [],
      compartments,
      first_served_at: SEED_AT,
      last_served_at: SEED_AT,
    });
    return id;
  };
  const memoryExposure = async (compartments: string[]): Promise<void> => {
    const projection = await memoryProjection(own);
    const [row] = await query<{ client_id: string }>("select client_id from ledger.memory_projections where id = $1", [
      projection,
    ]);
    await asLedger("ledger.memory_exposures", {
      client_id: row?.client_id,
      projection_id: projection,
      first_served_at: SEED_AT,
      recorded_at: SEED_AT,
      retention: "none",
      removal: "pending",
      compartments,
    });
  };

  // Contacts and identity's two tables with compartments: a contact of one evidence row, and one
  // of its addresses.
  const contact = async (compartments: string[]): Promise<string> => {
    const id = testId("con");
    serial += 1;
    const accountId = await sourceAccount();
    await insert("knowledge.contacts", {
      id,
      evidence_id: await evidence(own, accountId),
      account_id: accountId,
      source_contact_fp: fingerprint(db.keys, "source_id", `contact:seed-${serial}`),
      updated_at: SEED_AT,
      address_fps: [fingerprint(db.keys, "address", `seed-contact-${serial}@seed-contacts.test`)],
      name_fps: [],
      facts_enc: seal(
        compartments.length === 0 ? own : compartments,
        "knowledge.contacts",
        id,
        "facts_enc",
        JSON.stringify({ names: [], phones: [], organizations: [], birthday: null }),
      ),
      compartments,
    });
    return id;
  };
  const contactAddress = async (compartments: string[]): Promise<void> => {
    serial += 1;
    await insert("knowledge.contact_addresses", {
      contact_id: await contact(own),
      value_fp: fingerprint(db.keys, "address", `seed-contact-address-${serial}@seed-contacts.test`),
      entity_id: await entity("person"),
      compartments,
    });
  };

  // The decision tables' two labelled ones: a saved pair call and a verdict on it, as pi_admin
  // writes them.
  const decisionCall = async (compartments: string[]): Promise<string> => {
    serial += 1;
    const id = testId("dcc");
    const pair = [
      fingerprint(db.keys, "address", `seed-pair-a-${serial}@seed.test`),
      fingerprint(db.keys, "address", `seed-pair-b-${serial}@seed.test`),
    ].sort();
    await insert("vault.decision_calls", {
      id,
      point: "identity_rank",
      version: 1,
      prompt_id: "jev_identity",
      prompt_version: "1",
      subject: `pair:${pair.join(":")}`,
      refs: pair,
      input_fp: fingerprint(db.keys, "model_input", `seed input ${serial}`),
      model_id: "typesafe/jev-1.13",
      output_enc: seal(
        compartments,
        "vault.decision_calls",
        id,
        "output_enc",
        JSON.stringify({ rawOutput: '{"same_person":0.5}', outputHash: "0".repeat(64) }),
      ),
      compartments,
    });
    return id;
  };
  const pointVerdict = async (compartments: string[]): Promise<void> => {
    const id = testId("pvd");
    await insert("ledger.point_verdicts", {
      id,
      request_id: `seed_${id.slice(4)}`,
      created_by: "owner",
      compartments,
      body_enc: seal(compartments, "ledger.point_verdicts", id, "body_enc", JSON.stringify({ verdict: "yes", p: 0.5 })),
      point: "identity_rank",
      version: 1,
      call_id: await decisionCall(own),
      source: "card",
      band: 2,
      weight: 1,
      deliberate: true,
      hurried: false,
    });
  };

  // The learning item's five: a view, a sample and a forecast as pi_admin, which inserts them; a
  // result link and an assessment as pi_owner, as the two outcome functions write them.
  const ownerView = async (compartments: string[]): Promise<void> => {
    await insert("ledger.owner_views", {
      target_kind: "card",
      target_id: testId("crd"),
      surface: "cli",
      shown_at: SEED_AT,
      compartments,
    });
  };
  const silenceSample = async (compartments: string[]): Promise<void> => {
    await silence(own);
    const [row] = await query<{ id: string }>("select max(id)::text as id from ledger.silences");
    await insert("ledger.silence_samples", {
      id: testId("sls"),
      request_id: testId("req"),
      created_by: "owner",
      silence_id: row?.id,
      week: "2026-08-31",
      compartments,
    });
  };
  const moveResultLink = async (compartments: string[]): Promise<void> => {
    await sentMessage(own);
    const [row] = await query<{ id: string }>("select id from ledger.sent_messages order by id desc limit 1");
    await asLedger("ledger.move_result_links", {
      id: testId("mrl"),
      created_by: "system:outcomes",
      send_id: row?.id,
      result_kind: "reply",
      ref_kind: "message",
      ref_id: testId("msg"),
      evidence_id: await parentEvidence(own),
      observed_at: SEED_AT,
      compartments,
    });
  };
  const outcomeAssessment = async (compartments: string[]): Promise<void> => {
    await asLedger("ledger.outcome_assessments", {
      id: testId("oas"),
      created_by: "system:outcomes",
      subject_kind: "send",
      subject_id: testId("snt"),
      '"check"': "answered",
      horizon_days: 14,
      result: "met",
      decided_by: "code",
      compartments,
    });
  };
  // An expectation, a watch and a link of an opportunity of the
  // same label, as pi_owner, the role the definers write them as; a link on evidence of that label.
  const expectedOutcome = async (compartments: string[]): Promise<void> => {
    const label = compartments.length === 0 ? own : compartments;
    await asLedger("ledger.expected_outcomes", {
      opportunity_id: await opportunity(label),
      ordinal: 0,
      created_by: `client:${await client(own)}`,
      origin: "default",
      subject_kind: "counterpart",
      outcome_type: "answered",
      horizon_days: 14,
      compartments,
    });
  };
  const workWatch = async (compartments: string[]): Promise<void> => {
    const label = compartments.length === 0 ? own : compartments;
    await asLedger("ledger.work_watches", {
      opportunity_id: await opportunity(label),
      created_by: "system:work",
      kind: "entity",
      watch_key: testId("ent"),
      compartments,
    });
  };
  const outcomeLink = async (compartments: string[]): Promise<void> => {
    const label = compartments.length === 0 ? own : compartments;
    await asLedger("ledger.outcome_links", {
      opportunity_id: await opportunity(label),
      evidence_id: await parentEvidence(label),
      kind: "met",
      path: "watched",
      judge: "rule",
      attribution: "caused",
      applied: true,
      compartments,
    });
  };
  // A lesson a move's report named, as ledger.report_move writes it, as pi_owner.
  const moveLesson = async (compartments: string[]): Promise<void> => {
    await move(own);
    const [row] = await query<{ id: string }>("select id from ledger.moves order by created_at desc, id desc limit 1");
    const { id: sessionId, clientId } = await ledgerSession(own);
    await asLedger("ledger.move_lessons", {
      created_by: `client:${clientId}`,
      session_id: sessionId,
      move_id: row?.id,
      lesson_id: await hypothesis(own),
      compartments,
    });
  };
  const forecast = async (compartments: string[]): Promise<void> => {
    await insert("ledger.forecasts", {
      id: testId("fct"),
      request_id: testId("req"),
      created_by: "owner",
      source: "owner",
      opportunity_id: await opportunity(own),
      '"check"': "done",
      probability: 0.5,
      compartments,
    });
  };

  // The exposure tables: an exposure as pi_owner, as ledger.note_model_exposure writes it, and an
  // erasure's link to one as pi_admin, as the erasure's hook writes it.
  const exposure = async (compartments: string[]): Promise<string> => {
    serial += 1;
    const ref = sha256Hex(`seed exposure ${serial}`);
    await asLedger("ledger.exposures", {
      recipient_kind: "model",
      recipient: "openai/seed-model",
      route: "personal_correspondence",
      ref_kind: "evidence",
      ref,
      day: SEED_AT.slice(0, 10),
      retention: "unknown",
      compartments,
    });
    const [row] = await query<{ id: string }>("select id::text as id from ledger.exposures where ref = $1", [ref]);
    return row?.id ?? "";
  };
  const erasureExposure = async (compartments: string[]): Promise<void> => {
    await insert("ledger.erasure_exposures", {
      erasure_id: await erasure(own),
      exposure_id: await exposure(own),
      compartments,
    });
  };

  // The restriction tables with compartments, as pi_admin: a request and a screen on an evidence
  // row of the same label (the screen's trigger holds it to its item's), and a lift by source item.
  const restrictionRequest = async (compartments: string[]): Promise<string> => {
    const id = testId("rrq");
    await insert("vault.restriction_requests", {
      id,
      evidence_id: await parentEvidence(compartments),
      kind: "restrict",
      category: "health",
      requested_by: "screen",
      compartments,
    });
    return id;
  };
  const restrictionLift = async (compartments: string[]): Promise<void> => {
    serial += 1;
    await insert("vault.restriction_lifts", {
      account_id: await sourceAccount(),
      source_item_fp: fingerprint(db.keys, "source_id", `seed-lift-${serial}`),
      category: "health",
      ruling_id: await decision(own),
      compartments,
    });
  };
  const restrictScreen = async (compartments: string[]): Promise<void> => {
    await insert("vault.restrict_screens", {
      evidence_id: await parentEvidence(compartments),
      categories: ["health"],
      compartments,
    });
  };

  // Lens: a device as `pi lens add` registers it, by hand as pi_admin: its capture client of kind
  // `device`, its mirror client, the policy.lens_devices row naming both, and its three source
  // accounts, `device:<name>` under `own` with no address.
  const lensDevice = async (options: { name?: string; mirror?: string[] } = {}): Promise<LensDevice> => {
    serial += 1;
    const name = options.name ?? `seed-mac-${serial}-${randomBytes(2).toString("hex")}`;
    const made = { id: testId("cli"), token: `pit_test-capture-${randomBytes(12).toString("hex")}` };
    const mirror = { id: testId("cli"), token: `pit_test-mirror-${randomBytes(12).toString("hex")}` };
    await insert("policy.clients", {
      id: made.id,
      name: `${name}-capture`,
      token_hash: sha256Hex(made.token),
      vendor_retention: "none",
      runtime: "local",
      kind: "device",
      compartments: own,
      views: ["self"],
      tools: ["push_capture"],
      max_items_day: 0,
      max_chars_day: 0,
      max_rows_day: 0,
      max_calls_minute: 120,
    });
    await insert("policy.clients", {
      id: mirror.id,
      name,
      token_hash: sha256Hex(mirror.token),
      vendor_retention: "none",
      runtime: "local",
      kind: "agent",
      compartments: options.mirror ?? own,
      views: ALL_VIEWS,
      tools: ["sync_mirror"],
      id_mode: "stable",
    });
    await insert("policy.lens_devices", { name, capture_client_id: made.id, mirror_client_id: mirror.id });
    const accounts = { meeting: "", moment: "", block: "" };
    for (const [kind, connector, sourceKind] of [
      ["meeting", "lens_meetings", "transcript"],
      ["moment", "lens_activity", "screen_activity"],
      ["block", "lens_blocks", "time_block"],
    ] as const) {
      accounts[kind] = testId("acc");
      await insert("vault.source_accounts", {
        id: accounts[kind],
        label: `device:${name}`,
        connector,
        source_kind: sourceKind,
        compartments: own,
      });
    }
    return { name, capture: made, mirror, accounts };
  };
  let lensSeed: Promise<LensDevice> | undefined;
  const seedDevice = (): Promise<LensDevice> => (lensSeed ??= lensDevice());
  // A stored moment of a device, as the drain writes it: its evidence row of kind screen_activity
  // under the item's label, and its knowledge.captures row citing it.
  const capture = async (
    compartments: string[],
    device?: LensDevice,
  ): Promise<{ id: string; evidenceId: string; key: string }> => {
    const { accounts } = device ?? (await seedDevice());
    const label = compartments.length === 0 ? own : compartments;
    const blobRef = await blob(label);
    serial += 1;
    const key = `moment:${testId("k").slice(2)}`;
    const at = { vault: "personal" as const, sourceAccount: SourceAccountId.parse(accounts.moment), sourceItemId: key };
    const evidenceId = evidenceIdFor({ ...at, revision: 0 });
    await insert("vault.evidence_items", {
      id: evidenceId,
      source_account_id: accounts.moment,
      source_kind: "screen_activity",
      source_item_fp: fingerprint(db.keys, "source_id", key),
      revision_tag_fp: fingerprint(db.keys, "revision_tag", `h:${key}`),
      revision: 0,
      next_revision_id: evidenceIdFor({ ...at, revision: 1 }),
      content_hash: hashFingerprint(db.keys, "content_hash", sha256Hex(`seed capture ${serial}`)),
      media_type: "application/json",
      observed_at: SEED_AT,
      change_kind: "live",
      participant_members: ["m-owner"],
      system_originated: false,
      answers_system: false,
      payload_state: "present",
      compartments: label,
      readers: ["m-owner"],
      blob_ref: blobRef,
      item_enc: seal(
        label,
        "vault.evidence_items",
        evidenceId,
        "item_enc",
        JSON.stringify({ sourceItemId: key, markers: [] }),
      ),
    });
    const id = testId("cap");
    await insert("knowledge.captures", {
      id,
      evidence_id: evidenceId,
      source_account_id: accounts.moment,
      capture_key: key,
      compartments,
      kind: "moment",
      revision: 0,
      started_at: SEED_AT,
      ended_at: SEED_AT,
      first_pushed_at: SEED_AT,
      local_day: SEED_AT.slice(0, 10),
      facts_enc: sealedJson(label, "knowledge.captures", id, "facts_enc", {
        app: { bundle: "test.seed.notes", name: "Seed Notes" },
        counts: { chars: 1 },
      }),
    });
    return { id, evidenceId, key };
  };
  // A pushed moment in the inbox, as policy.push_capture writes it as pi_owner, in a session of
  // the device's capture client.
  const captureInbox = async (compartments: string[]): Promise<void> => {
    const { capture: made } = await seedDevice();
    const sessionId = testId("ses");
    await asLedger("ledger.sessions", { id: sessionId, client_id: made.id, compartments: own });
    const id = testId("cin");
    await asLedger("ledger.capture_inbox", {
      id,
      client_id: made.id,
      session_id: sessionId,
      batch: `seed-batch-${serial}`,
      source_key_fp: fingerprint(db.keys, "source_id", `moment:${testId("k").slice(2)}`),
      revision: 0,
      kind: "moment",
      scope_fps: [sha256Hex(`seed scope ${id}`)],
      content_fp: hashFingerprint(db.keys, "content_hash", sha256Hex(`seed inbox ${id}`)),
      body_bytes: 100,
      received_at: SEED_AT,
      compartments,
      body_enc: seal(own, "ledger.capture_inbox", id, "body_enc", "{}"),
    });
  };
  // An erased key served back to the device's mirror client, as ledger.capture_erased writes it.
  const captureErasure = async (compartments: string[]): Promise<void> => {
    const { mirror } = await seedDevice();
    await asLedger("ledger.capture_erasures", {
      client_id: mirror.id,
      capture_key: `moment:${testId("k").slice(2)}`,
      erased_at: SEED_AT,
      compartments,
    });
  };
  // Lens's mirror: a live belief entry of the device's mirror client, as
  // policy.serve_mirror writes it as pi_owner. Its ids are made up: no row is checked here.
  const mirrorEntry = async (compartments: string[]): Promise<string> => {
    const { mirror } = await seedDevice();
    serial += 1;
    const id = `mir_${sha256Hex(`seed mirror entry ${serial} ${mirror.id}`).slice(0, 40)}`;
    await asLedger("ledger.mirror_entries", {
      id,
      client_id: mirror.id,
      audience: own,
      template: "lens_mirror@1",
      section: "beliefs",
      entry_key: `blf_${sha256Hex(`seed mirror belief ${serial} ${mirror.id}`).slice(0, 40)}`,
      fact_key_fp: sha256Hex(`seed mirror fact ${serial} ${mirror.id}`),
      sent_state: sha256Hex(`seed mirror state ${serial} ${mirror.id}`),
      evidence_ids: [],
      entity_ids: [],
      compartments,
      first_served_at: SEED_AT,
      last_sent_at: SEED_AT,
    });
    return id;
  };

  // The coverage migration's one labelled table: one sync's outcome of a seeded account, as the
  // writer's recordOutcome writes it, as pi_writer (pi_admin inserts none). Ids and counts only.
  const syncOutcome = async (compartments: string[]): Promise<void> => {
    const account = await sourceAccount(compartments.length === 0 ? own : compartments);
    await session(db.urls.writer, (writer) =>
      writer(
        "insert into vault.sync_outcomes (account_id, sync_kind, started_at, code, added, stored, held, junk, decided, removed, compartments) values ($1, 'full', $2, 'ok', 0, 0, 0, 0, 0, 0, $3)",
        [account, SEED_AT, compartments],
      ),
    );
  };

  // One settlement, as decide writes a withdrawn duplicate's.
  const factSettlement = async (compartments: string[]): Promise<void> => {
    const settling = await card(own);
    await insert("ledger.fact_settlements", {
      id: `fst_${testId("rul").slice(4)}`,
      claim_key: sha256Hex(`seed claim key ${settling}`),
      card_id: settling,
      answer: "confirmed",
      kind: "about_you",
      match_fp: sha256Hex(`seed match ${settling}`),
      withdrawn_card_id: await card(own),
      written_by: "decide",
      created_at: SEED_AT,
      compartments,
    });
  };

  // The owner's reopen of a commitment, their binding row, as pi_admin writes it.
  const commitmentReopen = async (compartments: string[]): Promise<void> => {
    await insert("ledger.commitment_reopens", {
      id: `rop_${testId("rul").slice(4)}`,
      close_id: null,
      fact_fp: sha256Hex(`seed reopen ${compartments.join(",")}`),
      by: "owner",
      decision_id: await decision(compartments),
      at: SEED_AT,
      compartments,
    });
  };

  // An agent's proposed goal, as ledger.propose_goal writes one (no card here), as
  // pi_owner, the only role that writes the table.
  const goalProposal = async (compartments: string[]): Promise<void> => {
    await asLedger("ledger.goal_proposals", {
      id: `gpr_${testId("rul").slice(4)}`,
      request_id: `seed-goal-${testId("req").slice(4, 20)}`,
      created_by: `client:cli_${testId("rul").slice(4)}`,
      change: "add",
      statement_fp: sha256Hex(`seed goal ${compartments.join(",")}`),
      compartments,
    });
  };

  // An agent's message to every agent, an improvement and one status event of it, as
  // the definer functions write them, as pi_owner.
  const agentMessage = async (compartments: string[]): Promise<string> => {
    const { id: sessionId, clientId } = await ledgerSession(own);
    const id = testId("amg");
    await asLedger("ledger.agent_messages", {
      id,
      request_id: `seed-amg-${testId("req").slice(4, 20)}`,
      created_by: `client:${clientId}`,
      client_id: clientId,
      session_id: sessionId,
      compartments,
      thread_id: id,
      to_kind: "all",
      kind: "note",
    });
    return id;
  };
  // What an agent wrote back and what a client was told, as the definer functions write them, as pi_owner.
  const signalMark = async (compartments: string[]): Promise<void> => {
    const { id: sessionId, clientId } = await ledgerSession(own);
    await asLedger("ledger.signal_marks", {
      id: testId("smk"),
      request_id: `seed-smk-${testId("req").slice(4, 20)}`,
      created_by: `client:${clientId}`,
      client_id: clientId,
      client_name: "seed-client",
      session_id: sessionId,
      compartments,
      ref_kind: "opportunity",
      ref_id: testId("opp"),
      state: "handled",
    });
  };
  const changeLog = async (compartments: string[]): Promise<void> => {
    const { clientId } = await ledgerSession(own);
    const at = new Date().toISOString();
    await asLedger("ledger.change_log", {
      client_id: clientId,
      signal_key: `sig_${"0".repeat(20)}${String((serial += 1)).padStart(12, "0")}`,
      kind: "gap",
      print: "0".repeat(32),
      signal_at: at,
      first_at: at,
      logged_at: at,
      compartments,
    });
  };
  // The owner's tier ruling of one person, as pi_admin writes it.
  const tierRuling = async (compartments: string[]): Promise<void> => {
    serial += 1;
    await insert("knowledge.tier_rulings", {
      // The decision under `own` when the row's label is empty, so an empty label is refused by
      // this table's own check.
      ruling_id: await decision(compartments.length === 0 ? ["own"] : compartments),
      tier: "close",
      value_fps: [fingerprint(db.keys, "address", `seed-tier-${serial}@example.test`)],
      created_at: SEED_AT,
      compartments,
    });
  };

  // One chat line of a source moment, as the writer's participant step
  // writes it (pi_admin inserts none). Ids, a direction, a time, a count and a fingerprint.
  const chatLine = async (compartments: string[]): Promise<void> => {
    serial += 1;
    const evidenceRef = await evidence(compartments.length === 0 ? own : compartments);
    const entityRef = await entity("person");
    await session(db.urls.writer, (writer) =>
      writer(
        "insert into knowledge.chat_lines (id, evidence_id, line, entity_id, direction, occurred_at, others, thread_fp, compartments) values ($1, $2, 0, $3, 'inbound', $4, 1, $5, $6)",
        [
          `chl_${testId("cli").slice(4)}`,
          evidenceRef,
          entityRef,
          SEED_AT,
          sha256Hex(`seed chat thread ${serial}`),
          compartments,
        ],
      ),
    );
  };

  // One of the owner's lists, its name sealed under its label, and one
  // member of a list labelled `own`, as pi_admin writes them.
  const ownerList = async (compartments: string[]): Promise<string> => {
    const id = testId("lst");
    const ruling = await decision(compartments.length === 0 ? ["own"] : compartments);
    await insert("knowledge.owner_lists", {
      id,
      ruling_id: ruling,
      name_enc: sealUnder(
        db.keys,
        compartments.length === 0 ? ["own"] : compartments,
        { table: "knowledge.owner_lists", id, column: "name_enc" },
        "seed list",
      ),
      named_by: ruling,
      created_at: SEED_AT,
      compartments,
    });
    return id;
  };
  const ownerListMember = async (compartments: string[]): Promise<void> => {
    serial += 1;
    await insert("knowledge.owner_list_members", {
      ruling_id: await decision(compartments.length === 0 ? ["own"] : compartments),
      list_id: await ownerList(["own"]),
      value_fps: [fingerprint(db.keys, "address", `seed-list-${serial}@example.test`)],
      created_at: SEED_AT,
      compartments,
    });
  };
  // One of the owner's areas, its name sealed under `own`, the only label an area takes.
  const area = async (compartments: string[]): Promise<string> => {
    serial += 1;
    const id = testId("are");
    await insert("knowledge.areas", {
      id,
      key: `seed-area-${serial}`,
      name_enc: sealUnder(db.keys, ["own"], { table: "knowledge.areas", id, column: "name_enc" }, "Seed area"),
      position: serial,
      compartments,
    });
    return id;
  };
  const byTable: Record<string, (compartments: string[]) => Promise<unknown>> = {
    "knowledge.areas": area,
    ...timeSeeds(insert, decision, project, client),
    "knowledge.owner_lists": ownerList,
    "knowledge.owner_list_members": ownerListMember,
    "knowledge.chat_lines": chatLine,
    "knowledge.tier_rulings": tierRuling,
    ...warmthSeeds(db, SEED_AT),
    "ledger.fact_settlements": factSettlement,
    "ledger.commitment_reopens": commitmentReopen,
    "ledger.goal_proposals": goalProposal,
    "ledger.agent_messages": agentMessage,
    "ledger.signal_marks": signalMark,
    "ledger.change_log": changeLog,
    ...measureSeeds(asLedger, () => ledgerSession(own), {
      card: () => card(own),
      person: () => entity("person"),
      opportunity: (label) => opportunity(label.length === 0 ? own : label),
      seal,
    }),
    "vault.sync_outcomes": syncOutcome,
    "ledger.capture_inbox": captureInbox,
    "ledger.capture_erasures": captureErasure,
    "ledger.mirror_entries": mirrorEntry,
    "knowledge.captures": (compartments) => capture(compartments),
    "vault.decision_calls": decisionCall,
    "ledger.point_verdicts": pointVerdict,
    "ledger.owner_views": ownerView,
    "ledger.silence_samples": silenceSample,
    "ledger.move_result_links": moveResultLink,
    "ledger.outcome_assessments": outcomeAssessment,
    "ledger.forecasts": forecast,
    "ledger.move_lessons": moveLesson,
    "ledger.expected_outcomes": expectedOutcome,
    "ledger.work_watches": workWatch,
    "ledger.outcome_links": outcomeLink,
    "ledger.outcome_checks": outcomeCheck,
    "ledger.source_checks": sourceCheck,
    "ledger.recall_checks": recallCheck,
    "ledger.surfaced_items": surfacedItem,
    "vault.restriction_requests": restrictionRequest,
    "vault.restriction_lifts": restrictionLift,
    "vault.restrict_screens": restrictScreen,
    "knowledge.contacts": contact,
    "knowledge.contact_addresses": contactAddress,
    "knowledge.belief_rulings": beliefRuling,
    "knowledge.fact_rulings": factRuling,
    "knowledge.claim_releases": claimRelease,
    "knowledge.release_lifts": releaseLift,
    "knowledge.organization_names": organizationName,
    "knowledge.person_names": personName,
    "vault.unresolved_mentions": unresolvedMention,
    "knowledge.mention_bindings": mentionBinding,
    "policy.retention_rules": retentionRule,
    "projections.planner_mission": plannerMission,
    "knowledge.seals": sealOf,
    "knowledge.signatures": signature,
    "ledger.research_requests": researchRequest,
    "ledger.research_fetches": researchFetch,
    "projections.declassified_facts": declassifiedFact,
    "ledger.exposures": exposure,
    "ledger.erasure_exposures": erasureExposure,
    "ledger.memory_projections": memoryProjection,
    "ledger.memory_exposures": memoryExposure,
    "ledger.restatement_checks": restatementCheck,
    "ledger.memory_imports": memoryImport,
    "ledger.drafts": draft,
    "ledger.draft_beliefs": draftBelief,
    "ledger.gate_checks": gateCheck,
    "ledger.sent_messages": sentMessage,
    "projections.goal_state": goalState,
    "ledger.kill_switch": killSwitch,
    "ledger.runs": run,
    "ledger.run_attempts": (compartments) => runAttempt(compartments),
    "ledger.run_steps": runStep,
    "ledger.silences": silence,
    "ledger.cases": (compartments) => workCase(compartments),
    "ledger.hypotheses": hypothesis,
    "ledger.hypothesis_tests": hypothesisTest,
    "ledger.opportunities": opportunity,
    "ledger.opportunity_decisions": (compartments) => opportunityDecision(compartments),
    "ledger.assignments": (compartments) => assignment(compartments),
    "ledger.moves": move,
    "ledger.intentions": intention,
    "ledger.decision_point_calls": decisionPointCall,
    "knowledge.erasures": erasure,
    "knowledge.removed_evidence": removedEvidence,
    "knowledge.suppressions": suppression,
    "knowledge.owner_decisions": decision,
    "knowledge.vetoes": veto,
    "ledger.cards": card,
    "ledger.record_events": recordEvent,
    "ledger.basis": basis,
    "ledger.agent_writes": (compartments) => agentWrite(compartments),
    "ledger.context_packs": (compartments) => contextPack(compartments),
    "ledger.sessions": (compartments) => ledgerSession(compartments),
    "ledger.read_log": (compartments) => readLog(compartments),
    "policy.clients": client,
    "vault.source_accounts": sourceAccount,
    "vault.evidence_items": (compartments) => evidence(compartments),
    "vault.evidence_blobs": blob,
    "vault.listed_items": (compartments) => listedItem(compartments),
    "vault.sent_recipients": (compartments) => sentRecipient(compartments),
    "knowledge.accounts": (compartments) => account(compartments),
    "knowledge.domains": (compartments) => domain(compartments),
    "knowledge.aliases": (compartments) => alias(compartments),
    "knowledge.messages": (compartments) => message(compartments),
    "knowledge.interaction_log": (compartments) => interaction(compartments),
    "knowledge.events": (compartments) => event(compartments),
    "knowledge.event_details": (compartments) => eventDetails(compartments),
    "knowledge.event_participants": (compartments) => eventParticipant(compartments),
    "vault.pipeline_items": (compartments) => pipelineItem(compartments),
    "vault.model_calls": (compartments) => modelCall(compartments),
    "vault.model_call_members": modelCallMember,
    "vault.model_usage": modelUsage,
    "vault.extraction_runs": extractionRun,
    "vault.unmapped_claims": (compartments) => unmappedClaim(compartments),
    "vault.extraction_reviews": (compartments) => review(compartments),
    "knowledge.claims": (compartments) => claim(compartments),
    "knowledge.claim_entities": (compartments) => claimEntity(compartments),
    "knowledge.claim_values": (compartments) => claimValue(compartments),
    "knowledge.claim_org_names": (compartments) => claimOrgName(compartments),
    "knowledge.org_names": (compartments) => orgName(compartments),
    "knowledge.claim_relations": claimRelation,
    "knowledge.same_fact_judgments": sameFactJudgment,
    // A relation check's mark.
    "ledger.relation_checks": relationCheck,
    // A goal id row, on a claim of its label and a goal_set decision.
    "knowledge.goal_ids": goalIdRow,
    "knowledge.goal_key_rulings": goalKeyRuling,
    "projections.goal_key_ranks": goalKeyRank,
    // A clock recheck as the tick writes one, and a trigger row as the
    // Pipeline writes one.
    "ledger.trigger_rechecks": (compartments) =>
      queryAs(
        db.urls.work,
        "insert into ledger.trigger_rechecks (fact_key_fp, clearance_key, cause, exact, window_from, window_to, compartments) values ($1, $2, 'due', false, now(), now() + interval '1 day', $3)",
        [testId("fp"), compartments.join("|"), compartments],
      ),
    "ledger.trigger_log": (compartments) =>
      queryAs(
        db.urls.pipeline,
        "insert into ledger.trigger_log (fact_key_fp, clearance_key, state_fp, raise, cause, compartments) values ($1, $2, repeat('a', 64), 'changed', 'claim', $3)",
        [testId("fp"), compartments.join("|"), compartments],
      ),
    "knowledge.documents": (compartments) => document(compartments),
    "knowledge.projects": (compartments) => project(compartments),
    "knowledge.project_anchors": (compartments) => projectAnchor(compartments),
    "knowledge.project_bindings": (compartments) => projectBinding(compartments),
    ...promotionSeeds(insert, seal),
  };

  // The insert of one new row into a table that has `compartments`.
  const into = (table: string): ((compartments: string[]) => Promise<unknown>) => {
    const row = byTable[table];
    if (row === undefined) throw new Error(`the fixtures know no table ${table}`);
    return row;
  };

  return {
    lensDevice,
    capture,
    mirrorEntry,
    sourceAccount,
    blob,
    evidence,
    entity,
    interaction,
    account,
    domain,
    alias,
    message,
    event,
    eventDetails,
    sentRecipient,
    world,
    into,
    pipelineItem,
    modelCall,
    modelUsage,
    extractionRun,
    unmappedClaim,
    review,
    claim,
    claimEntity,
    claimValue,
    claimRelation,
    project,
    projectAnchor,
    projectBinding,
    intent,
    harnessMode,
    goalState,
    run,
    hypothesis,
    opportunity,
    draft,
    driveRoot,
    documentAccount,
    document,
  };
}

// One row of every knowledge table under `own` and one under `employer:example`, written in
// SQL: for the rules about what the reader sees, which need no writer.
export const seedBothCompartments = (db: TestDatabase) =>
  session(db.urls.admin, async (query) => {
    const seed = seeder(db, query);
    return { own: await seed.world(["own"]), employer: await seed.world(["employer:example"]) };
  });
