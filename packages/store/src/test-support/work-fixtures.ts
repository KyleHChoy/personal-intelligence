import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DECISION_POINT_PINS, type ErasureId, type PersonalLogger } from "@intelligence/contracts/personal";
import { CARD_KINDS } from "../admin/cards/card-kinds.ts";
import { appendJournal, ensureJournal } from "../core/journal.ts";
import { createDispatch, type Dispatch } from "../work/dispatch.ts";
import { testId } from "./clients.ts";
import { one, type Query, readAs, session } from "./connections.ts";
import { fingerprint, queryAs, sealRow, type TestDatabase } from "./database.ts";
import { type LoggedCall, recordingLogger } from "./recording.ts";
import { seeder } from "./seeder.ts";
import { withDatabase } from "./store.ts";
import { interactionId } from "./values.ts";
import { insertWorkClient, type WorkClient } from "./work-clients.ts";

// A small world for the dispatcher's tests, in SQL: rows as pi_admin, the rows
// only definer functions write as pi_owner, and the tick's own as pi_work. Hand-written, with
// reserved domains only. Shared by the store's dispatch tests and pi's tick tests, which reach it
// as @intelligence/personal-store/testing.

export type Ref = [kind: string, id: string];
export type { WorkClient } from "./work-clients.ts";
export type Mail = { id: string; evidence: string };

export type MailOptions = {
  direction?: "inbound" | "outbound";
  thread?: string;
  // The extraction status row: screened and clean, withheld, skipped (not screened), or none.
  status?: "done" | "withheld" | "skipped" | "none";
  held?: boolean;
  bulk?: boolean;
  // The system sent it, or it answers one the system sent.
  system?: "originated" | "answers";
  compartments?: string[];
  // A person the message names, by an interaction row: what a veto on that person covers.
  person?: string;
};

export type EventOptions = {
  startsAt?: Date;
  response?: "accepted" | "needsAction" | "declined" | "tentative" | null;
  organized?: boolean;
  cancelled?: boolean;
  compartments?: string[];
  participant?: string;
};

export type RowOptions = {
  kind?: string;
  about?: Ref | "owner";
  refs?: Ref[];
  // A run's row (`run:<id>`, author `run`) or a client's.
  by?: "run" | WorkClient;
  compartments?: string[];
  hypothesis?: string;
  caseId?: string;
  at?: Date;
};

export type WorkWorld = {
  db: TestDatabase;
  journal: string;
  logged: LoggedCall[];
  log: PersonalLogger;
  admin<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]>;
  work<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]>;
  // One committed transaction as pi_owner.
  owner<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]>;
  mail(options?: MailOptions): Promise<Mail>;
  event(options?: EventOptions): Promise<string>;
  // A person with one address, and that address's fingerprint.
  person(compartments?: string[]): Promise<{ id: string; fp: string }>;
  // A claim of a type that builds a belief, under one compartment, as the seeder writes one.
  claim(compartment: string): Promise<string>;
  reasoner(compartments?: string[]): Promise<WorkClient>;
  agent(compartments?: string[]): Promise<WorkClient>;
  intent(
    kinds: string[],
    clients: string[],
    options?: { mode?: "policy" | "owner"; maxOpen?: number; at?: Date },
  ): Promise<string>;
  harness(client: WorkClient, kind: string, stage: string): Promise<string>;
  opportunity(options?: RowOptions): Promise<{ id: string; caseId: string }>;
  hypothesis(options?: RowOptions): Promise<{ id: string; caseId: string }>;
  intention(options: {
    kind: "remind" | "check_back";
    opportunity?: string;
    client?: WorkClient;
    dueAt: Date;
    compartments?: string[];
    caseId?: string;
  }): Promise<string>;
  // A status event on a ledger row, by `owner` unless named.
  status(
    rowKind: string,
    id: string,
    event: string,
    options?: { at?: Date; by?: string; compartments?: string[] },
  ): Promise<void>;
  latest(rowKind: string, id: string): Promise<string | null>;
  decision(
    opportunity: string,
    decision: "go" | "no_go" | "later",
    options?: { by?: "owner" | "policy"; intent?: string; at?: Date; checkBackAt?: Date },
  ): Promise<void>;
  // A card as pi_admin, with its state as its one event.
  card(options: {
    kind?: string;
    author?: string;
    target?: Ref;
    compartments?: string[];
    caseKey?: string | null;
    state?: string;
    at?: Date;
    expiresAfterDays?: number | null;
  }): Promise<string>;
  veto(subject: "person" | "any", fps: string[], workKind?: string | null): Promise<string>;
  goal(options?: {
    status?: string;
    compartments?: string[];
    decidedAt?: Date;
  }): Promise<{ goal: string; ruling: string }>;
  killSwitch(state: "on" | "off"): Promise<void>;
  settings(patch: Record<string, number>): Promise<void>;
  // An erasure the database holds and the journal records: every run attempt taken before it
  // has a moved mark.
  erasure(options?: { journal?: boolean; database?: boolean }): Promise<void>;
  // One call under a client's token, as pi_reader, in its own committed transaction.
  as<Row = Record<string, unknown>>(client: WorkClient, text: string, values?: unknown[]): Promise<Row[]>;
  // A claim of a `go` opportunity and a cleared move at its stage, through the functions.
  claimAndPlan(client: WorkClient, opportunity: string, stage: string): Promise<string>;
  // The move's report through ledger.report_move, with a sealed summary when one is given.
  report(
    client: WorkClient,
    move: string,
    outcome: "done" | "failed" | "blocked",
    summary?: string,
  ): Promise<string | null>;
  // The oldest queued run, taken by the reasoner through ledger.next_run.
  take(reasoner: WorkClient): Promise<string | null>;
  dispatch(): Dispatch;
};

