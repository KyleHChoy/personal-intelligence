import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorCursor } from "@intelligence/contracts";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import { type EntityId, SourceAccountId } from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { contactItem, deriveItem, whitelistedContact } from "@intelligence/personal-core/items";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { CANARIES, connect, OWNER, QUENTIN, SOLO } from "../test-support/cast.ts";
import { TABLES } from "../test-support/catalogue.ts";
import { RUNTIME_ROLES, SCHEMAS, tablesIn } from "../test-support/catalogue-grants.ts";
import { hashFingerprint, insertClient, insertSecret, sha256Hex, testId } from "../test-support/clients.ts";
import { asTablesOwner, one, readAs, session, sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs, scanForPlaintext } from "../test-support/database.ts";
import { ingestEvent, ingestMail, type MailFixture, mailSourceId, NOW } from "../test-support/items.ts";
import { EVENTS, MAIL } from "../test-support/items-named.ts";
import { seedExtraction } from "../test-support/pipeline-fixtures.ts";
import { readerReadProbes, readerWriteProbes, writerPolicyProbes } from "../test-support/probes.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { seedBothCompartments, seeder } from "../test-support/seeder.ts";
import { opened, rowCounts } from "../test-support/snapshot.ts";
import { withDatabase, withStore } from "../test-support/store.ts";
import { evidenceIdOf } from "../test-support/values.ts";
import { sealRow, sealUnder } from "./seal.ts";

// The core gate tests at the level of the store: no canary is in plaintext in any column, and
// each role's rights. The tests of tokens and clearance run through the Reader, and the canary
// test runs again through `runSync`.

const TIMEOUT = 180_000;

// Where a scan found something, by table and column, whether or not the scan names the schema.
const places = (hits: { table: string; column: string }[]): string[] =>
  hits.map((hit) => `${hit.table.split(".").pop() ?? ""}.${hit.column}`).sort();

// A bulk message under the employer's compartment that carries both content canaries: a receipt,
// which derives no person and keeps its text and its attachment list.
const BULK_CANARY: MailFixture = {
  id: "gm-gate-receipt-0001",
  threadId: "thread-gate-receipt-0001",
  messageId: "gate-receipt-0001@receipts-example.test",
  at: "2026-09-08T12:00:00Z",
  from: { address: "billing@receipts-example.test", name: "Receipts Example" },
  to: [{ address: "odalys.owner@employer-example.test" }],
  subject: "Your receipt",
  labels: ["INBOX", "CATEGORY_UPDATES"],
  reads: "bulk",
  text: `Thank you for your order.\n${CANARIES.bodyText}`,
  attachments: [{ name: CANARIES.attachmentName, type: "application/pdf", size: 9_120 }],
};

