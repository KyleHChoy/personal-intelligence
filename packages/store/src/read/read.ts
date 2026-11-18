import {
  type CallOptions,
  type ClientView,
  CodedError,
  type ContextArgs,
  type ContextView,
  type FindMessagesArgs,
  type GetSelfArgs,
  MIRROR_TEMPLATES,
  type MirrorPage,
  type MirrorTemplate,
  NextMoveKind,
  type NextMoves,
  type NotBuiltArgs,
  type NotBuiltResult,
  type PersonalLogger,
  type PersonalReads,
  PersonalReadTool,
  type PersonalTool,
  type PersonalWrites,
  type PushCaptureAck,
  type PushCaptureArgs,
  READ_BUDGET,
  RESEARCH_TOOL_VIEW,
  type ReadOutcome,
  type RefusalOptions,
  type ResearchAnswer,
  ResearchArgs,
  type SelfView,
  type SessionTaintEntry,
  type SessionTaintLedger,
  type SyncMirrorArgs,
  TOOL_VIEW,
} from "@intelligence/contracts/personal";
import { systemNow } from "@intelligence/personal-core";
import type { WorkRequest, WorkViews } from "@intelligence/personal-core/lens";
import type pg from "pg";
import type { Refused } from "../agent-writes/propose.ts";
import { endOwnPool, ownPool } from "../core/db.ts";
import { erasureLevel } from "../core/journal.ts";
import { KeyFileRefused, type Keys } from "../core/keys.ts";
import { TAINT_SHARED } from "../core/locks.ts";
import { Unavailable } from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";
import { Sessions } from "../core/sessions.ts";
import { workViews } from "../core/work-time-read.ts";
import { CAPTURE_CEILING_BYTES, pushCapture } from "../lens/capture-push.ts";
import { MIRROR_PASS_SECONDS, MIRROR_REBUILD_HOURS, syncMirror } from "../lens/mirror-sync.ts";
import { SYNC_MEMORY_TOOL } from "../memory/memory-sync.ts";
import { supportsOf } from "./computed-beliefs.ts";
import { OAuthStore } from "./oauth.ts";
import { ABOUT_TOOL } from "./read-about.ts";
import { GET_COMMITMENTS_TOOL } from "./read-beliefs.ts";
import { GET_ENTITY_TOOL } from "./read-card.ts";
import { GET_CHANGES_TOOL } from "./read-changes.ts";
import { GET_BELIEFS_TOOL } from "./read-compiled.ts";
import { CONTEXT_TOOL } from "./read-context.ts";
import {
  type CallShape,
  type ClientCall,
  type ClientPath,
  type GateTool,
  type GateWork,
  type Served,
  toolCall,
  whyOf,
  withClient,
} from "./read-db.ts";
import { FIND_DOCUMENTS_TOOL, GET_DOCUMENT_TOOL } from "./read-documents.ts";
import { GET_EVIDENCE_SPAN_TOOL } from "./read-evidence.ts";
import { FIND_FACTS_TOOL } from "./read-facts.ts";
import { LIST_GOALS_TOOL } from "./read-goals.ts";
import { LIST_PEOPLE_TOOL } from "./read-list-people.ts";
import { FIND_MESSAGES_TOOL, READ_MESSAGE_TOOL } from "./read-messages.ts";
import { GET_OPEN_ITEMS_TOOL } from "./read-open-items.ts";
import { BUILD_CONTEXT_PACK_TOOL } from "./read-packs.ts";
import { FIND_PATHS_TOOL } from "./read-paths.ts";
import { allowed } from "./read-quota.ts";
import { RECORD_READS_TOOL } from "./read-record-reads.ts";
import { FIND_RECORDS_TOOL, READ_RECORD_TOOL } from "./read-records.ts";
import { fileResearch } from "./read-research.ts";
import { countSessionTaint } from "./read-session-taint.ts";
import { GET_SUGGESTIONS_TOOL } from "./read-suggestions.ts";
import { FETCH_TEMPLATE_TOOL } from "./read-templates.ts";
import { READ_ITEM_TOOL } from "./read-thread.ts";
import { SEARCH_TOOL } from "./read-tools.ts";
import { GET_SELF_TOOL } from "./read-tools-self.ts";
import { GET_TIMELINE_TOOL } from "./read-tools-timeline.ts";
import { isWriteTool, WRITE_TOOLS, type WriteTool } from "./write-tools.ts";