const own = ["own"];

// The card kinds durable work adds, with their options only, for a tick's `raiseCard`.
// card-kinds.ts writes the real rows; a row already there is left as it is.
export const WORK_CARD_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  opportunity_decision: ["go", "no_go", "later"],
  owner_question: ["confirm", "reject", "skip"],
  outcome: ["acknowledge", "dismiss"],
  reminder: ["done", "snooze", "dismiss"],
};
export function ensureWorkCardKinds(): void {
  for (const [kind, options] of Object.entries(WORK_CARD_OPTIONS)) {
    if (!Object.hasOwn(CARD_KINDS, kind)) CARD_KINDS[kind] = { options, render: () => [], effect: async () => {} };
  }
}

const label = (compartments: string[]): string[] => [...new Set(compartments)].sort();

export async function withWorkWorld<T>(
  fn: (world: WorkWorld) => Promise<T>,
  options: { compartments?: string[] } = {},
): Promise<T> {
  ensureWorkCardKinds();
  return withDatabase(
    async (db) => {
      const folder = await mkdtemp(join(tmpdir(), "pi-work-journal-"));
      const journal = join(folder, "erasures.jsonl");
      await ensureJournal(journal);
      const dispatches: Dispatch[] = [];
      const { log, calls } = recordingLogger();
      try {
        return await session(db.urls.admin, async (adminQuery) => {
          const seed = seeder(db, adminQuery);
          const accounts = new Map<string, Awaited<ReturnType<typeof seed.sourceAccount>>>();
          // An account holds one compartment: a wider label's evidence sits on the account of its
          // first compartment.
          const accountFor = async (compartments: string[]) => {
            const key = label(compartments).slice(0, 1).join(",");
            const found = accounts.get(key) ?? (await seed.sourceAccount(label(compartments).slice(0, 1)));
            accounts.set(key, found);
            return found;
          };
          const owner = <Row>(text: string, values?: unknown[]): Promise<Row[]> =>
            session(db.urls.bootstrap, async (query: Query) => {
              await query("begin");
              await query("set local role pi_owner");
              const rows = await query<Row>(text, values);
              await query("commit");
              return rows;
            });
          let serial = 0;
          let journalSeq = 0;

          const world: WorkWorld = {
            db,
            journal,
            logged: calls,
            log,
            admin: (text, values) => adminQuery(text, values),
            work: (text, values) => queryAs(db.urls.work, text, values),
            owner,

            async mail(options = {}) {
              const compartments = label(options.compartments ?? own);
              const evidence = await seed.evidence(compartments, await accountFor(compartments));
              const id = await seed.message(compartments, evidence, { held: options.held ?? false });
              serial += 1;
              await adminQuery(
                "update knowledge.messages set direction = $2, bulk = $3, thread_fp = $4 where id = $1",
                [
                  id,
                  options.direction ?? "inbound",
                  options.bulk ?? false,
                  fingerprint(db.keys, "thread", options.thread ?? `thread-of-${serial}`),
                ],
              );
              if (options.system !== undefined) {
                await adminQuery(
                  "update vault.evidence_items set system_originated = $2, answers_system = $3 where id = $1",
                  [evidence, options.system === "originated", options.system === "answers"],
                );
              }
              const status = options.status ?? "done";
              if (status !== "none") {
                await seed.pipelineItem(compartments, evidence);
                await adminQuery(
                  "update vault.pipeline_items set waiting = false, withheld = $2, screened = $3 where evidence_id = $1",
                  [evidence, status === "withheld", status !== "skipped"],
                );
              }
              if (options.person !== undefined) {
                await adminQuery(
                  `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, compartments, readers, entity_role)
                   values ($1, $2, 'm-owner', $3, 'inbound', 'email', now(), $4, '{m-owner}', 'sender')`,
                  [interactionId(evidence, options.person), evidence, options.person, compartments],
                );
              }
              return { id, evidence };
            },

            async event(options = {}) {
              const compartments = label(options.compartments ?? own);
              const evidence = await seed.evidence(compartments, await accountFor(compartments));
              const id = testId("evt");
              const startsAt = options.startsAt ?? new Date(Date.now() + 3 * 3_600_000);
              serial += 1;
              await adminQuery(
                "insert into knowledge.events (id, event_kind, occurred_at, evidence_id, compartments, readers) values ($1, 'meeting', $2, $3, $4, '{m-owner}')",
                [id, startsAt, evidence, compartments],
              );
              await adminQuery(
                `insert into knowledge.event_details (event_id, account_id, source_event_fp, starts_at, ends_at, all_day, cancelled, owner_response, compartments, title_enc)
                 values ($1, $2, $3, $4, $5, false, $6, $7, $8, $9)`,
                [
                  id,
                  await accountFor(compartments),
                  fingerprint(db.keys, "source_id", `work-event-${serial}-${id}`),
                  startsAt,
                  new Date(startsAt.getTime() + 3_600_000),
                  options.cancelled ?? false,
                  options.response === undefined ? "accepted" : options.response,
                  compartments,
                  sealRow(
                    db.keys,
                    compartments[0] ?? "own",
                    { table: "knowledge.event_details", id, column: "title_enc" },
                    `Work event ${serial}`,
                  ),
                ],
              );
              if (options.organized === true)
                await adminQuery("update vault.evidence_items set sender_member = 'm-owner' where id = $1", [evidence]);
              if (options.participant !== undefined) {
                await adminQuery(
                  "insert into knowledge.event_participants (event_id, entity_id, participant_role, compartments) values ($1, $2, 'participant', $3)",
                  [id, options.participant, compartments],
                );
              }
              return id;
            },

            claim: (compartment) => seed.claim([compartment], undefined, "commitment"),
            async person(compartments = own) {
              const id = await seed.entity("person");
              const account = await seed.account(label(compartments), id);
              const fp = one(
                await adminQuery<{ fp: string }>("select value_fp as fp from knowledge.accounts where id = $1", [
                  account,
                ]),
              ).fp;
              return { id, fp };
            },

            async reasoner(compartments = own) {
              serial += 1;
              return insertWorkClient(db, `work-reasoner-${serial}`, compartments, { kind: "reasoner" });
            },
            async agent(compartments = own) {
              serial += 1;
              return insertWorkClient(db, `work-agent-${serial}`, compartments);
            },

            async intent(kinds, clients, options = {}) {
              const id = testId("int");
              await adminQuery(
                `insert into policy.intents (id, opportunity_kinds, client_ids, mode, max_open, confirmed_at) values ($1, $2, $3, $4, $5, $6)`,
                [
                  id,
                  kinds,
                  clients,
                  options.mode === "owner" ? "owner_decides" : "policy_decides",
                  options.maxOpen ?? 5,
                  options.at ?? new Date(),
                ],
              );
              return id;
            },
            async harness(client, kind, stage) {
              const id = testId("hrn");
              await adminQuery(
                "insert into policy.harness_modes (id, client_id, opportunity_kind, stage, mode, granted_at) values ($1, $2, $3, $4, 'act', now())",
                [id, client.id, kind, stage],
              );
              return id;
            },

            async opportunity(options = {}) {
              return row(options, "opportunity");
            },
            async hypothesis(options = {}) {
              return row({ about: "owner", ...options }, "hypothesis");
            },

            async intention(options) {
              const id = testId("itn");
              const compartments = label(options.compartments ?? own);
              const createdBy = options.client === undefined ? `run:${testId("run")}` : `client:${options.client.id}`;
              await owner(
                `insert into ledger.intentions (id, request_id, created_by, compartments, opportunity_id, case_id, kind, due_at, client_id, chain_depth)
                 values ($1, $1, $2, $3, $4, $5, $6, $7, $8, 0)`,
                [
                  id,
                  createdBy,
                  compartments,
                  options.opportunity ?? null,
                  options.caseId ?? null,
                  options.kind,
                  options.dueAt,
                  options.client?.id ?? null,
                ],
              );
              await world.status("intention", id, "set", { by: createdBy, compartments });
              return id;
            },

            async status(rowKind, id, event, options = {}) {
              const compartments = options.compartments ?? (await compartmentsOf(rowKind, id));
              await owner(
                "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ($1, $2, $3, $4, $5, ledger.label($6))",
                [rowKind, id, event, options.at ?? new Date(), options.by ?? "owner", compartments],
              );
            },
            async latest(rowKind, id) {
              return (
                (
                  await adminQuery<{ event: string }>(
                    "select event from ledger.record_events where row_kind = $1 and row_id = $2 order by id desc limit 1",
                    [rowKind, id],
                  )
                )[0]?.event ?? null
              );
            },

            async decision(opportunity, decision, options = {}) {
              const by = options.by ?? "owner";
              const at = options.at ?? new Date();
              const compartments = await compartmentsOf("opportunity", opportunity);
              await adminQuery(
                `insert into ledger.opportunity_decisions (request_id, created_at, created_by, compartments, opportunity_id, decision, decided_by, rung, reason, intent_id, check_back_at)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [
                  testId("req"),
                  at,
                  by === "owner" ? "owner" : "system:work",
                  compartments,
                  opportunity,
                  decision,
                  by,
                  by === "owner" ? 4 : 0,
                  by === "owner" ? "owner" : "intent",
                  options.intent ?? null,
                  options.checkBackAt ?? null,
                ],
              );
              await world.status("opportunity", opportunity, decision, {
                at,
                by: by === "owner" ? "owner" : "system:work",
              });
            },

            async card(options) {
              const id = testId("crd");
              const at = options.at ?? new Date();
              const compartments = label(options.compartments ?? own);
              const kind = options.kind ?? "opportunity_decision";
              await adminQuery(
                `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, expires_after_days, case_key, compartments)
                 values ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [
                  id,
                  at,
                  options.author ?? "reasoner",
                  kind,
                  options.target?.[0] ?? null,
                  options.target?.[1] ?? null,
                  [...(WORK_CARD_OPTIONS[kind] ?? ["acknowledge"])],
                  options.expiresAfterDays === undefined ? 14 : options.expiresAfterDays,
                  options.caseKey ?? null,
                  compartments,
                ],
              );
              await world.status("card", id, options.state ?? "pending", {
                at,
                by: options.author ?? "reasoner",
                compartments,
              });
              return id;
            },

            async veto(subject, fps, workKind = null) {
              const id = testId("rul");
              await adminQuery(
                "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'veto', 0, '{}', '{}', now(), '{own}')",
                [id, testId("req")],
              );
              await adminQuery(
                "insert into knowledge.vetoes (ruling_id, subject, value_fps, work_kind, created_at, compartments) values ($1, $2, $3, $4, now(), '{own}')",
                [id, subject, fps, workKind],
              );
              return id;
            },

            async goal(options = {}) {
              const goal = testId("gol");
              const ruling = testId("rul");
              const compartments = label(options.compartments ?? own);
              const at = options.decidedAt ?? new Date(Date.now() - 60_000);
              await adminQuery(
                `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, queue_depth, labels, details, decided_at, compartments)
                 values ($1, $2, 'goal_set', 'goal', $3, 0, '{}', '{}', $4, $5)`,
                [ruling, testId("req"), goal, at, compartments],
              );
              await adminQuery(
                "insert into projections.goal_state (goal_id, status, ruling_id, stated_at, updated_at, compartments) values ($1, $2, $3, $4, $4, $5)",
                [goal, options.status ?? "active", ruling, at, compartments],
              );
              return { goal, ruling };
            },

            async killSwitch(state) {
              await adminQuery(
                "insert into ledger.kill_switch (request_id, created_by, compartments, state) values ($1, 'owner', '{own}', $2)",
                [testId("req"), state],
              );
            },
            async settings(patch) {
              for (const [column, value] of Object.entries(patch)) {
                if (!/^[a-z_]+$/.test(column)) throw new Error("not a column");
                await adminQuery(`update policy.work_settings set ${column} = $1`, [value]);
              }
            },

            async erasure(options = {}) {
              journalSeq += 1;
              const id = testId("ers") as ErasureId;
              if (options.database !== false) {
                const ruling = testId("rul");
                await adminQuery(
                  "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'erase', 0, '{}', '{}', now(), '{own}')",
                  [ruling, testId("req")],
                );
                await adminQuery(
                  "insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments) values ($1, $2, 'item', $3, now(), 0, 0, 0, '{own}')",
                  [id, ruling, journalSeq],
                );
              }
              if (options.journal !== false)
                await appendJournal(journal, { seq: journalSeq, erasure: id, kind: "item", items: [], suppress: [] });
            },

            as: (client, text, values = []) => readAs(db, client.token, (query) => query(text, values)),

            async claimAndPlan(client, opportunity, stage) {
              const [claimed] = await world.as<{ until: Date | null }>(
                client,
                "select ledger.claim($1, $2, $3, $4) as until",
                [opportunity, testId("asg"), testId("req"), client.session],
              );
              if (claimed?.until == null) throw new Error("the claim was refused");
              const move = testId("mov");
              const [planned] = await world.as<{ move: string | null }>(
                client,
                "select ledger.plan_move($1, $2, $3, $4, $5, 1, $6) as move",
                [move, opportunity, stage, testId("req"), client.session, DECISION_POINT_PINS["move_clear@1"]],
              );
              if (planned?.move !== move) throw new Error("the move was refused");
              return move;
            },

            async report(client, move, outcome, summary) {
              const body =
                summary === undefined
                  ? null
                  : JSON.stringify(
                      sealRow(
                        db.keys,
                        client.compartments[0] ?? "own",
                        { table: "ledger.record_events", id: move, column: "body_enc" },
                        summary,
                      ),
                    );
              const [reported] = await world.as<{ status: string | null }>(
                client,
                "select ledger.report_move($1, $2, $3, $4, $5::jsonb, '{}', '{}') as status",
                [move, outcome, testId("req"), client.session, body],
              );
              return reported?.status ?? null;
            },

            async take(reasoner) {
              const [taken] = await world.as<{ run_id: string }>(
                reasoner,
                "select run_id from ledger.next_run($1, $2)",
                [testId("req"), reasoner.session],
              );
              return taken?.run_id ?? null;
            },

            dispatch() {
              const dispatch = createDispatch({ url: db.urls.work, log, journal });
              dispatches.push(dispatch);
              return dispatch;
            },
          };

          async function compartmentsOf(rowKind: string, id: string): Promise<string[]> {
            const table: Record<string, string> = {
              opportunity: "ledger.opportunities",
              hypothesis: "ledger.hypotheses",
              intention: "ledger.intentions",
              run: "ledger.runs",
              move: "ledger.moves",
              card: "ledger.cards",
            };
            const name = table[rowKind];
            if (name === undefined) return own;
            return (
              (await adminQuery<{ compartments: string[] }>(`select compartments from ${name} where id = $1`, [id]))[0]
                ?.compartments ?? own
            );
          }

          // A hypothesis or an opportunity as a run or a client writes one, with its case, its
          // basis and its first event, as pi_owner.
          async function row(
            options: RowOptions,
            rowKind: "opportunity" | "hypothesis",
          ): Promise<{ id: string; caseId: string }> {
            const prefix = rowKind === "opportunity" ? "opp" : "hyp";
            const id = testId(prefix);
            const compartments = label(options.compartments ?? own);
            const refs = options.refs ?? [];
            const about = options.about ?? refs[0] ?? "owner";
            const [aboutKind, aboutId] = about === "owner" ? ["owner", null] : about;
            const by = options.by ?? "run";
            let createdBy: string;
            let runId: string | null = null;
            if (by === "run") {
              runId = testId("run");
              createdBy = `run:${runId}`;
            } else createdBy = `client:${by.id}`;
            const author = by === "run" ? "run" : createdBy;
            const kind = options.kind ?? (rowKind === "opportunity" ? "meeting_prep" : "needs_preparation");
            const at = options.at ?? new Date();
            // As the functions do: one case for one kind of row, kind, thing, author and label, and
            // for an opportunity the hypothesis it rests on.
            const rests = rowKind === "opportunity" ? (options.hypothesis ?? null) : null;
            const found = (
              await adminQuery<{ id: string }>(
                `select id from ledger.cases where row_kind = $1 and kind = $2 and about_kind = $3 and about_id is not distinct from $4 and author = $5 and compartments = $6
                   and hypothesis_id is not distinct from $7`,
                [rowKind, kind, aboutKind, aboutId, author, compartments, rests],
              )
            )[0]?.id;
            const caseId = options.caseId ?? found ?? testId("cas");
            if (options.caseId === undefined && found === undefined) {
              await owner(
                `insert into ledger.cases (id, request_id, created_at, created_by, run_id, compartments, row_kind, kind, about_kind, about_id, author, hypothesis_id)
                 values ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [caseId, at, createdBy, runId, compartments, rowKind, kind, aboutKind, aboutId, author, rests],
              );
            }
            if (rowKind === "opportunity") {
              await owner(
                `insert into ledger.opportunities (id, request_id, created_at, created_by, run_id, compartments, case_id, kind, hypothesis_id, about_kind, about_id, proposed_by_class)
                 values ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [
                  id,
                  at,
                  createdBy,
                  runId,
                  compartments,
                  caseId,
                  kind,
                  options.hypothesis ?? null,
                  aboutKind,
                  aboutId,
                  by === "run" ? "run" : "client",
                ],
              );
            } else {
              await owner(
                `insert into ledger.hypotheses (id, request_id, created_at, created_by, run_id, compartments, case_id, kind, about_kind, about_id, about_owner)
                 values ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [id, at, createdBy, runId, compartments, caseId, kind, aboutKind, aboutId, aboutKind === "owner"],
              );
            }
            if (refs.length > 0) {
              const [added] = await owner<{ ok: boolean }>("select ledger.add_basis($1, $2, $3, $4, $5, null) as ok", [
                rowKind,
                id,
                compartments,
                refs.map((ref) => ref[0]),
                refs.map((ref) => ref[1]),
              ]);
              if (added?.ok !== true) throw new Error("a ref did not resolve");
            }
            await world.status(rowKind, id, rowKind === "opportunity" ? "proposed" : "open", {
              at,
              by: createdBy,
              compartments,
            });
            return { id, caseId };
          }

          return await fn(world);
        });
      } finally {
        for (const dispatch of dispatches) await dispatch.close().catch(() => {});
        await rm(folder, { recursive: true, force: true });
      }
    },
    { compartments: options.compartments ?? ["own", "employer:example"] },
  );
}