describe("the core gate, at the store", { timeout: TIMEOUT }, () => {
  describe("no canary is in any column", () => {
    it("a canary is found in no column", () =>
      withStore(async ({ db, writer }) => {
        const accounts = await connect(writer);
        // Each canary through the writer: the address, the name and the subject on a received
        // message, the title on an event, the owner's address and display name on all of them,
        // and the same person and subject again under the employer's compartment.
        expect(await ingestMail(writer, accounts.personalMail, MAIL.canary)).toBe("stored");
        expect(await ingestMail(writer, accounts.personalMail, MAIL.reply)).toBe("stored");
        expect(await ingestEvent(writer, accounts.personalCalendar, EVENTS.canary)).toBe("stored");
        expect(await ingestMail(writer, accounts.workMail, MAIL.workCanary)).toBe("stored");
        // A listing left open, so `vault.listed_items` holds the canary item's row too.
        await writer.finishPage(accounts.personalMail, {
          listing: { first: true },
          listedIds: [mailSourceId(MAIL.canary)],
          skippedIds: [],
          next: ConnectorCursor.parse(CANARIES.cursor),
        });
        // The canary account's sync outcome, through the writer's own
        // recordOutcome, so `vault.sync_outcomes` holds a row the scan reads. Ids and counts only.
        await writer.recordOutcome(accounts.personalMail, "ok", NOW, 0, {
          kind: "full",
          added: 2,
          stored: 2,
          held: 0,
          junk: 0,
          decided: 2,
          removed: 0,
        });
        await insertSecret(db, "google/personal/refresh_token", CANARIES.secret);
        // The owner's two decision tables, as pi_admin writes them: the release of the canary
        // message (a decision row), and a veto on the canary person by the fingerprint of the
        // address.
        const released = one(
          await queryAs<{ id: string; compartments: string[] }>(
            db.urls.admin,
            "select id, compartments from knowledge.messages order by id limit 1",
          ),
        );
        const ruling = testId("rul");
        await queryAs(
          db.urls.admin,
          `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, queue_depth, labels, details, decided_at, compartments)
           values ($1, $2, 'release', 'message', $3, 0, '{}', '{}', now(), $4)`,
          [ruling, testId("req"), released.id, released.compartments],
        );
        const vetoRuling = testId("rul");
        await queryAs(
          db.urls.admin,
          `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'veto', 0, '{}', '{}', now(), '{own}')`,
          [vetoRuling, testId("req")],
        );
        await queryAs(
          db.urls.admin,
          "insert into knowledge.vetoes (ruling_id, subject, value_fps, created_at, compartments) values ($1, 'person', $2, now(), '{own}')",
          [vetoRuling, [fingerprint(db.keys, "address", CANARIES.address)]],
        );
        // The erasure's three tables, as an erasure writes them: Solo's one message, and Solo,
        // erased by the owner (a person, so a suppression too), through the Admin with a journal of
        // its own.
        expect(await ingestMail(writer, accounts.personalMail, MAIL.solo)).toBe("stored");
        const solo = one(
          await queryAs<{ entity_id: string }>(
            db.urls.admin,
            "select entity_id from knowledge.accounts where value_fp = $1",
            [fingerprint(db.keys, "address", SOLO.address)],
          ),
        ).entity_id;
        const folder = await mkdtemp(join(tmpdir(), "pi-gate-"));
        const admin = createAdmin({
          url: db.urls.admin,
          keys: db.keys,
          log: recordingLogger().log,
          journal: join(folder, "keys.json.erasures"),
        });
        try {
          expect((await admin.erasure.erasePerson(solo as EntityId, { requestId: testId("req") })).items).toBe(1);
        } finally {
          await admin.close();
          await rm(folder, { recursive: true, force: true });
        }

        // Contacts and identity's three tables: a contact naming the canary person, through the
        // writer, with the canary name, and a same ruling on its two addresses as pi_admin.
        const contacts = await writer.ensureSourceAccount("personal", "google_contacts", "own", OWNER.personal);
        const saved = whitelistedContact({
          resourceName: "people/gate-canary",
          metadata: { sources: [{ type: "CONTACT", id: "gate", updateTime: "2026-09-01T09:00:00Z" }] },
          names: [{ metadata: { source: { type: "CONTACT" } }, displayName: CANARIES.name }],
          emailAddresses: [CANARIES.address, QUENTIN.address].map((value) => ({
            metadata: { source: { type: "CONTACT" } },
            value,
          })),
        });
        if (saved === null) throw new Error("the gate's contact does not read");
        const contactRaw = contactItem(saved, { sourceAccount: contacts.id, changeKind: "backfill", now: NOW });
        expect(
          await writer.ingestItem(contacts, contactRaw, (ctx) => deriveItem(contactRaw, ctx, PERSONAL_LIMITS)),
        ).toBe("stored");
        const identityRuling = testId("rul");
        await queryAs(
          db.urls.admin,
          `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'identity', 0, '{}', '{}', now(), '{own}')`,
          [identityRuling, testId("req")],
        );
        const [low, high] = [CANARIES.address, QUENTIN.address]
          .map((address) => fingerprint(db.keys, "address", address))
          .sort();
        await queryAs(
          db.urls.admin,
          "insert into knowledge.identity_rulings (ruling_id, verdict, a_fp, b_fp, created_at) values ($1, 'same', $2, $3, now())",
          [identityRuling, low, high],
        );

        // A row of each extraction table, through the Pipeline, with the canary text in a claim.
        await seedExtraction(db, evidenceIdOf(accounts.personalMail, mailSourceId(MAIL.canary)), {
          address: CANARIES.address,
          text: CANARIES.bodyText,
          subject: CANARIES.subject,
        });
        // The owner's binding of the filed mention to the canary person, as pi_admin
        // writes it: ids and fingerprints, with nothing sealed.
        const bindRuling = testId("rul");
        await queryAs(
          db.urls.admin,
          `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'mention_bind', 0, '{}', '{}', now(), '{own}')`,
          [bindRuling, testId("req")],
        );
        await queryAs(
          db.urls.admin,
          "insert into knowledge.mention_bindings (id, ruling_id, evidence_id, mention_fp, address_fp, created_at, compartments) values ($1, $2, $3, $4, $5, now(), '{own}')",
          [
            testId("mbd"),
            bindRuling,
            evidenceIdOf(accounts.personalMail, mailSourceId(MAIL.canary)),
            fingerprint(db.keys, "name", CANARIES.subject),
            fingerprint(db.keys, "address", CANARIES.address),
          ],
        );
        // A root and a document, not held, in SQL as pi_admin, with canaries sealed in them.
        await session(db.urls.admin, (query) =>
          seeder(db, query).document(["own"], {
            title: CANARIES.subject,
            text: CANARIES.bodyText,
            fileId: CANARIES.gmailId,
            folderId: CANARIES.threadId,
            owner: { address: CANARIES.address, name: CANARIES.name },
          }),
        );

        // The owner's rulings' two tables, as pi_admin writes them: a veto of the canary claim's
        // fact key, and the claim declassified, its copy holding the canary text. The copy is
        // sealed under the `own` key here, a stand-in: this key file has no `declassified` key.
        const claim = one(
          await queryAs<{ id: string; evidence_id: string; fact_key_fp: string; valid_from: Date }>(
            db.urls.admin,
            "select id, evidence_id, fact_key_fp, valid_from from knowledge.claims order by id limit 1",
          ),
        );
        const ruled = async (kind: string): Promise<string> => {
          const id = testId("rul");
          await queryAs(
            db.urls.admin,
            `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, $3, 0, '{}', '{}', now(), '{own}')`,
            [id, testId("req"), kind],
          );
          return id;
        };
        await queryAs(
          db.urls.admin,
          "insert into knowledge.belief_rulings (ruling_id, verdict, claim_fp, fact_key_fp, created_at, compartments) values ($1, 'veto', $2, $3, now(), '{own}')",
          [await ruled("fact_veto"), claim.id, claim.fact_key_fp],
        );
        const copy = testId("dcl");
        await queryAs(
          db.urls.admin,
          `insert into projections.declassified_facts (id, ruling_id, claim_fp, evidence_id, type, valid_from, created_at, fact_enc, compartments)
           values ($1, $2, $3, $4, 'commitment', $5, now(), $6, '{declassified}')`,
          [
            copy,
            await ruled("declassify"),
            claim.id,
            claim.evidence_id,
            claim.valid_from,
            sealRow(
              db.keys,
              "own",
              { table: "projections.declassified_facts", id: copy, column: "fact_enc" },
              JSON.stringify({ what: CANARIES.bodyText }),
            ),
          ],
        );
        // The owner's name for an organization, as `pi org name` writes it as pi_admin, the canary
        // name sealed in it. And an ignore ruling, which holds keyed fingerprints and no value.
        // Each on a domain of no other row, so neither withholds anything the later checks read.
        const named = testId("onm");
        await queryAs(
          db.urls.admin,
          "insert into knowledge.organization_names (id, ruling_id, domain_fp, name_enc, created_at, compartments) values ($1, $2, $3, $4, now(), '{own}')",
          [
            named,
            await ruled("organization_name"),
            fingerprint(db.keys, "domain", "gate-named.test"),
            sealRow(
              db.keys,
              "own",
              { table: "knowledge.organization_names", id: named, column: "name_enc" },
              CANARIES.name,
            ),
          ],
        );
        await queryAs(
          db.urls.admin,
          "insert into knowledge.ignore_rulings (ruling_id, target, subject, value_fps, created_at) values ($1, 'domain', 'domain', $2, now())",
          [await ruled("ignore"), [fingerprint(db.keys, "domain", "gate-ignored.test")]],
        );
        // The owner's name for a person, as `pia person name` writes it as pi_admin, the canary
        // name sealed in it, for a person of no other row.
        const personName = `pnm_${testId("ent").slice(4)}`;
        await queryAs(
          db.urls.admin,
          "insert into knowledge.person_names (id, ruling_id, entity_ids, value_fps, name_enc, created_at, compartments) values ($1, $2, $3, '{}', $4, now(), '{own}')",
          [
            personName,
            await ruled("person_name"),
            [testId("ent")],
            sealRow(
              db.keys,
              "own",
              { table: "knowledge.person_names", id: personName, column: "name_enc" },
              CANARIES.name,
            ),
          ],
        );
        // The owner's Remove's hide of a person, entity ids alone.
        await queryAs(
          db.urls.admin,
          "insert into knowledge.person_hides (ruling_id, entity_ids, created_at) values ($1, $2, now())",
          [await ruled("ignore"), [testId("ent")]],
        );
        // The owner's tier ruling, a tier word and fingerprints.
        await queryAs(
          db.urls.admin,
          "insert into knowledge.tier_rulings (ruling_id, tier, value_fps, created_at, compartments) values ($1, 'close', $2, now(), '{own}')",
          [await ruled("warmth_tier"), [fingerprint(db.keys, "address", CANARIES.address)]],
        );
        // One of the owner's areas, the canary name sealed in it.
        const area = testId("are");
        await queryAs(
          db.urls.admin,
          "insert into knowledge.areas (id, key, name_enc, position) values ($1, 'canary-area', $2, 1)",
          [area, sealRow(db.keys, "own", { table: "knowledge.areas", id: area, column: "name_enc" }, CANARIES.name)],
        );
        // One of the owner's lists, the canary name sealed in it, and its
        // one member, keyed fingerprints and no value.
        const list = testId("lst");
        const listed = await ruled("list_create");
        await queryAs(
          db.urls.admin,
          "insert into knowledge.owner_lists (id, ruling_id, name_enc, named_by, created_at, compartments) values ($1, $2, $3, $2, now(), '{own}')",
          [
            list,
            listed,
            sealRow(db.keys, "own", { table: "knowledge.owner_lists", id: list, column: "name_enc" }, CANARIES.name),
          ],
        );
        await queryAs(
          db.urls.admin,
          "insert into knowledge.owner_list_members (ruling_id, list_id, value_fps, created_at, compartments) values ($1, $2, $3, now(), '{own}')",
          [await ruled("list_add"), list, [fingerprint(db.keys, "address", CANARIES.address)]],
        );

        // A saved pair call, as the identity sweep writes it, with the canary text
        // in its sealed output. Its subject and refs are keyed fingerprints.
        const callId = testId("dcc");
        const pair = [
          fingerprint(db.keys, "address", CANARIES.address),
          fingerprint(db.keys, "address", CANARIES.ownerAddress),
        ].sort();
        await queryAs(
          db.urls.admin,
          `insert into vault.decision_calls (id, point, version, prompt_id, prompt_version, subject, refs, input_fp, model_id, output_enc, compartments)
           values ($1, 'identity_rank', 1, 'jev_same_person', '1', $2, $3, $4, 'typesafe/jev-1.13', $5, '{own}')`,
          [
            callId,
            `pair:${pair.join(":")}`,
            pair,
            fingerprint(db.keys, "model_input", "gate pair call"),
            sealUnder(
              db.keys,
              ["own"],
              { table: "vault.decision_calls", id: callId, column: "output_enc" },
              JSON.stringify({ rawOutput: `${CANARIES.name} and ${CANARIES.bodyText}`, outputHash: "a".repeat(64) }),
            ),
          ],
        );

        // The owner's goal, as pi_admin writes its projection, with the canary text in its sealed
        // statement.
        const goalRuling = testId("rul");
        await queryAs(
          db.urls.admin,
          `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'goal_set', 0, '{}', '{}', now(), '{own}')`,
          [goalRuling, testId("req")],
        );
        const goal = testId("gol");
        await queryAs(
          db.urls.admin,
          `insert into projections.goal_state (goal_id, status, ruling_id, stated_at, updated_at, compartments, statement_enc) values ($1, 'active', $2, now(), now(), '{own}', $3)`,
          [
            goal,
            goalRuling,
            sealUnder(
              db.keys,
              ["own"],
              { table: "projections.goal_state", id: goal, column: "statement_enc" },
              `Keep up with ${CANARIES.name}`,
            ),
          ],
        );
        // The owner's mission, as pi_admin writes it: the canary only in its sealed text.
        await queryAs(
          db.urls.admin,
          "insert into projections.planner_mission (one, set_at, compartments, text_enc) values (true, now(), '{own}', $1)",
          [
            sealUnder(
              db.keys,
              ["own"],
              { table: "projections.planner_mission", id: "mission", column: "text_enc" },
              `Help me meet ${CANARIES.name}`,
            ),
          ],
        );

        // A proposal and a memory change through their functions as pi_reader, each with the canary text in
        // its sealed body and the canary address only in fingerprints, and a restatement mark of the proposal
        // through the pipeline's function.
        const agentToken = `pit_test-gate-agent-${testId("x")}`;
        await queryAs(
          db.urls.admin,
          `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools)
           values ($1, 'gate-agent', $2, 'active', 'none', 'local', '{own,agent:gate-agent}', '{self,people,work}', '{propose_about_you,import_memory}')`,
          [testId("cli"), sha256Hex(agentToken)],
        );
        const agentSession = testId("ses");
        const [proposal, change] = [testId("rec"), testId("rec")];
        const agentBody = (id: string) =>
          sealUnder(
            db.keys,
            ["own"],
            { table: "ledger.agent_writes", id, column: "body_enc" },
            `${CANARIES.bodyText} ${CANARIES.name}`,
          );
        const contentFp = fingerprint(db.keys, "content_hash", sha256Hex(CANARIES.bodyText));
        await readAs(db, agentToken, async (query) => {
          await query("select policy.open_session($1)", [agentSession]);
          const label = one(await query<{ label: string[] }>("select policy.record_label() as label")).label;
          const proposed = await query<{ outcome: string }>(
            "select outcome from policy.propose_about_you($1, $2, $3, 'all', $4, $4, '{}', '{}', $5, $6)",
            [agentSession, proposal, testId("req").slice(4), contentFp, label, agentBody(proposal)],
          );
          expect(one(proposed).outcome).toBe("ok");
          const memory = {
            request_id: testId("req").slice(4),
            locator_fp: fingerprint(db.keys, "memory_locator", `/memory/${CANARIES.address}.md`),
            change: "added",
            entry_time: null,
            stamps: [],
            line_fps: [fingerprint(db.keys, "memory_line", CANARIES.bodyText)],
            record_id: change,
            content_fp: contentFp,
            cites_fp: contentFp,
            body_enc: agentBody(change),
          };
          expect(
            one(
              await query<{ outcome: string }>("select outcome from policy.import_memory($1, $2::jsonb, $3)", [
                agentSession,
                JSON.stringify([memory]),
                label,
              ]),
            ).outcome,
          ).toBe("ok");
        });
        const proposalEvidence = sha256Hex(`gate proposal ${proposal}`);
        await queryAs(db.urls.admin, "update ledger.agent_writes set evidence_id = $2 where id = $1", [
          proposal,
          proposalEvidence,
        ]);
        await queryAs(db.urls.pipeline, "select * from ledger.check_restatement($1, $2, 'stale', 'read', $3, 1)", [
          fingerprint(db.keys, "agent_claim", `${proposalEvidence}\n${fingerprint(db.keys, "fact", CANARIES.name)}`),
          proposalEvidence,
          fingerprint(db.keys, "fact", CANARIES.name),
        ]);

        // A category turned on, a restriction request, a lift, a screen and a term
        // pass, as pi_admin. Each holds ids, keyed fingerprints, categories, a label and times.
        const [item] = await queryAs<{
          id: string;
          source_account_id: string;
          source_item_fp: string;
          compartments: string[];
        }>(
          db.urls.admin,
          "select id, source_account_id, source_item_fp, compartments from vault.evidence_items order by id limit 1",
        );
        if (item === undefined) throw new Error("the seed writes an evidence row");
        await queryAs(db.urls.admin, "insert into policy.restricted_categories (category) values ('health')");
        await queryAs(
          db.urls.admin,
          "insert into vault.restriction_requests (id, evidence_id, kind, category, requested_by, compartments) values ($1, $2, 'restrict', 'health', 'screen', $3)",
          [testId("rrq"), item.id, item.compartments],
        );
        await queryAs(
          db.urls.admin,
          "insert into vault.restriction_lifts (account_id, source_item_fp, category, ruling_id, compartments) values ($1, $2, 'money', $3, $4)",
          [item.source_account_id, item.source_item_fp, goalRuling, item.compartments],
        );
        await queryAs(
          db.urls.admin,
          "insert into vault.restrict_screens (evidence_id, categories, compartments) values ($1, '{health}', $2)",
          [item.id, item.compartments],
        );
        await queryAs(db.urls.admin, "insert into vault.screen_passes (version, categories) values (1, '{health}')");

        // A seal on a canary's address and a signature's fields, as pi_admin.
        // The seal holds a keyed fingerprint; the fields are sealed.
        const canaryFp = fingerprint(db.keys, "address", CANARIES.address);
        await queryAs(
          db.urls.admin,
          "insert into knowledge.seals (id, kind, value_fp, ruling_id, journal_seq, sealed_at, compartments) values ($1, 'address', $2, $3, 1, now(), '{own}')",
          [testId("sel"), canaryFp, goalRuling],
        );
        const fields = sealUnder(
          db.keys,
          item.compartments,
          { table: "knowledge.signatures", id: item.id, column: "fields_enc" },
          JSON.stringify({ name: CANARIES.name, addresses: [CANARIES.address] }),
        );
        await queryAs(
          db.urls.admin,
          "insert into knowledge.signatures (evidence_id, sender_fp, sent_at, found, fields_enc, compartments) values ($1, $2, now(), true, $3, $4)",
          [item.id, canaryFp, fields, item.compartments],
        );

        // A project named for the canary, its anchor on a stored thread and the
        // canary claim's binding, as pi_admin writes them. The name is sealed; the rest are ids
        // and keyed fingerprints.
        const project = testId("ent");
        const [thread] = await queryAs<{ id: string; thread_fp: string }>(
          db.urls.admin,
          "select id, thread_fp from knowledge.messages where thread_fp is not null order by id limit 1",
        );
        if (thread === undefined) throw new Error("the seed writes a message with a thread");
        await queryAs(db.urls.admin, "insert into knowledge.entities (id, kind) values ($1, 'project')", [project]);
        await queryAs(
          db.urls.admin,
          "insert into knowledge.projects (id, status, name_enc, compartments, readers) values ($1, 'active', $2, '{own}', '{m-owner}')",
          [
            project,
            sealUnder(
              db.keys,
              ["own"],
              { table: "knowledge.projects", id: project, column: "name_enc" },
              CANARIES.name,
            ),
          ],
        );
        await queryAs(
          db.urls.admin,
          "insert into knowledge.project_anchors (id, project_id, kind, anchor_fp, ruling_id, created_at, compartments) values ($1, $2, 'email_thread', $3, $4, now(), '{own}')",
          [testId("pan"), project, thread.thread_fp, await ruled("project_anchor")],
        );
        await queryAs(
          db.urls.admin,
          "insert into knowledge.project_bindings (claim_id, project_id, anchor_kind, anchor_fp, basis, compartments, readers) values ($1, $2, 'email_thread', $3, 'anchor', '{own}', '{m-owner}')",
          [claim.id, project, thread.thread_fp],
        );

        // A stored page of a running owner link request, as pi_admin writes it,
        // with the canary name in its sealed title and names. A link's page is `own`.
        const pageUrl = "https://pages.example/gate";
        const research = testId("rsq");
        await queryAs(
          db.urls.admin,
          `insert into ledger.research_requests (id, request_id, author, kind, message_id, query_fp, source_item_fp, body_enc, compartments)
           values ($1, $2, 'owner', 'link', $3, $4, $5, $6, '{own}')`,
          [
            research,
            testId("req"),
            thread.id,
            fingerprint(db.keys, "research_query", `link\n${pageUrl}`),
            fingerprint(db.keys, "source_id", pageUrl),
            sealUnder(
              db.keys,
              ["own"],
              { table: "ledger.research_requests", id: research, column: "body_enc" },
              JSON.stringify({ url: pageUrl }),
            ),
          ],
        );
        await queryAs(
          db.urls.admin,
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('research_request', $1, 'running', now(), 'system:research', '{own}')",
          [research],
        );
        const web = testId("acc");
        await queryAs(
          db.urls.admin,
          "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, 'own', 'web', 'web_research', '{own}')",
          [web],
        );
        const pageAt = { vault: "personal" as const, sourceAccount: SourceAccountId.parse(web), sourceItemId: pageUrl };
        const pageEvidence = evidenceIdFor({ ...pageAt, revision: 0 });
        const pageBlob = testId("blb");
        await queryAs(
          db.urls.admin,
          "insert into vault.evidence_blobs (blob_ref, compartments, envelope) values ($1, '{own}', $2)",
          [
            pageBlob,
            sealRow(
              db.keys,
              "own",
              { table: "vault.evidence_blobs", id: pageBlob, column: "envelope" },
              Buffer.from(CANARIES.bodyText).toString("base64"),
            ),
          ],
        );
        await queryAs(
          db.urls.admin,
          `insert into vault.evidence_items (id, source_account_id, source_kind, source_item_fp, revision_tag_fp, revision, next_revision_id, content_hash, media_type,
             observed_at, change_kind, participant_members, system_originated, answers_system, payload_state, compartments, readers, blob_ref, item_enc)
           values ($1, $2, 'web_research', $3, $4, 0, $5, $6, 'text/html', now(), 'live', '{}', false, false, 'present', '{own}', '{m-owner}', $7, $8)`,
          [
            pageEvidence,
            web,
            fingerprint(db.keys, "source_id", pageUrl),
            fingerprint(db.keys, "revision_tag", sha256Hex(CANARIES.bodyText)),
            evidenceIdFor({ ...pageAt, revision: 1 }),
            hashFingerprint(db.keys, "content_hash", sha256Hex(CANARIES.bodyText)),
            pageBlob,
            sealRow(
              db.keys,
              "own",
              { table: "vault.evidence_items", id: pageEvidence, column: "item_enc" },
              JSON.stringify({ sourceItemId: pageUrl, markers: ["web"] }),
            ),
          ],
        );
        const pageId = testId("pag");
        await queryAs(
          db.urls.admin,
          `insert into knowledge.pages (id, evidence_id, request_id, url_fp, host_fp, fetched_at, media_type, page_enc, names_enc, compartments)
           values ($1, $2, $3, $4, $5, now(), 'text/html', $6, $7, '{own}')`,
          [
            pageId,
            pageEvidence,
            research,
            fingerprint(db.keys, "url", pageUrl),
            fingerprint(db.keys, "host", new URL(pageUrl).host),
            sealRow(
              db.keys,
              "own",
              { table: "knowledge.pages", id: pageId, column: "page_enc" },
              JSON.stringify({ url: pageUrl, title: CANARIES.subject }),
            ),
            sealRow(
              db.keys,
              "own",
              { table: "knowledge.pages", id: pageId, column: "names_enc" },
              JSON.stringify([CANARIES.name]),
            ),
          ],
        );

        // From Lens's inbox migration: one device, its three source accounts and one stored capture
        // item, as pi_admin writes them, with the canary person in the item's sealed facts. A
        // device's accounts hold no address, and the item's row only ids, times, kinds and keyed
        // fingerprints.
        await session(db.urls.admin, async (query) => {
          const seed = seeder(db, query);
          const device = await seed.lensDevice({ name: "gate-mac" });
          const item = await seed.capture(["own"], device);
          await query("update knowledge.captures set facts_enc = $1 where id = $2", [
            sealUnder(
              db.keys,
              ["own"],
              { table: "knowledge.captures", id: item.id, column: "facts_enc" },
              JSON.stringify({ participants: [{ name: CANARIES.name, address: CANARIES.address }] }),
            ),
            item.id,
          ]);
          // One member of a moment group's saved call, as the pipeline saves it.
          // The row holds the call's id, the member's evidence id and the call's compartments.
          await seed.into("vault.model_call_members")(["own"]);
          // One join of the owner's, fingerprints and ids only.
          await seed.into("knowledge.fact_rulings")(["own"]);
          // One judgment of the sweep's: fingerprints, claim ids and closed words.
          await seed.into("knowledge.same_fact_judgments")(["own"]);
          // One release of the owner's, ids, a closed word and times.
          await seed.into("knowledge.claim_releases")(["own"]);
          // And one journalled lift of a release: a sequence number and an id.
          await seed.into("knowledge.release_lifts")(["own"]);
          // One person's warmth day and one label's build row: ids, numbers, dates and closed
          // words.
          await seed.into("projections.warmth_days")(["own"]);
          await seed.into("projections.warmth_day_builds")(["own"]);
          // One chat line: ids, a direction, a time, a count, a fingerprint.
          await seed.into("knowledge.chat_lines")(["own"]);
          // One relation between two claims, keys, closed words and times.
          // The claims' value rows hold keyed fingerprints alone.
          await seed.into("knowledge.claim_relations")(["own"]);
          // One goal id row: ids and a keyed fingerprint.
          await seed.into("knowledge.goal_ids")(["own"]);
          // One claim's name row (a keyed fingerprint) and one named
          // organization's name row (its name sealed).
          await seed.into("knowledge.claim_org_names")(["own"]);
          await seed.into("knowledge.org_names")(["own"]);
          // One goal key ruling (an id, a closed word, a keyed
          // fingerprint) and one goal key rank (a fingerprint and a number).
          await seed.into("knowledge.goal_key_rulings")(["own"]);
          await seed.into("projections.goal_key_ranks")(["own"]);
          // One stretch of the owner's time: ids, times and a label.
          await seed.into("knowledge.time_rulings")(["own"]);
          // One agent anchor and one agent ruling: ids, a keyed fingerprint, times and a label.
          await seed.into("knowledge.agent_anchors")(["own"]);
          await seed.into("knowledge.agent_time_rulings")(["own"]);
          // One promoted claim: ids, a ref, a type, times and its statement sealed.
          await seed.into("knowledge.promoted_claims")(["own"]);
        });

        const counts = await rowCounts(db);
        const empty = [
          ...tablesIn("vault", "knowledge", "projections"),
          { name: "policy.secrets" },
          { name: "ledger.restatement_checks" },
          { name: "ledger.memory_imports" },
        ]
          .map((table) => table.name)
          .filter((name) => !((counts[name] ?? 0) > 0));
        expect(empty).toEqual([]);

        const needles: string[] = Object.values(CANARIES);
        expect(needles).toEqual(
          expect.arrayContaining([
            CANARIES.ownerAddress,
            CANARIES.ownerName,
            CANARIES.address,
            CANARIES.name,
            CANARIES.subject,
            CANARIES.eventTitle,
            CANARIES.bodyText,
            CANARIES.attachmentName,
          ]),
        );
        expect(await scanForPlaintext(db.urls.admin, needles)).toEqual([]);

        // The self-test: a canary planted in plaintext is found, whatever its case, and so is
        // one planted as base64 inside a `jsonb` value.
        const message = one(
          await queryAs<{ id: string }>(
            db.urls.admin,
            "select id from knowledge.messages where subject_enc is not null order by id limit 1",
          ),
        ).id;
        const plant = (value: string): Promise<unknown> =>
          queryAs(
            db.urls.admin,
            "update knowledge.messages set subject_enc = jsonb_set(subject_enc, '{ciphertext}', to_jsonb($1::text)) where id = $2",
            [value, message],
          );
        await plant(CANARIES.subject.toUpperCase());
        expect(places(await scanForPlaintext(db.urls.admin, needles))).toEqual(["messages.subject_enc"]);
        await plant(Buffer.from(`x ${CANARIES.name} x`).toString("base64"));
        expect(places(await scanForPlaintext(db.urls.admin, needles))).toEqual(["messages.subject_enc"]);
        // The scan reaches `text[]` and `text` columns too, keys included. Planted as the table's
        // owner: no runtime role updates a label.
        await asTablesOwner(db, ["knowledge.aliases"], (query) =>
          query("update knowledge.aliases set compartments = compartments || $1::text", [CANARIES.address]),
        );
        expect(places(await scanForPlaintext(db.urls.admin, needles))).toEqual([
          "aliases.compartments",
          "messages.subject_enc",
        ]);
        await insertSecret(db, CANARIES.eventTitle, "planted");
        expect(places(await scanForPlaintext(db.urls.admin, needles))).toEqual([
          "aliases.compartments",
          "messages.subject_enc",
          "secrets.name",
        ]);
      }));

    // What a message says and what its attachments are called
    // are content too, in a person's message and in a bulk one alike.
    it("a canary body and attachment name are in no column", () =>
      withStore(async ({ db, writer }) => {
        const accounts = await connect(writer);
        expect(await ingestMail(writer, accounts.personalMail, MAIL.canary)).toBe("stored");
        expect(await ingestMail(writer, accounts.workMail, BULK_CANARY)).toBe("stored");

        // The positive control: both canaries are stored, in each message's row, and open there.
        const stored = async (account: typeof accounts.personalMail, fixture: MailFixture) => {
          const row = one(
            await queryAs<{ id: string; compartments: string[]; body_enc: unknown; facts_enc: unknown }>(
              db.urls.admin,
              "select id, compartments, body_enc, facts_enc from knowledge.messages where evidence_id = $1",
              [evidenceIdOf(account, mailSourceId(fixture))],
            ),
          );
          const at = (column: string) => ({ table: "knowledge.messages", id: row.id, column });
          const compartment = row.compartments[0] ?? "";
          return {
            body: opened(db, compartment, at("body_enc"), row.body_enc),
            attachments: (
              JSON.parse(opened(db, compartment, at("facts_enc"), row.facts_enc)) as { attachments: unknown }
            ).attachments,
          };
        };
        expect(await stored(accounts.personalMail, MAIL.canary)).toEqual({
          body: CANARIES.bodyText,
          attachments: MAIL.canary.attachments,
        });
        expect(await stored(accounts.workMail, BULK_CANARY)).toEqual({
          body: BULK_CANARY.text,
          attachments: BULK_CANARY.attachments,
        });

        // In no column in plaintext, whole or in part, the evidence payload included.
        const needles = [
          CANARIES.bodyText,
          CANARIES.attachmentName,
          "heron ledger is under the third lamp",
          "canary-heron-ledger",
        ];
        expect(await scanForPlaintext(db.urls.admin, needles)).toEqual([]);

        // The self-test: each is found once it is planted in the column that should seal it.
        const message = one(
          await queryAs<{ id: string }>(
            db.urls.admin,
            "select id from knowledge.messages where body_enc is not null order by id limit 1",
          ),
        ).id;
        await queryAs(
          db.urls.admin,
          "update knowledge.messages set body_enc = jsonb_set(body_enc, '{ciphertext}', to_jsonb($1::text)) where id = $2",
          [CANARIES.bodyText, message],
        );
        expect(places(await scanForPlaintext(db.urls.admin, needles))).toEqual(["messages.body_enc"]);
        const planted = Buffer.from(
          JSON.stringify({ attachments: [{ name: CANARIES.attachmentName.toUpperCase() }] }),
        ).toString("base64");
        await queryAs(
          db.urls.admin,
          "update knowledge.messages set facts_enc = jsonb_set(facts_enc, '{ciphertext}', to_jsonb($1::text)) where id = $2",
          [planted, message],
        );
        expect(places(await scanForPlaintext(db.urls.admin, needles))).toEqual([
          "messages.body_enc",
          "messages.facts_enc",
        ]);
      }));
  });

  describe("each role's rights", () => {
    it("the reader cannot write, or read policy or vault", () =>
      withDatabase(async (db) => {
        await seedBothCompartments(db);
        const client = await insertClient(db, "own-only", ["own"]);

        const writes = await readerWriteProbes(db, client.token);
        expect(writes).toHaveLength(TABLES.length * 3);
        const reads = await readerReadProbes(db, client.token);
        expect(reads).toHaveLength(tablesIn("policy", "vault").length);
        for (const probe of [...writes, ...reads]) {
          expect(probe.refused, probe.sql).toBe("42501");
          // The positive control: the same statement as a role that may.
          expect(probe.control, `control: ${probe.sql}`).toBeNull();
        }
        // The control for the reader itself: under the same token it reads `knowledge`.
        const seen = await readAs(db, client.token, (query) =>
          query<{ n: number }>("select count(id)::int as n from knowledge.entities"),
        );
        expect(one(seen).n).toBe(2);
      }));

    it("the writer cannot read clients or calls, or write secrets", () =>
      withDatabase(async (db) => {
        const probes = await writerPolicyProbes(db);
        expect(probes.map((probe) => probe.sql.split(" ").slice(0, 4).join(" "))).toEqual([
          "select count(*) from policy.clients",
          "select count(*) from policy.calls",
          "insert into policy.secrets (name,",
          "update policy.secrets set updated_at",
          "delete from policy.secrets where",
        ]);
        for (const probe of probes) {
          expect(probe.refused, probe.sql).toBe("42501");
          expect(probe.control, `control: ${probe.sql}`).toBeNull();
        }
        // The control for the writer itself: it reads the secrets it may not write.
        expect(await sqlState(() => queryAs(db.urls.writer, "select name from policy.secrets"))).toBeNull();
      }));

    it("no runtime role owns a table or bypasses security", () =>
      withDatabase(async (db) => {
        const tables = await queryAs<{ name: string; owner: string; enabled: boolean; forced: boolean }>(
          db.urls.admin,
          `select n.nspname || '.' || c.relname as name, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p') and n.nspname = any($1) order by 1`,
          [SCHEMAS],
        );
        expect(tables.map((table) => table.name).sort()).toEqual(TABLES.map((table) => table.name).sort());
        for (const table of tables) {
          // Owned by the role that cannot log in, with row-level security forced on it too.
          expect(table, table.name).toMatchObject({ owner: "pi_owner", enabled: true, forced: true });
        }

        // Nothing in the database is owned by a runtime role: no table, sequence, view or index.
        const owned = await queryAs<{ name: string }>(
          db.urls.admin,
          "select c.relname::text as name from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = any($1)",
          [RUNTIME_ROLES],
        );
        expect(owned).toEqual([]);

        const roles = await queryAs<{ role: string; login: boolean; bypass: boolean; superuser: boolean }>(
          db.urls.admin,
          "select rolname::text as role, rolcanlogin as login, rolbypassrls as bypass, rolsuper as superuser from pg_roles where rolname = any($1) order by 1",
          [[...RUNTIME_ROLES, "pi_owner"]],
        );
        expect(roles).toEqual([
          { role: "pi_admin", login: true, bypass: false, superuser: false },
          { role: "pi_owner", login: false, bypass: false, superuser: false },
          { role: "pi_pipeline", login: true, bypass: false, superuser: false },
          { role: "pi_proxy", login: true, bypass: false, superuser: false },
          { role: "pi_reader", login: true, bypass: false, superuser: false },
          { role: "pi_restricted", login: true, bypass: false, superuser: false },
          { role: "pi_work", login: true, bypass: false, superuser: false },
          { role: "pi_writer", login: true, bypass: false, superuser: false },
        ]);
        // And none is a member of the role that owns the tables: `bool_or` over the rows of
        // `pg_auth_members`, one row per grantor, which is null when there is none.
        const memberOfOwner = async (roles: readonly string[]): Promise<boolean | null> =>
          one(
            await queryAs<{ member: boolean | null }>(
              db.urls.admin,
              `select bool_or(true) as member from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles g on g.oid = m.member
               where r.rolname = 'pi_owner' and g.rolname = any($1)`,
              [roles],
            ),
          ).member;
        expect(await memberOfOwner(RUNTIME_ROLES)).toBeNull();
        // The positive control: the same query finds the bootstrap's membership.
        const bootstrap = one(
          await queryAs<{ role: string }>(db.urls.bootstrap, "select current_user::text as role"),
        ).role;
        expect(RUNTIME_ROLES).not.toContain(bootstrap);
        expect(await memberOfOwner([bootstrap])).toBe(true);
      }));

    it("only the reader can execute the functions", () =>
      withDatabase(async (db) => {
        const client = await insertClient(db, "own-only", ["own"]);
        const calls = [
          "select * from policy.current_client()",
          "select policy.client_clearance()",
          "select policy.log_call('search', 0, 'ok')",
        ];

        for (const sql of calls) {
          expect(await sqlState(() => queryAs(db.urls.admin, sql)), `pi_admin: ${sql}`).toBe("42501");
          expect(await sqlState(() => queryAs(db.urls.writer, sql)), `pi_writer: ${sql}`).toBe("42501");
          // The positive control: the same call as the reader, under a client's token.
          expect(await sqlState(() => readAs(db, client.token, (query) => query(sql))), `pi_reader: ${sql}`).toBeNull();
        }

        // By the catalogue: the core's functions, and EXECUTE on each for pi_reader alone; every
        // other function, each for exactly the roles its spec gives it. PUBLIC has none.
        const functions = await queryAs<{
          name: string;
          admin: boolean;
          writer: boolean;
          reader: boolean;
          anyone: boolean;
        }>(
          db.urls.admin,
          `select p.proname::text as name,
                  has_function_privilege('pi_admin', p.oid, 'EXECUTE') as admin,
                  has_function_privilege('pi_writer', p.oid, 'EXECUTE') as writer,
                  has_function_privilege('pi_reader', p.oid, 'EXECUTE') as reader,
                  coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), true) as anyone
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = any($1) order by 1`,
          [SCHEMAS],
        );
        const o1 = ["audiences", "claim_entities_label", "claims_label", "withheld_items"];
        // Every function beyond the core's, each for exactly the roles its spec gives it.
        const O4A: Record<string, { admin: boolean; writer: boolean; reader: boolean }> = {
          label: { admin: true, writer: true, reader: true },
          vetoed_by: { admin: true, writer: false, reader: false },
          vetoed: { admin: true, writer: false, reader: false },
          // The writer raises identity cards at the end of a sync.
          lock_rows: { admin: true, writer: true, reader: false },
          // A compartment name check that a check constraint calls as the writing role.
          compartments_valid: { admin: true, writer: true, reader: false },
          owner_backed: { admin: true, writer: false, reader: false },
          // The owner's task, the owner's command alone.
          owner_task: { admin: true, writer: false, reader: false },
          admit_deferred: { admin: true, writer: false, reader: false },
          add_basis: { admin: true, writer: true, reader: false },
          taint_citing: { admin: true, writer: true, reader: false },
          // The erasure mark, for every role's start check.
          erasure_mark: { admin: true, writer: true, reader: true },
          // The owner's rulings' four: three for the pipeline alone, and the drop of a declassified
          // copy for every role that deletes a claim. The admin reads the rule for `pi self review`.
          rejected_claims: { admin: true, writer: false, reader: false },
          fact_vetoes: { admin: false, writer: false, reader: false },
          belief_rulings_mark: { admin: false, writer: false, reader: false },
          drop_declassified: { admin: true, writer: true, reader: false },
          // The claim removal functions: the store's shared removal paths, which the writer and the
          // owner's commands run.
          remove_claims: { admin: true, writer: true, reader: false },
          remove_extracted_claims: { admin: true, writer: true, reader: false },
          remove_person_links: { admin: true, writer: true, reader: false },
          // Durable work's: the twelve a client calls, the current client's kind and
          // check_back_blocked for the reader alone; end_run and basis_flagged for pi_work alone;
          // spend_on for pi_work and pi_admin.
          ...Object.fromEntries(
            [
              "current_client_kind",
              "work_grants",
              "check_back_blocked",
              "propose_hypothesis",
              "record_test",
              "propose_opportunity",
              "set_intention",
              "claim",
              "release",
              "plan_move",
              "report_move",
              "next_run",
              "append_step",
              "finish_run",
            ].map((name) => [name, { admin: false, writer: false, reader: true }]),
          ),
          end_run: { admin: false, writer: false, reader: false },
          basis_flagged: { admin: false, writer: false, reader: false },
          spend_on: { admin: true, writer: false, reader: false },
          // The send proxy's: four for the reader, the tag for the writer, the erasure's two hooks
          // for the admin; the rest are pi_proxy's alone.
          append_draft: { admin: false, writer: false, reader: true },
          draft_accounts: { admin: false, writer: false, reader: true },
          gate_facts: { admin: false, writer: false, reader: true },
          use_only_candidates: { admin: false, writer: false, reader: true },
          // The gate's contact check, as the reader at phase draft.
          contact_candidates: { admin: false, writer: false, reader: true },
          append_gate_decision: { admin: false, writer: false, reader: true },
          first_contacts: { admin: false, writer: false, reader: false },
          begin_send: { admin: false, writer: false, reader: false },
          finish_send: { admin: false, writer: false, reader: false },
          settle_send: { admin: false, writer: false, reader: false },
          read_connected: { admin: false, writer: false, reader: false },
          sent_tag: { admin: false, writer: true, reader: false },
          forget_recipients: { admin: true, writer: false, reader: false },
          forget_sent_source: { admin: true, writer: false, reader: false },
          // Two internal helpers of the send functions, granted to no role.
          record_sent: { admin: false, writer: false, reader: false },
          // The task executor's: the reader's tool and board read, the tick's raise, the judge's filter.
          record_spend: { admin: false, writer: false, reader: true },
          // The outcome test's: the reader's tools; filing is pi_admin's.
          start_outcome_test: { admin: false, writer: false, reader: true },
          live_held_out_questions: { admin: false, writer: false, reader: true },
          record_held_out_question: { admin: false, writer: false, reader: true },
          record_outcome_task: { admin: false, writer: false, reader: true },
          file_improvement: { admin: true, writer: false, reader: false },
          close_improvement_cause: { admin: true, writer: false, reader: false },
          // The queue an agent works: the owner's dismissal and role, the role trigger, the health read.
          owner_close_improvement: { admin: true, writer: false, reader: false },
          set_improvement_role: { admin: true, writer: false, reader: false },
          // The role defects go to, the owner's to set and unset.
          assign_defects: { admin: true, writer: false, reader: false },
          default_improvement_role: { admin: false, writer: false, reader: false },
          health_read: { admin: false, writer: false, reader: true },
          // Work that lasts days: whether a lapsed lease holds work from the caller, and each piece
          // of work's latest progress, for the reader; the hold's check for no role.
          lapse_held: { admin: false, writer: false, reader: true },
          lapse_held_from: { admin: false, writer: false, reader: false },
          work_progress: { admin: false, writer: false, reader: true },
          // Work held to a date: whether a check-back of a client's holds a piece of work, for the
          // owner's process and never the reader, and whether the owner stopped all agent work, for
          // the reader.
          check_back_holds: { admin: true, writer: false, reader: false },
          work_stopped: { admin: false, writer: false, reader: true },
          work_held: { admin: true, writer: false, reader: false },
          work_trail: { admin: false, writer: false, reader: true },
          // Projects agents write: the two tools' definers, each project's author, and the project
          // and dependencies of work just proposed, for the reader alone.
          propose_project: { admin: false, writer: false, reader: true },
          update_project: { admin: false, writer: false, reader: true },
          project_creators: { admin: false, writer: false, reader: true },
          place_work: { admin: false, writer: false, reader: true },
          // Used work: the owner's report; the reader's board order.
          task_standing: { admin: true, writer: false, reader: true },
          task_value: { admin: true, writer: false, reader: false },
          // Same-person questions and rules.
          answer_same_person: { admin: false, writer: false, reader: true },
          card_pattern: { admin: true, writer: false, reader: false },
          card_rule_stop: { admin: true, writer: false, reader: false },
          stop_card_by_rule: { admin: true, writer: true, reader: false },
          withdraw_empty_batch: { admin: true, writer: true, reader: false },
          identity_agents_on: { admin: true, writer: true, reader: false },
          pair_shape: { admin: true, writer: true, reader: false },
          policy_ruling: { admin: true, writer: true, reader: false },
          propose_question_rule: { admin: false, writer: false, reader: false },
          rule_answers: { admin: false, writer: false, reader: false },
          same_person_blocked: { admin: true, writer: true, reader: false },
          same_person_side: { admin: false, writer: false, reader: false },
          same_person_clients: { admin: true, writer: true, reader: false },
          same_person_gaps: { admin: false, writer: false, reader: false },
          same_person_rebatch: { admin: true, writer: true, reader: false },
          declined_by_caller: { admin: false, writer: false, reader: true },
          expect_gap_flag: { admin: false, writer: false, reader: false },
          gap_default_works: { admin: false, writer: false, reader: false },
          lock_send: { admin: false, writer: false, reader: false },
          // Agent claims' three: pi_pipeline's alone.
          expire_agent_claims: { admin: false, writer: false, reader: false },
          add_agent_claim_basis: { admin: false, writer: false, reader: false },
          // pi_pipeline's, and pi_admin's for the items a veto or a retire records, and the reader's
          // for find_facts' tier.
          confirmed_claims: { admin: true, writer: false, reader: true },
          agent_confirmed_claims: { admin: true, writer: false, reader: true },
          // what the owner's relayed confirm answered, the same.
          relayed_claims: { admin: true, writer: false, reader: true },
          agent_ruling_kinds: { admin: true, writer: false, reader: false },
          card_relay_never: { admin: false, writer: false, reader: false },
          // The memory adapters' one: the reader's sync alone.
          serve_memory: { admin: false, writer: false, reader: true },
          propose_about_you: { admin: false, writer: false, reader: true },
          import_memory: { admin: false, writer: false, reader: true },
          confirmed_preferences: { admin: false, writer: false, reader: true },
          session_reads: { admin: false, writer: false, reader: false },
          check_restatement: { admin: false, writer: false, reader: false },
          stale_restatements: { admin: false, writer: false, reader: false },
          // Wakes from state: state_wakes for pi_work alone.
          state_wakes: { admin: false, writer: false, reader: false },
          // The identity sweep's one: pi_pipeline's alone.
          mark_recovery: { admin: false, writer: false, reader: false },
          note_model_exposure: { admin: false, writer: false, reader: false },
          read_log_exposure: { admin: false, writer: false, reader: false },
          // The start check's mark, for every role that executes the erasure mark.
          journal_mark: { admin: true, writer: true, reader: true },
          // The clearance of the client an agent-app rule names, for the drain.
          agent_app_label: { admin: false, writer: true, reader: false },
          // The label test every runtime role's policies call, the workers' request,
          // and the screens' label trigger.
          is_restricted: { admin: true, writer: true, reader: true },
          request_restriction: { admin: false, writer: false, reader: false },
          restrict_screens_label: { admin: false, writer: false, reader: false },
          label_key: { admin: true, writer: true, reader: true },
          ...Object.fromEntries(
            ["clearance_keys", "view_keys", "current_id_mode"].map((name) => [
              name,
              { admin: false, writer: false, reader: true },
            ]),
          ),
          // The bindings' label trigger, granted to no role.
          binding_label: { admin: false, writer: false, reader: false },
          file_research: { admin: false, writer: false, reader: true },
          research_state: { admin: false, writer: false, reader: false },
          pages_of_request: { admin: false, writer: false, reader: false },
          // The two outcome functions pi_work's tick calls, and their id helper,
          // granted to no role.
          match_outcomes: { admin: false, writer: false, reader: false },
          assess_outcomes: { admin: false, writer: false, reader: false },
          new_id: { admin: false, writer: false, reader: false },
          // pi http's five OAuth steps, for the reader alone.
          ...Object.fromEntries(
            ["oauth_register", "oauth_registration", "oauth_authorize", "oauth_exchange", "oauth_refresh"].map(
              (name) => [name, { admin: false, writer: false, reader: true }],
            ),
          ),
          // Answering an owner question, for the reader alone, and the records the owner
          // answered, for the pipeline alone.
          answer_owner_question: { admin: false, writer: false, reader: true },
          // And pi_admin, as confirmed_claims.
          answered_records: { admin: true, writer: false, reader: false },
          // The erasure's hook on trial outputs, for the admin alone.
          forget_trial_outputs: { admin: true, writer: false, reader: false },
          // The erasure's hook on web steps' text, for the admin alone.
          forget_web_requests: { admin: true, writer: false, reader: false },
          // The erasure's hook on target-less decisions, for the admin alone.
          taint_subject_decisions: { admin: true, writer: false, reader: false },
          // The erasure hook's taint of an erased person's goal targets.
          taint_goal_targets: { admin: true, writer: false, reader: false },
          // A lessons run's owner actions, for the reasoner through the reader alone.
          run_owner_actions: { admin: false, writer: false, reader: true },
          // The erasure's hook on the lessons of runs shown a reached decision, for the admin alone.
          retire_shown_lessons: { admin: true, writer: false, reader: false },
          // The owner's own lesson, for the admin alone.
          add_owner_lesson: { admin: true, writer: false, reader: false },
          // Lens's inbox: the device's push, for the reader alone, and the owner erasure's writer
          // of erased keys, for pi_admin alone.
          push_capture: { admin: false, writer: false, reader: true },
          // The device's erased keys for its push's ack, for the reader alone.
          capture_erased_since_push: { admin: false, writer: false, reader: true },
          capture_erased: { admin: true, writer: false, reader: false },
          // Lens's mirror migration: a mirror client's read and its two reads of its own mirror state, for the reader alone, and
          // the erasure hook's taint and revocation's ending, for pi_admin alone.
          serve_mirror: { admin: false, writer: false, reader: true },
          mirror_cursor: { admin: false, writer: false, reader: true },
          mirror_tokens: { admin: false, writer: false, reader: true },
          taint_mirror_entities: { admin: true, writer: false, reader: false },
          end_mirror: { admin: true, writer: false, reader: false },
          // A rotated device client's OAuth tokens revoked, for pi_admin
          // alone (policy.oauth_authorize is replaced, with its grants).
          revoke_device_oauth: { admin: true, writer: false, reader: false },
          // The retires in force, for the pipeline alone.
          fact_retirements: { admin: false, writer: false, reader: false },
          // The domain and kind rulings and the carried items, for the pipeline alone.
          fact_reclassifications: { admin: false, writer: false, reader: false },
          carried_ruling_items: { admin: false, writer: false, reader: false },
          // The joins and splits in force, for the pipeline alone.
          fact_rulings: { admin: false, writer: false, reader: false },
          // The sweep's judgments' label trigger, executed by no role.
          same_fact_judgments_label: { admin: false, writer: false, reader: false },
          // The claims' trigger that stores the go, executed by no role.
          mark_fact_key_v2: { admin: false, writer: false, reader: false },
          // And the trigger that holds the go once set, executed by no role.
          hold_fact_key_v2: { admin: false, writer: false, reader: false },
          // The fact rulings' trigger that raises their mark,
          // executed by no role, and the erasure hook's scrub of their decisions, for the admin.
          mark_fact_rulings: { admin: false, writer: false, reader: false },
          forget_fact_rulings: { admin: true, writer: false, reader: false },
          // The releases in force, for the pipeline, the reader (so find_facts serves a released
          // claim only while its release is in force), the admin, whose entity page reads the same
          // support, and the writer, for the sync's confirmed people; and the releases' insert
          // check, executed by no role.
          released_records: { admin: true, writer: true, reader: true },
          claim_releases_check: { admin: false, writer: false, reader: false },
          // The proposal wake's notify trigger, executed by no role.
          notify_agent_write: { admin: false, writer: false, reader: false },
          // Whether every reader withholds an entity the caller sees.
          entity_withheld: { admin: false, writer: false, reader: true },
          withheld_entities: { admin: false, writer: false, reader: true },
          // Whether a card has an event, for the
          // writer's insert policy alone.
          card_unopened: { admin: false, writer: true, reader: false },
          // propose_task, hand_off and the caller's roles for the reader alone;
          // a task's route and the task kinds, executed by no role but their definers' owner.
          propose_task: { admin: false, writer: false, reader: true },
          hand_off: { admin: false, writer: false, reader: true },
          current_roles: { admin: false, writer: false, reader: true },
          route_of: { admin: false, writer: false, reader: false },
          task_kind: { admin: false, writer: false, reader: false },
          // A proposal about a person, for the reader alone.
          propose_person: { admin: false, writer: false, reader: true },
          // The board's holders for the reader; the gaps and a flag for
          // pi_work alone; the warm-path helper and the owner request's trigger for no role.
          board_holders: { admin: false, writer: false, reader: true },
          // The named fingerprints of a page, for the pipeline and the
          // restricted worker, none of these three.
          named_fps: { admin: false, writer: false, reader: false },
          // A record's read receipts and the live corrections, for the reader.
          live_corrections: { admin: false, writer: false, reader: true },
          record_reads: { admin: false, writer: false, reader: true },
          // The mixed-session mark's two booleans, for the reader alone.
          session_path: { admin: false, writer: false, reader: true },
          gap_candidates: { admin: false, writer: false, reader: false },
          raise_gap_flag: { admin: false, writer: false, reader: false },
          // The gap flags' reads, their close and rung 0's facts of one opportunity, for pi_work
          // and pi_pipeline alone; the frontier's nodes, for pi_pipeline alone.
          gap_flag_rows: { admin: false, writer: false, reader: false },
          gap_supply_rows: { admin: false, writer: false, reader: false },
          gap_raised_by_trigger: { admin: false, writer: false, reader: false },
          gap_explored_rows: { admin: false, writer: false, reader: false },
          close_gap_flag: { admin: false, writer: false, reader: false },
          opportunity_facts: { admin: false, writer: false, reader: false },
          explore_gaps: { admin: false, writer: false, reader: false },
          defect_gaps: { admin: false, writer: false, reader: false },
          // A card an agent is asked first: the tick's gaps for pi_work alone; a task's card and
          // the agent's answer for the reader; the kinds for the tick, the reader and the owner's
          // reads; which answer settles for the owner's reads.
          card_gaps: { admin: false, writer: false, reader: false },
          card_question: { admin: false, writer: false, reader: true },
          answer_card: { admin: false, writer: false, reader: true },
          card_attempt_kinds: { admin: true, writer: false, reader: true },
          card_answer_settles: { admin: true, writer: false, reader: false },
          // The three daily triggers' gaps, for pi_work alone.
          autonomy_gaps: { admin: false, writer: false, reader: false },
          // close_no_tie's gaps, for pi_pipeline alone.
          close_no_tie_gaps: { admin: false, writer: false, reader: false },
          // close_no_role's gaps, for pi_pipeline alone.
          close_no_role_gaps: { admin: false, writer: false, reader: false },
          // deadline_soon's gaps, for pi_work alone.
          deadline_gaps: { admin: false, writer: false, reader: false },
          // goal_review's and meeting_followup's gaps, for pi_work alone.
          goal_review_gaps: { admin: false, writer: false, reader: false },
          meeting_followup_gaps: { admin: false, writer: false, reader: false },
          // The own ties within a label, for no role; an intro_path's introducers, for pi_work
          // alone.
          gap_own: { admin: false, writer: false, reader: false },
          gap_intro_paths: { admin: false, writer: false, reader: false },
          // The frontier within a label, for no role.
          gap_frontier: { admin: false, writer: false, reader: false },
          // The goals' target ids, for the writer's removal alone.
          goal_target_ids: { admin: false, writer: true, reader: false },
          // The binding trigger that keeps a goal's target on its name's binding, for no role.
          settle_named_targets: { admin: false, writer: false, reader: false },
          // The same, on an organization's name row, for no role.
          settle_named_org_targets: { admin: false, writer: false, reader: false },
          // Agent mail: the reader's six; their helpers for no role.
          post_agent_message: { admin: false, writer: false, reader: true },
          agent_inbox: { admin: false, writer: false, reader: true },
          submit_improvement: { admin: false, writer: false, reader: true },
          list_improvements: { admin: false, writer: false, reader: true },
          improvement_events_of: { admin: false, writer: false, reader: true },
          update_improvement: { admin: false, writer: false, reader: true },
          agent_mail_reader: { admin: false, writer: false, reader: false },
          agent_mail_caller: { admin: false, writer: false, reader: false },
          agent_message_visible: { admin: false, writer: false, reader: false },
          improvement_status: { admin: false, writer: false, reader: false },
          gap_warm: { admin: false, writer: false, reader: false },
          owner_request_taken_in: { admin: false, writer: false, reader: false },
          // The labels' trigger for no role, and pi status's
          // count of missing labels for the admin alone.
          note_labels: { admin: false, writer: false, reader: false },
          labels_missing: { admin: true, writer: false, reader: false },
          // The notice helpers and triggers for none of these three
          // (notice_current is pi_notify's alone).
          keys_of: { admin: false, writer: false, reader: false },
          notice_due: { admin: false, writer: false, reader: false },
          claimable_by: { admin: false, writer: false, reader: false },
          notice_current: { admin: false, writer: false, reader: false },
          write_notices: { admin: false, writer: false, reader: false },
          opportunity_tainted: { admin: false, writer: false, reader: false },
          // A box health card's notices for the admin, which raises the
          // card; who may be told for none; whether one stands for pi_notify alone.
          health_notice: { admin: true, writer: false, reader: false },
          health_notice_due: { admin: false, writer: false, reader: false },
          // What an agent is told a card is about, for none.
          health_notice_about: { admin: false, writer: false, reader: false },
          health_notice_current: { admin: false, writer: false, reader: false },
          // The answer from the owner on a match key for the pipeline alone; the identity merge for the
          // writer and the admin; the settled records for the reader.
          fact_answer: { admin: false, writer: false, reader: false },
          // A release under the owner's standing grant, those in force, and
          // whether the owner removed a fact: the pipeline's alone.
          grant_release: { admin: false, writer: false, reader: false },
          granted_releases: { admin: false, writer: false, reader: false },
          fact_ruled: { admin: false, writer: false, reader: false },
          // The owner's confirm rates; the inner count, for no role; an agent's own counts.
          confirm_rates: { admin: true, writer: false, reader: false },
          confirm_rates_within: { admin: false, writer: false, reader: false },
          my_confirm_rates: { admin: false, writer: false, reader: true },
          // An agent's own record: every agent's for the owner, the calling agent's own for the
          // reader.
          agent_records_within: { admin: true, writer: false, reader: false },
          my_agent_record: { admin: false, writer: false, reader: true },
          // The idea ledger as an agent can see it, for the reader alone.
          list_ideas: { admin: false, writer: false, reader: true },
          // The known issues of an agent's pack, for the reader alone.
          known_issues: { admin: false, writer: false, reader: true },
          // An agent's seen on a box health card, for the reader alone.
          mark_health_seen: { admin: false, writer: false, reader: true },
          // A recorded meeting for read_meeting and a meeting fact's passage, for the reader alone;
          // its gate, for no role.
          meeting_transcript: { admin: false, writer: false, reader: true },
          meeting_caller: { admin: false, writer: false, reader: false },
          // The title role's titles, for the reader alone; their gate, for no role.
          work_time_titles: { admin: false, writer: false, reader: true },
          work_time_title_suppressed: { admin: false, writer: false, reader: true },
          work_time_title_caller: { admin: false, writer: false, reader: false },
          // An agent's anchors and time rulings, for the reader alone.
          set_anchor: { admin: false, writer: false, reader: true },
          lift_anchor: { admin: false, writer: false, reader: true },
          rule_time: { admin: false, writer: false, reader: true },
          lift_time_ruling: { admin: false, writer: false, reader: true },
          judge_time_proposal: { admin: false, writer: false, reader: true },
          time_vetoed: { admin: false, writer: false, reader: false },
          // Agent learnings: the filing and the pack's read for the reader alone, the owner's veto
          // for the admin alone.
          file_learning: { admin: false, writer: false, reader: true },
          agent_learnings_for: { admin: false, writer: false, reader: true },
          owner_retire_learning: { admin: true, writer: false, reader: false },
          // Bets: every agent's for the owner, the calling agent's own and its placing for the reader.
          bets_within: { admin: true, writer: false, reader: false },
          // Social cost tracked: each agent's questions and ISO weeks for the owner; the caller's own
          // seven days for the reader; the checks of a tried and the bets one row each, for none of the
          // three: every caller of them is a definer; the removal path's cleanup of what a question names,
          // for the admin and the writer, as taintCiting's other calls.
          agent_questions_within: { admin: true, writer: false, reader: false },
          agent_weeks_within: { admin: true, writer: false, reader: false },
          my_standing: { admin: false, writer: false, reader: true },
          tried_holds: { admin: false, writer: false, reader: false },
          bet_endings: { admin: false, writer: false, reader: false },
          forget_question_sources: { admin: true, writer: true, reader: false },
          my_bets: { admin: false, writer: false, reader: true },
          place_bet: { admin: false, writer: false, reader: true },
          // Whether a group's chat lines are newer than the caller's warmth build, for the reader alone.
          group_chat_newer: { admin: false, writer: false, reader: true },
          policy_merge: { admin: true, writer: true, reader: false },
          settled_records: { admin: false, writer: false, reader: true },
          // Who is told of an unclaimed item and when, for no role; the day's batches and whether a batch
          // notice stands for pi_notify alone; the fall-back for pi_work alone.
          ping_batch_at: { admin: false, writer: false, reader: false },
          ping_place_agents: { admin: false, writer: false, reader: false },
          ping_next_place: { admin: false, writer: false, reader: false },
          ping_clients: { admin: false, writer: false, reader: false },
          ping_walk: { admin: false, writer: false, reader: false },
          health_targets: { admin: false, writer: false, reader: false },
          roll_ping_batches: { admin: false, writer: false, reader: false },
          batch_notice_current: { admin: false, writer: false, reader: false },
          fall_back_pings: { admin: false, writer: false, reader: false },
          // The write-back and the change feed: the reader's tools.
          write_back: { admin: false, writer: false, reader: true },
          change_feed: { admin: false, writer: false, reader: true },
          changes_quick: { admin: false, writer: false, reader: true },
          signal_roles: { admin: false, writer: false, reader: true },
          // A revoked client's leases lapse, by the admin's revoke.
          lapse_client_leases: { admin: true, writer: false, reader: false },
          // The triggers that end a mark with its source and wake a message's recipient, for no role.
          signal_marks_source_gone: { admin: false, writer: false, reader: false },
          signal_marks_evidence_gone: { admin: false, writer: false, reader: false },
          signal_marks_item_tainted: { admin: false, writer: false, reader: false },
          message_wakes: { admin: false, writer: false, reader: false },
          // The default task role's trigger, for no role.
          default_task_role: { admin: false, writer: false, reader: false },
          // The notices' due-time trigger, for no role.
          notice_due_at: { admin: false, writer: false, reader: false },
          // The owner's ignored people within a clearance, for the warmth build (pi_pipeline and
          // pi_restricted) and the owner's reads of warmth.
          ignored_people_in: { admin: true, writer: false, reader: false },
          // The owner's tier rulings within a clearance, for the build and the owner's reads.
          tier_rulings_in: { admin: true, writer: false, reader: false },
          // The same under the calling client's own clearance, for the reader's warmth.
          warmth_ignored: { admin: false, writer: false, reader: true },
          warmth_rulings: { admin: false, writer: false, reader: true },
          // The value rows' and the relations' label triggers, executed by no role.
          claim_values_label: { admin: false, writer: false, reader: false },
          claim_relations_label: { admin: false, writer: false, reader: false },
          // A claim's name row's label trigger, executed by no role.
          claim_org_names_label: { admin: false, writer: false, reader: false },
          // A goal id row's label trigger, executed by no role.
          goal_ids_label: { admin: false, writer: false, reader: false },
          // A claim key's relations deleted when its last value row goes, for no role.
          claim_relations_orphaned: { admin: false, writer: false, reader: false },
          // An agent's close and its reopen, a retry's answer, for the reader;
          // the standing release for the admin; the label check's close branch for none of these;
          // what closed a commitment, for the reader and the admin.
          close_commitment: { admin: false, writer: false, reader: true },
          reopen_close: { admin: false, writer: false, reader: true },
          close_replayed: { admin: false, writer: false, reader: true },
          agent_closes_on: { admin: true, writer: false, reader: false },
          close_claim_allowed: { admin: false, writer: false, reader: false },
          commitment_closes: { admin: true, writer: false, reader: true },
          open_item_closes: { admin: true, writer: false, reader: true },
          owner_commitment_closes: { admin: true, writer: false, reader: true },
          // A source moment's handles' names, for the pipeline and the restricted worker alone,
          // none of these three.
          moment_handle_names: { admin: false, writer: false, reader: false },
          // The backfill vouch's trigger, for no role.
          lens_vouch_once: { admin: false, writer: false, reader: false },
          // An agent's goal proposal and a proposal's details, for the reader alone.
          propose_goal: { admin: false, writer: false, reader: true },
          propose_goal_target: { admin: false, writer: false, reader: true },
          // A proposed target's other forms, for that function alone.
          goal_target_forms: { admin: false, writer: false, reader: false },
          set_details: { admin: false, writer: false, reader: true },
          pay_question: { admin: false, writer: false, reader: true },
          // The caller's own rejected goal proposals, for the reader alone.
          declined_goal_proposals: { admin: false, writer: false, reader: true },
          // A belief's inputs under the caller's clearance, for the reader alone.
          belief_inputs: { admin: false, writer: false, reader: true },
          // Its body under a given clearance, for the shadow sampler (pi_pipeline) and the
          // owner's beliefs as of a time (pi_admin).
          belief_inputs_under: { admin: true, writer: false, reader: false },
          // A proposal's expectations and a move's watches, for the reader
          // alone; the watches' and links' label triggers, the close's grace, the copies' taint and
          // the entity check, for no role.
          set_expectations: { admin: false, writer: false, reader: true },
          add_watches: { admin: false, writer: false, reader: true },
          closes_work: { admin: false, writer: false, reader: false },
          work_watches_check: { admin: false, writer: false, reader: false },
          outcome_links_check: { admin: false, writer: false, reader: false },
          close_work_watches: { admin: false, writer: false, reader: false },
          taint_copied_outcome_links: { admin: false, writer: false, reader: false },
          entity_seen: { admin: false, writer: false, reader: false },
          // A work's channels, for the Pipeline alone (and the tick's
          // match_outcomes, as its owner).
          outcome_channels: { admin: false, writer: false, reader: false },
          // A link's trigger row, the outcome notice for the tick
          // (pi_work), who may hear of it, and a gone link's taint and revert, for none of these three.
          outcome_links_raise: { admin: false, writer: false, reader: false },
          outcome_notice: { admin: false, writer: false, reader: false },
          outcome_notice_due: { admin: false, writer: false, reader: false },
          outcome_links_gone: { admin: false, writer: false, reader: false },
          // A model's outcome link applied when the tick lets it act, for pi_work alone.
          apply_outcome_link: { admin: false, writer: false, reader: false },
          // A finding's typed claims, for the reader alone.
          write_typed_claims: { admin: false, writer: false, reader: true },
          // The recheck triggers and their cause, for no role.
          claims_added_rechecks: { admin: false, writer: false, reader: false },
          claims_removed_rechecks: { admin: false, writer: false, reader: false },
          claims_relabelled_rechecks: { admin: false, writer: false, reader: false },
          // The deferred trigger of a key an item's claims left, and a reopen's recheck.
          claims_left_key: { admin: false, writer: false, reader: false },
          commitment_reopens_rechecks: { admin: false, writer: false, reader: false },
          belief_rulings_rechecks: { admin: false, writer: false, reader: false },
          release_ended_wake: { admin: false, writer: false, reader: false },
          fact_rulings_rechecks: { admin: false, writer: false, reader: false },
          card_answers_rechecks: { admin: false, writer: false, reader: false },
          trigger_cause: { admin: false, writer: false, reader: false },
          // Settings and levers: an agent's change and the list, for the reader; the owner's set
          // and undo, for the admin.
          set_lever: { admin: false, writer: false, reader: true },
          levers_read: { admin: false, writer: false, reader: true },
          owner_set_lever: { admin: true, writer: false, reader: false },
          // The label of a defect the caller sees, for the store to seal a status note under.
          improvement_label: { admin: false, writer: false, reader: true },
          // The triggers that keep evidence content unchanged, executed by no role.
          evidence_blobs_fixed: { admin: false, writer: false, reader: false },
          evidence_items_fixed: { admin: false, writer: false, reader: false },
          // Wrong merges: an agent's report, for the reader; the sweep's split and its hand to the
          // owner, for the writer and the admin; the tick's gaps and a helper, for none of the
          // three.
          report_wrong_merge: { admin: false, writer: false, reader: true },
          split_wrong_merge: { admin: true, writer: true, reader: false },
          wrong_merges_to_owner: { admin: true, writer: true, reader: false },
          merge_audit_gaps: { admin: false, writer: false, reader: false },
          wrong_merge_parts: { admin: false, writer: false, reader: false },
          // Wrong relations: an agent's report, for the reader.
          report_wrong_relation: { admin: false, writer: false, reader: true },
          // Durable rulings: the anchors and what was shown, for the admin; what a deletion removes of
          // them, for the two roles that taint; the gate, for the admin (and the pipeline).
          anchor_rulings: { admin: true, writer: false, reader: false },
          set_ruling_shown: { admin: true, writer: false, reader: false },
          forget_ruling_anchors: { admin: true, writer: true, reader: false },
          // What an erasure takes of a belief ruling's own identifiers, for the admin's erasure hook.
          scrub_belief_rulings: { admin: true, writer: false, reader: false },
          carry_gate: { admin: true, writer: false, reader: false },
          // What an erasure reaches: a deletion's rule for the reports of a wrong merge, for the
          // two roles whose deletions remove a person; the scrub a deletion at the source would
          // run, for the same two, called by nothing while the owner has not ruled; a ruling_carry
          // card's candidates as its basis, for the admin's sweep.
          forget_wrong_merges: { admin: true, writer: true, reader: false },
          scrub_rulings_of_item: { admin: true, writer: true, reader: false },
          cite_claims: { admin: true, writer: false, reader: false },
          // The rule for a fact key that is gone and the same_fact cards on one, for the admin's
          // erasure; what holds a commitment's key, for the definers alone; what an expiry takes
          // of a ruling, for the writer, which runs one; a deletion's rule for the agents'
          // same-person answers, for the erasure and for a deletion at the source.
          gone_keys: { admin: true, writer: false, reader: false },
          forget_fact_cards: { admin: true, writer: false, reader: false },
          // The erased people a join's or a split's claims name, and the settlements of the claims
          // an erasure removes, for the admin's erasure.
          name_ruling_people: { admin: true, writer: false, reader: false },
          forget_fact_settlements: { admin: true, writer: false, reader: false },
          forget_commitment_keys: { admin: false, writer: false, reader: false },
          forget_ruling_shown: { admin: true, writer: true, reader: false },
          forget_identity_answers: { admin: true, writer: true, reader: false },
          // Questions through an agent: the task's card and the relay, for the reader; the list of
          // kinds, the rules, the tick's gaps and the trigger that takes a tainted card's quote,
          // for none of the three: every caller of them is a definer.
          card_relay_question: { admin: false, writer: false, reader: true },
          relay_card_answer: { admin: false, writer: false, reader: true },
          card_relay_kinds: { admin: false, writer: false, reader: false },
          card_relay_routed: { admin: false, writer: false, reader: false },
          card_raised_by: { admin: false, writer: false, reader: false },
          card_relayable: { admin: false, writer: false, reader: false },
          card_relay_gaps: { admin: false, writer: false, reader: false },
          forget_relay_quote: { admin: false, writer: false, reader: false },
          // The day's hand-over: the brief's counts for the reader; the tick's read and the
          // rules for none of the three.
          owner_queue_question: { admin: false, writer: false, reader: true },
          owner_queue_state: { admin: false, writer: false, reader: false },
          owner_queue_waits: { admin: false, writer: false, reader: false },
          owner_queue_label: { admin: false, writer: false, reader: false },
          // Dreaming: the agent's brief and settlement for the reader; the merge, its lifts and the
          // owner's reads for the admin; the erasure's lift for the admin and the writer; what the
          // pipeline and the tick call, and the copy behind the belief read, for none of the three.
          dream_finding_brief: { admin: false, writer: false, reader: true },
          settle_belief: { admin: false, writer: false, reader: true },
          dream_ruling: { admin: true, writer: false, reader: false },
          dream_lift_merges: { admin: true, writer: false, reader: false },
          dream_lift_one: { admin: false, writer: false, reader: false },
          forget_dream_merges: { admin: true, writer: true, reader: false },
          // What a deletion's dream lift would touch, counted for a dry run and the writer.
          count_dream_merges: { admin: true, writer: true, reader: false },
          census_held: { admin: true, writer: false, reader: false },
          relation_effective: { admin: true, writer: false, reader: false },
          belief_inputs_core: { admin: false, writer: false, reader: false },
          dream_identity_pairs: { admin: false, writer: false, reader: false },
          dream_goal_subjects: { admin: false, writer: false, reader: false },
          dream_finding_gaps: { admin: false, writer: false, reader: false },
          claim_relations_judged_now: { admin: false, writer: false, reader: false },
          // Session taint's count, for the reader alone.
          count_session_taint: { admin: false, writer: false, reader: true },
          // The names the pseudonymiser replaces, for pi_pipeline alone.
          known_identities: { admin: false, writer: false, reader: false },
        };
        expect(functions.sort((left, right) => (left.name < right.name ? -1 : 1))).toEqual(
          [
            // The core's, with read_allowance and a four-argument log_call beside the
            // three-argument one.
            ...[
              "append_record",
              "audiences",
              "claim_entities_label",
              "claims_label",
              "client_clearance",
              "current_client",
              "log_call",
              "log_call",
              "log_call",
              "log_pack",
              "log_read",
              "open_session",
              "read_allowance",
              "record_label",
              "withheld_items",
            ].map((name) => ({
              name,
              admin: false,
              writer: false,
              reader: !o1.includes(name),
              anyone: false,
            })),
            ...Object.entries(O4A).map(([name, can]) => ({ name, ...can, anyone: false })),
            // report_move's seven-argument wrapper beside the eight.
            { name: "report_move", admin: false, writer: false, reader: true, anyone: false },
            // set_intention's seven-argument wrapper beside the eight.
            { name: "set_intention", admin: false, writer: false, reader: true, anyone: false },
          ].sort((left, right) => (left.name < right.name ? -1 : 1)),
        );
      }));
  });
});