// The reader, run as pi_reader.
// It uses only pool.connect(), client.query(text, values) and client.release(). The token and
// every other value is a bind parameter. It reads `knowledge` only, and only through the row
// policies: what the token is not cleared for is never returned to this process.

type ReaderOptions = {
  pool: pg.Pool;
  keys: Keys | (() => Promise<Keys>);
  log: PersonalLogger;
  now?: () => Date;
  journal?: string;
  captureCeilingBytes?: number;
  boxHost?: string;
  mirrorTemplates?: readonly MirrorTemplate[];
  mirrorPassSeconds?: number;
  mirrorRebuildHours?: number;
};

export class Reader implements PersonalReads, PersonalWrites, SessionTaintLedger {
  readonly #pool: pg.Pool;
  // Asked before each call: the keys given, or a source of them (reloadingKeys), since `pi http`
  // outlives the clients it serves.
  readonly #keys: () => Promise<Keys>;
  readonly #log: PersonalLogger;
  readonly #now: () => Date;
  // A test's pinned clock, set on read contexts so computed answers use it; a deployed reader has
  // none, so computed answers use the database transaction's clock.
  readonly #pinned: { now?: () => Date };
  readonly #journal: string | undefined;
  // Whether this reader has seen the database level with the journal.
  // Until it has, every call asks first, so a reader that started while the database could not be
  // reached reads nothing before the erasures made since a restore are applied.
  #level = false;
  // The remembered session of each client this reader serves.
  readonly sessions = new Sessions();
  readonly #path: Omit<ClientPath, "keys">;
  // The OAuth port of `pi http`, on the same pool and under no token.
  readonly oauth: OAuthStore;
  // Lens's storage ceiling: at or over it, push_capture refuses every
  // capture item `ceiling`. `pi http` passes PI_CAPTURE_STORAGE_CEILING_BYTES.
  readonly captureCeilingBytes: number;
  // The box's own host, which push_capture's default never admits, from
  // `pi http`'s PI_HTTP_BASE_URL; with none, push_capture admits nothing by default.
  readonly boxHost: string | undefined;
  // Lens's mirror: the template versions this reader serves, and
  // `pi http`'s PI_MIRROR_PASS_SECONDS and PI_MIRROR_REBUILD_HOURS.
  readonly #mirror: { templates: readonly MirrorTemplate[]; passSeconds: number; rebuildHours: number };

  // The caller owns this pool and ends it; close() ends only a pool createReader made.
  // `journal` is the erasure journal's path, for erasureLevel.
  constructor(options: ReaderOptions) {
    this.#pool = options.pool;
    const { keys } = options;
    this.#keys = typeof keys === "function" ? keys : () => Promise.resolve(keys);
    this.#log = options.log;
    this.#now = options.now ?? systemNow;
    this.#pinned = options.now === undefined ? {} : { now: options.now };
    this.#journal = options.journal;
    this.captureCeilingBytes = options.captureCeilingBytes ?? CAPTURE_CEILING_BYTES;
    this.boxHost = options.boxHost;
    this.#mirror = {
      templates: options.mirrorTemplates ?? MIRROR_TEMPLATES,
      passSeconds: options.mirrorPassSeconds ?? MIRROR_PASS_SECONDS,
      rebuildHours: options.mirrorRebuildHours ?? MIRROR_REBUILD_HOURS,
    };
    this.oauth = new OAuthStore(this.#pool);
    this.#path = {
      pool: this.#pool,
      log: this.#log,
      sessions: this.sessions,
      // A deployed reader computes as of the database's clock; only a reader given a clock (a
      // test's pinned world date) gives it to its calls.
      ...(options.now === undefined ? {} : { now: options.now }),
      first: async (run) => {
        if (this.#journal === undefined || this.#level) return;
        const journal = this.#journal;
        const level = await erasureLevel(run, journal, { markForm: true }).catch(() => "refused" as const);
        if (level !== "level") throw new Unavailable();
        this.#level = true;
      },
    };
  }

  // The database's journal mark against the journal's last sequence
  // number, asked under no token. The file is the journal whole or its mark alone
  // (journalMarkText), which is what the agent API's user holds. Throws `journal_refused` for a journal that is refused, and a
  // plain Error for a reader made without the journal's path. A reader made with the path also asks
  // it once before its first call that reaches the database, and answers `unavailable` while it is
  // behind.
  async erasureLevel(): Promise<"level" | "behind"> {
    if (this.#journal === undefined) throw new Error("the reader was made without the journal's path");
    const level = await erasureLevel(
      async (text, values) => (await this.#pool.query(text, values)).rows,
      this.#journal,
      { markForm: true },
    );
    if (level === "level") this.#level = true;
    return level;
  }

  #failed(): void {
    this.#log.error({ event: "read_failed", code: "unavailable" });
  }

  // The one call path: one transaction under one
  // token, bound to this reader's pool, keys and sessions, with its erasure check first. Work
  // runs every call through it, so the guarded token statement, the session and the logs exist
  // once. Throws Unavailable for a database error or a value that does not open.
  // With a signal, an abort cancels the call's statement and rolls it back (read-db.ts).
  // Its keys first: a key source that fails answers Unavailable and sends nothing.
  async withClient<T>(token: string, options: CallShape, fn: (call: ClientCall) => Promise<T>): Promise<T> {
    if (options.signal?.aborted === true) throw new Unavailable();
    const keys = await this.#keys().catch((error: unknown) => {
      this.#log.error({
        event: "keys_reload_failed",
        code: error instanceof KeyFileRefused ? error.code : "unreadable",
      });
      throw new Unavailable();
    });
    return withClient({ ...this.#path, keys }, token, options, fn);
  }

  // The gate (read-db.ts) under this reader's read_failed event.
  tool<A, T>(token: string, shape: CallShape, tool: GateTool<A, T>, work: GateWork<A, T>): Promise<ReadOutcome<T>> {
    return toolCall(this, () => this.#failed(), token, shape, tool, work);
  }

  // One read tool's call, past the gate: its budget, its work, its read log. The work (read-tool.ts)
  // is given the client, and may refuse a call not_permitted (a pack's purpose's view) before it
  // reads, or invalid_request for a visible row the tool does not take (fetch_template's document
  // that is not a reference document).
  #read<A, T>(
    { tool, parse, work, isolation }: ReadTool<A, T>,
    token: string,
    input: unknown,
    { why, ...options }: RefusalOptions = {},
  ): Promise<ReadOutcome<T>> {
    return this.tool(
      token,
      {
        // sync_memory's alone: read committed, so that every
        // statement after the shared taint lock sees every deletion that committed before it, where a
        // repeatable-read snapshot would be taken before the lock was granted.
        ...(isolation === "under_taint"
          ? { isolation: "read committed" as const, lock: TAINT_SHARED }
          : { isolation: isolation === "committed" ? ("read committed" as const) : ("repeatable read" as const) }),
        signal: options.signal,
      },
      {
        name: tool,
        view: TOOL_VIEW[tool],
        parse: () => parse(input),
        why: (outcome) => whyOf(outcome, why),
      },
      async ({ client, run, ctx: ctxOf, logRead }, args): Promise<Served<T>> => {
        // The client's read budgets: checked before the work's first statement.
        // A spent one opens no session and logs no read, and its refusal names the window spent.
        const budget = await allowed(run, tool);
        if (budget !== "ok") return { outcome: { ok: false, code: "rate_limited", refusal: budget }, rows: 0 };
        // The call is given the keys of its client's compartments and no other.
        const ctx = { ...ctxOf(client), ...this.#pinned };
        const answer = await work(ctx, args, client, { now: this.#now });
        // A subject no one visible matches is not_found, told by its refusal.
        if (answer === "subject_unknown")
          return { outcome: { ok: false, code: "not_found", refusal: "subject_unknown" }, rows: 0 };
        if (typeof answer === "string") return { outcome: { ok: false, code: answer }, rows: 0 };
        if (answer === null) return { outcome: { ok: false, code: "not_found" }, rows: 0 };
        // The code points a text tool served, logged with its ok call. A text
        // tool that does not say them fails closed, so none can pass the budget unseen.
        if (READ_BUDGET[tool] === "text" && answer.chars === undefined) throw new Unavailable();
        // What an ok call returned by id, after the tool's last query and before its call log
        // row. No tool logs for itself.
        await logRead(ctx, tool, answer.read);
        return {
          outcome: { ok: true, value: answer.value },
          rows: answer.rows,
          chars: READ_BUDGET[tool] === "text" ? answer.chars : undefined,
        };
      },
    );
  }

  // One read tool as a method of the port.
  #readTool<A, T>(tool: ReadTool<A, T>) {
    return (token: string, args: A, options?: RefusalOptions): Promise<ReadOutcome<T>> =>
      this.#read(tool, token, args, options);
  }

  // One write tool on record's path as a method of the port.
  #writeTool<A, T>(row: WriteTool<A, T>) {
    return (token: string, args: A, options?: RefusalOptions): Promise<ReadOutcome<T>> =>
      this.#write(row, token, () => row.parse(args), options);
  }

  // Session taint's counts (read-session-taint.ts): one more of the caller's refusals or
  // would-refusals for a session's label.
  countSessionTaint(token: string, entry: SessionTaintEntry, options?: CallOptions): Promise<void> {
    return countSessionTaint(this, token, entry, options);
  }

  // Exactly the five fields of ClientView, or null. It writes no policy.calls row. A database
  // error is logged and thrown as a plain Error with code "unavailable".
  async client(token: string, options: CallOptions = {}): Promise<ClientView | null> {
    try {
      return await this.withClient(token, { isolation: "repeatable read", signal: options.signal }, ({ client }) =>
        Promise.resolve(client),
      );
    } catch (error) {
      if (!(error instanceof Unavailable)) throw error;
      this.#failed();
      throw new CodedError("unavailable");
    }
  }

  // Work time: every work view of a request, under the token, as the
  // tools' reads compute them, for the store's own tests and checks. It serves no client and logs
  // no tool call or read: a tool that serves these views calls workViews inside its own call, so
  // what they read joins that call's read log. Null for a token with no current client.
  async workViews(token: string, request: WorkRequest, options: CallOptions = {}): Promise<WorkViews | null> {
    return this.withClient(token, { isolation: "repeatable read", signal: options.signal }, ({ client, ctx }) =>
      client === null
        ? Promise.resolve(null)
        : workViews({ ...ctx(client), ...this.#pinned }, request, this.#now(), [], undefined, supportsOf(ctx(client))),
    );
  }

  async getSelf(token: string, args: GetSelfArgs = {}, options?: CallOptions): Promise<ReadOutcome<SelfView>> {
    const outcome = await this.#read(GET_SELF_TOOL, token, args, options);
    if (outcome.ok) this.#logNext(outcome.value.next);
    return outcome;
  }

  // The next moves served, by kind, in counts: their measure of use.
  #logNext(next: NextMoves | undefined): void {
    if (next === undefined) return;
    const counts = {
      ...Object.fromEntries(
        NextMoveKind.options.map((kind) => [kind, next.moves.filter((one) => one.kind === kind).length]),
      ),
      replies_asking: next.moves.filter((one) => one.asks === true).length,
      replies_looked_at: next.moves.filter((one) => one.task !== undefined).length,
      meetings_moving: next.moves.filter((one) => one.moving === true).length,
      meetings_recurring: next.moves.filter((one) => one.recurring === true).length,
    };
    this.#log.info({ event: "next_moves_served", counts });
  }

  readonly search = this.#readTool(SEARCH_TOOL);
  readonly getEntity = this.#readTool(GET_ENTITY_TOOL);
  readonly getTimeline = this.#readTool(GET_TIMELINE_TOOL);
  // Its parse reads a sender into more than the port takes.
  readonly findMessages = (token: string, args: FindMessagesArgs, options?: RefusalOptions) =>
    this.#read(FIND_MESSAGES_TOOL, token, args, options);
  readonly readMessage = this.#readTool(READ_MESSAGE_TOOL);
  readonly findFacts = this.#readTool(FIND_FACTS_TOOL);
  readonly buildContextPack = this.#readTool(BUILD_CONTEXT_PACK_TOOL);
  readonly syncMemory = this.#readTool(SYNC_MEMORY_TOOL);
  readonly getCommitments = this.#readTool(GET_COMMITMENTS_TOOL);
  readonly findDocuments = this.#readTool(FIND_DOCUMENTS_TOOL);
  readonly getDocument = this.#readTool(GET_DOCUMENT_TOOL);
  readonly findPaths = this.#readTool(FIND_PATHS_TOOL);
  readonly getEvidenceSpan = this.#readTool(GET_EVIDENCE_SPAN_TOOL);
  readonly readItem = this.#readTool(READ_ITEM_TOOL);
  readonly getBeliefs = this.#readTool(GET_BELIEFS_TOOL);
  readonly listGoals = this.#readTool(LIST_GOALS_TOOL);
  readonly recordReads = this.#readTool(RECORD_READS_TOOL);
  readonly readRecord = this.#readTool(READ_RECORD_TOOL);
  readonly findRecords = this.#readTool(FIND_RECORDS_TOOL);
  readonly getOpenItems = this.#readTool(GET_OPEN_ITEMS_TOOL);
  readonly getChanges = this.#readTool(GET_CHANGES_TOOL);
  readonly listPeople = this.#readTool(LIST_PEOPLE_TOOL);
  readonly about = this.#readTool(ABOUT_TOOL);
  readonly fetchTemplate = this.#readTool(FETCH_TEMPLATE_TOOL);
  readonly getSuggestions = this.#readTool(GET_SUGGESTIONS_TOOL);

  async context(token: string, args: ContextArgs, options?: CallOptions): Promise<ReadOutcome<ContextView>> {
    const outcome = await this.#read(CONTEXT_TOOL, token, args, options);
    if (outcome.ok) this.#logNext(outcome.value.next);
    return outcome;
  }

  // Lens's mirror: mirror-sync.ts's.
  syncMirror(token: string, args: SyncMirrorArgs, options?: CallOptions): Promise<ReadOutcome<MirrorPage>> {
    return syncMirror(this, token, args, options, { ...this.#mirror, now: this.#now, log: this.#log });
  }

  getDecisionHistory(_token: string, _args: NotBuiltArgs): Promise<ReadOutcome<NotBuiltResult>> {
    return this.#stub();
  }

  #stub(): Promise<ReadOutcome<never>> {
    this.#failed();
    return Promise.resolve({ ok: false, code: "unavailable" });
  }

  // The tools on record's path (write-tools.ts), each its catalogue row.
  readonly record = this.#writeTool(WRITE_TOOLS.record);
  readonly proposeAboutYou = this.#writeTool(WRITE_TOOLS.propose_about_you);
  readonly proposePerson = this.#writeTool(WRITE_TOOLS.propose_person);
  readonly answerOwnerQuestion = this.#writeTool(WRITE_TOOLS.answer_owner_question);
  readonly closeCommitment = this.#writeTool(WRITE_TOOLS.close_commitment);
  readonly reopenCommitment = this.#writeTool(WRITE_TOOLS.reopen_commitment);
  readonly importMemory = this.#writeTool(WRITE_TOOLS.import_memory);

  // Lens's push_capture: capture-push.ts's.
  pushCapture(token: string, args: PushCaptureArgs, options?: CallOptions): Promise<ReadOutcome<PushCaptureAck>> {
    return pushCapture(this, token, args, options);
  }

  // request_research: read committed, the shared taint lock
  // first, as an agent-lane write; the token and the client; the tool and its view; the
  // arguments; then the filing (read-research.ts) and its one call row. It writes no read log
  // row: nothing it reads is returned to the client.
  fileResearch(token: string, args: ResearchArgs, options: CallOptions = {}): Promise<ReadOutcome<ResearchAnswer>> {
    return this.tool(
      token,
      { isolation: "read committed", lock: TAINT_SHARED, signal: options.signal },
      {
        name: "request_research",
        view: RESEARCH_TOOL_VIEW.request_research,
        parse: () => parsed(ResearchArgs.safeParse(args)),
      },
      async ({ client, ctx }, valid) => {
        const outcome = await fileResearch({ ...ctx(client), ...this.#pinned }, client, valid);
        return { outcome, rows: outcome.ok ? 1 : 0 };
      },
    );
  }

  // A call the agent API refused before any read: its one policy.calls row,
  // with no rows returned, and nothing else. The caller names no code. The call takes the same
  // path as a tool call whose arguments do not parse, so the code is this reader's own, decided
  // from the client it has just read: not_permitted for a tool or view the client lacks, and
  // invalid_request otherwise. Nothing in `knowledge` is read: the work is never reached.
  // For record it checks the registration only, with no view. A tool whose name the call log does
  // not take answers as a stub does: unavailable, with one read_failed event and no statement.
  // push_capture takes its own call path (capture-push.ts) with no arguments, so its refusal is
  // decided and recorded there.
  refused(token: string, tool: PersonalTool, options?: RefusalOptions): Promise<ReadOutcome<never>> {
    if (tool === "push_capture")
      return pushCapture(this, token, null, options).then((outcome) =>
        outcome.ok ? { ok: false, code: "unavailable" } : outcome,
      );
    if (isWriteTool(tool))
      return this.#write<never, never>(
        { tool, view: WRITE_TOOLS[tool].view, work: noWork },
        token,
        () => null,
        options,
      );
    const read = PersonalReadTool.safeParse(tool);
    if (!read.success) return this.#stub();
    return this.#read<never, never>({ tool: read.data, parse: () => null, work: noWork }, token, undefined, options);
  }

  // Record's path: one read committed transaction that takes the shared taint lock first, so that the append checks the vault after every deletion that
  // committed before it, and none commits while it runs. A refusal by the claim checks is an
  // invalid_request with its fixed code, recorded as one; nothing is written.
  #write<A, T>(
    { tool, view, work }: Omit<WriteTool<A, T>, "parse">,
    token: string,
    parse: () => A | Refused | null,
    { why, ...options }: RefusalOptions = {},
  ): Promise<ReadOutcome<T>> {
    return this.tool(
      token,
      { isolation: "read committed", lock: TAINT_SHARED, signal: options.signal },
      { name: tool, view, parse, why: (outcome) => whyOf(outcome, why) },
      async ({ client, ctx }, args): Promise<Served<T>> =>
        isRefused(args)
          ? { outcome: { ok: false, code: "invalid_request", refusal: args.refusal }, rows: 0 }
          : await work({ ...ctx(client), ...this.#pinned }, args),
    );
  }

  // Ends the pool createReader made, once. A pool the caller made is the caller's to end.
  close(): Promise<void> {
    return endOwnPool(this.#pool);
  }
}

// The claim checks' refusal, told apart from parsed arguments, none of whose strict
// shapes has a `refusal`.
const isRefused = (value: unknown): value is Refused =>
  typeof value === "object" && value !== null && Object.hasOwn(value, "refusal");

// The work of a refused call, whose arguments never parse: there is no value to call it with.
const noWork = (_ctx: unknown, args: never): never => args;

// Every reader call ends within its tool's deadline (four multiples, a few seconds at most), so a
// reader session idle inside a transaction for a minute belongs to a client that is gone; the
// server ends it and frees its locks, which every later call would otherwise wait on.
export const READER_IDLE_IN_TRANSACTION_MS = 60_000;
// Makes its own pool from url; the reader's close() ends it. A URL that does not parse is
// refused with a plain Error, code "bad_url", that holds no part of it.
export function createReader({ url, ...options }: { url: string } & Omit<ReaderOptions, "pool">): Reader {
  const pool = ownPool(url, 4, options.log, { idleInTransactionMs: READER_IDLE_IN_TRANSACTION_MS });
  return new Reader({ ...options, pool });
}
