import { GateCheckKind } from "@intelligence/contracts";
import {
  ClaimRecord,
  CodedError,
  type ContactCandidate,
  DECISION_POINT_PINS,
  type DraftStatus,
  type GateFacts,
  type GateOutcome,
  ownLabel,
  type PersonalLogger,
  type RevealedClaim,
  type RevealedContact,
  SendPayload,
  type SendResult,
  type SendStatus,
} from "@intelligence/contracts/personal";
import { gmailItemId } from "@intelligence/personal-core";
import { revealedClaims, revealedContacts, sendGate } from "@intelligence/personal-core/outbound";
import { draftValues } from "../agent-writes/draft-values.ts";
import { byText, type Query, stamp, stampOrNull } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId, randomToken } from "../core/ids.ts";
import { createDb, type Db } from "../core/job-db.ts";
import { erasureLevel } from "../core/journal.ts";
import type { Keys } from "../core/keys.ts";
import { addressAt, open, type Sealed, sealRow, secretAt } from "../core/seal.ts";
import { KILL_SWITCH_STATE, latestRow } from "../core/statements.ts";
import { opened } from "../core/tx.ts";
import {
  CONTACT_CANDIDATES,
  type ContactCandidateRow,
  contactRef,
  openContactCandidate,
} from "../identity/contact-candidates.ts";

// The object behind `pi send`, as `pi_proxy`: the only role that can read a send secret or begin a
// send. Every call runs in one transaction that first refuses any session but `pi_proxy`'s. It
// opens only what its keys hold: a draft whose label names a compartment they lack is
// `label_not_held`, and a disclosure candidate under one is left out of the check, unopened, and
// counted. Nothing here logs a value: ids and codes only.
type SenderOptions = { url: string; keys: Keys; log: PersonalLogger; journal?: string; now?: () => Date };

type ListedDraft = {
  id: string;
  status: "made" | "held";
  failed: GateCheckKind[];
  tainted: boolean;
  createdAt: string;
};
type ListedSend = {
  id: string;
  draft: string;
  status: SendStatus;
  stale: boolean;
  copyStored: boolean;
  copyMissing: boolean;
  begunAt: string;
};

// A claim the draft is held for: its id, its tie, and for a text value the value itself. A
// candidate that would not open is held with tie `unopened`: it is never released.
type HeldClaim = { id: string; tie: RevealedClaim["tie"] | "unopened"; value: string | null };

// A contact that would not open is held with field `unopened`: never released.
type HeldField = { id: string; field: RevealedContact["field"] | "unopened"; index: number | null };

// `label` is the account's, whose send secret sends it; `from` its stored address.
export type Checked = { payload: SendPayload; from: string; fp: string; label: string };

export type DraftView = Checked & {
  draft: string;
  firstContacts: string[];
  newThread: boolean;
  flags: ("--first-contact" | "--new-thread")[];
  basis: { kind: string; id: string }[];
  counts: GateFacts["basis"];
  outcome: GateOutcome;
  held: HeldClaim[];
  heldFields: HeldField[];
  leftOut: number;
  revealCode: string | null;
  code: string;
};

export type GateAnswer =
  | { cleared: false; outcome: GateOutcome; facts: unknown }
  | {
      cleared: true;
      outcome: GateOutcome;
      facts: unknown;
      decision: string;
      released: string[];
      firstContact: boolean;
      newThread: boolean;
    };

type SendStatusView = {
  labels: { label: string; connectedAt: string; orphaned: boolean }[];
  accounts: { label: string; lastSyncAt: string | null; lastOutcome: string | null }[];
  killSwitch: "on" | "off";
  lastSend: { id: string; status: SendStatus; begunAt: string } | null;
  counts: { made: number; held: number; unknown: number; stale: number; copyMissing: number };
};

type DraftRow = {
  id: string;
  compartments: string[];
  source_account_id: string;
  recipient_fps: string[];
  recipient_domain_fps: string[];
  payload_fp: string;
  body_fp: string;
  body_enc: Sealed | null;
};

type Candidate = { claim_id: string; compartments: string[]; content_enc: Sealed; cited_item: boolean };

type Held = {
  held: HeldClaim[];
  heldFields: HeldField[];
  leftOut: number;
  revealedAfter: (released: string[]) => number;
};

const SECRET_PREFIX = "google-send/";
const secretName = (label: string): string => `${SECRET_PREFIX}${label}`;

const requestId = (): string => randomToken(12);

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export class Sender {
  readonly #db: Db;
  readonly #keys: Keys;
  readonly #journal: string | undefined;

  private constructor(db: Db, keys: Keys, journal: string | undefined) {
    this.#db = db;
    this.#keys = keys;
    this.#journal = journal;
  }

  static create({ url, keys, log, journal }: SenderOptions): Sender {
    return new Sender(createDb(url, log), keys, journal);
  }

  // One transaction, refused unless the role that logged in is pi_proxy: `set role` cannot
  // change `session_user`.
  #transaction<T>(fn: (query: Query) => Promise<T>): Promise<T> {
    return this.#db.transaction(async (query) => {
      const [row] = await query<{ who: string }>("select session_user::text as who");
      if (row?.who !== "pi_proxy") throw new CodedError("wrong_role");
      return fn(query);
    });
  }

  close(): Promise<void> {
    return this.#db.close();
  }

  erasureLevel(): Promise<"level" | "behind"> {
    const journal = this.#journal;
    if (journal === undefined) return Promise.reject(new Error("the sender was made without the journal's path"));
    return this.#transaction((query) => erasureLevel(query, journal));
  }

  // Drafts that wait or are held, with the checks that failed when a held one was made; sends
  // the owner has to look at. Ids, statuses, check names and times only.
  list(): Promise<{ drafts: ListedDraft[]; sends: ListedSend[] }> {
    return this.#transaction(async (query) => {
      const drafts = await query<{
        id: string;
        status: "made" | "held";
        failed: GateCheckKind[];
        tainted: boolean;
        created_at: Date;
      }>(
        `select d.id, e.event as status, d.tainted_at is not null as tainted, d.created_at,
           coalesce((select array_agg(g.kind order by g.kind) from ledger.gate_checks g
                     where g.draft_id = d.id and g.phase = 'draft' and not g.passed), '{}') as failed
         from ledger.drafts d
         cross join lateral (${latestRow("event", "draft", "d.id", { alias: "" })}) e
         where e.event in ('made', 'held')
         order by d.created_at, d.id`,
      );
      const sends = (await this.#sends(query)).filter(
        (send) => send.status === "unknown" || send.stale || send.copyMissing,
      );
      return {
        drafts: drafts.map((row) => ({
          id: row.id,
          status: row.status,
          failed: row.failed,
          tainted: row.tainted,
          createdAt: stamp(row.created_at),
        })),
        sends,
      };
    });
  }

  // Every send with its state. A missing copy the owner settled is not told apart here: the settle
  // is a decision, which pi_proxy cannot read, and `gate_facts` reads it.
  async #sends(query: Query): Promise<ListedSend[]> {
    const rows = await query<{
      id: string;
      draft_id: string;
      status: SendStatus;
      stale: boolean;
      copy_stored: boolean;
      copy_missing: boolean;
      begun_at: Date;
    }>(
      `select s.id, s.draft_id, e.event as status, s.begun_at,
         (e.event = 'sending' and s.begun_at < now() - interval '2 minutes') as stale,
         exists (select 1 from vault.evidence_items v where v.sent_id = s.id) as copy_stored,
         (e.event = 'sent' and s.sent_at is not null and s.source_item_fp is not null and s.sent_at < now() - interval '30 minutes' and s.sent_at >= now() - interval '24 hours'
          and not exists (select 1 from vault.evidence_items v where v.sent_id = s.id)) as copy_missing
       from ledger.sent_messages s
       cross join lateral (${latestRow("event", "send", "s.id", { alias: "" })}) e
       order by s.begun_at, s.id`,
    );
    return rows.map((row) => ({
      id: row.id,
      draft: row.draft_id,
      status: row.status,
      stale: row.stale,
      copyStored: row.copy_stored,
      copyMissing: row.copy_missing,
      begunAt: stamp(row.begun_at),
    }));
  }

  // A send's step 1 of 9: the draft opened under its label's keys, parsed, and its four values made
  // again. A label the keys do not hold all of is `label_not_held`, before anything is opened.
  check(draft: string): Promise<Checked> {
    return this.#transaction(async (query) => (await this.#check(query, draft)).checked);
  }

  async #draft(query: Query, draft: string): Promise<DraftRow> {
    const [row] = await query<DraftRow>(
      "select id, compartments, source_account_id, recipient_fps, recipient_domain_fps, payload_fp, body_fp, body_enc from ledger.drafts where id = $1",
      [draft],
    );
    if (row === undefined) throw new CodedError("not_found");
    if (!row.compartments.every((compartment) => this.#keys.compartments.has(compartment)))
      throw new CodedError("label_not_held");
    return row;
  }

  async #check(query: Query, draft: string): Promise<{ checked: Checked; row: DraftRow }> {
    const row = await this.#draft(query, draft);
    const mismatch = (): Error => new CodedError("draft_mismatch");
    // A tainted draft's body is cleared.
    if (row.body_enc === null) throw mismatch();
    let payload: SendPayload;
    try {
      payload = SendPayload.parse(JSON.parse(open(this.#keys, row, "ledger.drafts.body_enc", "throw")));
    } catch {
      throw mismatch();
    }
    const values = await draftValues(this.#keys, payload);
    const same =
      payload.account === row.source_account_id &&
      values.payloadFp === row.payload_fp &&
      values.bodyFp === row.body_fp &&
      sameList(values.recipientFps, row.recipient_fps) &&
      sameList(values.recipientDomainFps, row.recipient_domain_fps);
    if (!same) throw mismatch();
    const [account] = await query<{ label: string; compartments: string[]; address_enc: unknown }>(
      "select label, compartments, address_enc from vault.source_accounts where id = $1",
      [row.source_account_id],
    );
    if (account === undefined) throw mismatch();
    const from = opened(
      this.#keys,
      account.compartments[0] ?? "",
      addressAt(row.source_account_id),
      account.address_enc,
    );
    return { checked: { payload, from, fp: values.payloadFp, label: account.label }, row };
  }

  // The disclosure check's candidates at phase send, opened under the keys held: the claims the
  // draft reveals before any release, those that would not open, and how many were left out.
  async #held(query: Query, draft: string, payload: SendPayload): Promise<Held> {
    const rows = await query<Candidate>(
      "select claim_id, compartments, content_enc, cited_item from ledger.use_only_candidates($1)",
      [draft],
    );
    let leftOut = 0;
    const unopened: string[] = [];
    const candidates: {
      id: string;
      thirdParty: boolean;
      isPublic: boolean;
      offThread: boolean;
      citedItem: boolean;
      textValues: string[];
    }[] = [];
    for (const row of rows) {
      if (!row.compartments.every((compartment) => this.#keys.compartments.has(compartment))) {
        leftOut += 1;
        continue;
      }
      try {
        const record = ClaimRecord.parse(
          JSON.parse(open(this.#keys, { ...row, id: row.claim_id }, "knowledge.claims.content_enc", "throw")),
        );
        const fields = record.claim.content.fields;
        const textValues = Object.entries(record.fieldKinds)
          .filter(([, kind]) => kind === "text")
          .map(([name]) => fields[name])
          .filter((value): value is string => typeof value === "string");
        candidates.push({
          id: row.claim_id,
          thirdParty: record.disclosure.includes("third_party"),
          isPublic: row.compartments.length === 1 && row.compartments[0] === "public",
          offThread: true,
          citedItem: row.cited_item,
          textValues,
        });
      } catch {
        unopened.push(row.claim_id);
      }
    }
    const reveal = (released: string[]) =>
      revealedClaims({ subject: payload.subject, body: payload.body, candidates, released });
    const held: HeldClaim[] = [
      ...reveal([]).map((claim) => {
        const values = candidates.find((candidate) => candidate.id === claim.id)?.textValues ?? [];
        return {
          id: claim.id,
          tie: claim.tie,
          value: claim.valueIndex === null ? null : (values[claim.valueIndex] ?? null),
        };
      }),
      ...unopened.map((id) => ({ id, tie: "unopened" as const, value: null })),
    ];
    const contactRows = await query<ContactCandidateRow>(CONTACT_CANDIDATES, [draft]);
    const contacts: ContactCandidate[] = [];
    const unopenedContacts: string[] = [];
    for (const row of contactRows) {
      if (!row.compartments.every((compartment) => this.#keys.compartments.has(compartment))) {
        leftOut += 1;
        continue;
      }
      try {
        contacts.push(openContactCandidate(this.#keys, row));
      } catch {
        unopenedContacts.push(row.contact_id);
      }
    }
    const fields = (released: string[]) =>
      revealedContacts({ subject: payload.subject, body: payload.body, candidates: contacts, released: [] }).filter(
        (field) => !released.includes(contactRef(field)),
      );
    const heldFields: HeldField[] = [
      ...fields([]),
      ...unopenedContacts.map((id) => ({ id, field: "unopened" as const, index: null })),
    ];
    // A claim or a contact that would not open is always counted: it fails the check, never passes.
    return {
      held,
      heldFields,
      leftOut,
      revealedAfter: (released) =>
        reveal(released).length + unopened.length + fields(released).length + unopenedContacts.length,
    };
  }

  // Never stored. Null when nothing holds the draft, or a claim or a contact would not open (it cannot be released).
  #code(fp: string, { held, heldFields }: Pick<Held, "held" | "heldFields">): string | null {
    if (
      (held.length === 0 && heldFields.length === 0) ||
      held.some((claim) => claim.tie === "unopened") ||
      heldFields.some((one) => one.field === "unopened")
    )
      return null;
    const ids = held.map((claim) => claim.id).sort(byText);
    const fields = heldFields.length === 0 ? "" : `\n${heldFields.map(contactRef).sort(byText).join(",")}`;
    return fingerprint(this.#keys, "reveal", `reveal\n${fp}\n${ids.join(",")}${fields}`).slice(0, 8);
  }

  revealCode(draft: string): Promise<string | null> {
    return this.#transaction(async (query) => {
      const { checked } = await this.#check(query, draft);
      return this.#code(checked.fp, await this.#held(query, draft, checked.payload));
    });
  }

  async #facts(query: Query, draft: string): Promise<unknown> {
    return (await query<{ facts: unknown }>("select ledger.gate_facts($1, 'send') as facts", [draft]))[0]?.facts;
  }

  // What `pi send show` prints, gathered in one read: the draft opened, its first contacts, its
  // basis, the gate's nine answers as they stand, and the claims it is held for. Writes nothing.
  show(draft: string): Promise<DraftView> {
    return this.#transaction(async (query) => {
      const { checked, row } = await this.#check(query, draft);
      const first = new Set(
        (await query<{ fps: string[] }>("select ledger.first_contacts($1) as fps", [draft]))[0]?.fps ?? [],
      );
      const firstContacts = [...checked.payload.to, ...checked.payload.cc].filter((address) =>
        first.has(fingerprint(this.#keys, "address", address)),
      );
      const basis = await query<{ kind: string; id: string }>(
        "select ref_kind as kind, ref_id as id from ledger.basis where row_kind = 'draft' and row_id = $1 order by id",
        [draft],
      );
      const facts = await this.#facts(query, draft);
      const found = await this.#held(query, draft, checked.payload);
      const { held, heldFields, leftOut, revealedAfter } = found;
      const outcome = sendGate({
        phase: "send",
        facts: facts as never,
        revealed: revealedAfter([]),
        released: 0,
        computedFp: checked.fp,
        storedFp: row.payload_fp,
      });
      const counts = (facts as Partial<GateFacts> | undefined)?.basis ?? {
        missing: 0,
        tainted: 0,
        flagged: 0,
        unscreened: 0,
      };
      const newThread = checked.payload.thread === null;
      return {
        ...checked,
        draft,
        firstContacts,
        newThread,
        flags: [
          ...(firstContacts.length > 0 ? (["--first-contact"] as const) : []),
          ...(newThread ? (["--new-thread"] as const) : []),
        ],
        basis: basis.map(({ kind, id }) => ({ kind, id })),
        counts,
        outcome,
        held,
        heldFields,
        leftOut,
        revealCode: this.#code(checked.fp, found),
        code: checked.fp.slice(0, 8),
      };
    });
  }

  // A send's steps 5 and 6, in one transaction: the disclosure check over the candidates the keys
  // hold; with `reveal`, the release of the claims held now, refused with `reveal_mismatch` unless
  // the code made now is `reveal`; the gate at phase send; then, only when it cleared, the two
  // confirmations (a missing flag writes no decision) and the decision. A refused gate writes
  // nothing.
  gate(
    draft: string,
    fp: string,
    options: { reveal?: string; firstContact: boolean; newThread: boolean },
  ): Promise<GateAnswer> {
    return this.#transaction(async (query) => {
      const { checked, row } = await this.#check(query, draft);
      const found = await this.#held(query, draft, checked.payload);
      const { held, heldFields, revealedAfter } = found;
      let released: string[] = [];
      if (options.reveal !== undefined) {
        const code = this.#code(row.payload_fp, found);
        if (held.length === 0 && heldFields.length === 0) throw new CodedError("usage");
        if (code === null || code !== options.reveal) throw new CodedError("reveal_mismatch");
        released = [...held.map((claim) => claim.id).sort(byText), ...heldFields.map(contactRef).sort(byText)];
      }
      const facts = await this.#facts(query, draft);
      const outcome = sendGate({
        phase: "send",
        facts: facts as never,
        revealed: revealedAfter(released),
        released: released.length,
        computedFp: fp,
        storedFp: row.payload_fp,
      });
      if (!outcome.cleared) return { cleared: false, outcome, facts };
      const shape = facts as GateFacts;
      const firstContact = shape.recipients.firstContact > 0;
      const newThread = shape.thread.isNew;
      if (firstContact && !options.firstContact) throw new CodedError("first_contact_unconfirmed");
      if (newThread && !options.newThread) throw new CodedError("new_thread_unconfirmed");
      if ((options.firstContact && !firstContact) || (options.newThread && !newThread)) throw new CodedError("usage");
      const decision = newId("gdc");
      const checks = GateCheckKind.options.map((kind) => ({ kind, passed: outcome.checks[kind] }));
      await query("select ledger.append_gate_decision($1, $2, 'send', $3, $4::jsonb, $5::jsonb, 1, $6)", [
        decision,
        draft,
        fp,
        JSON.stringify(checks),
        JSON.stringify(facts),
        DECISION_POINT_PINS["draft_disclosure@1"],
      ]);
      return { cleared: true, outcome, facts, decision, released, firstContact, newThread };
    });
  }

  // A send's step 7: the chain, checked and recorded in the database. The send's id, or null
  // with nothing written.
  begin(args: {
    draft: string;
    decision: string;
    fp: string;
    firstContact: boolean;
    newThread: boolean;
    released: string[];
  }): Promise<string | null> {
    const point = args.firstContact ? "send_first_contact" : "send_clear";
    return this.#transaction(async (query) => {
      const [row] = await query<{ send: string | null }>(
        "select ledger.begin_send($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, 1, $11) as send",
        [
          newId("snt"),
          newId("rul"),
          args.draft,
          args.decision,
          args.fp,
          requestId(),
          args.firstContact,
          args.newThread,
          args.released,
          point,
          DECISION_POINT_PINS[`${point}@1`],
        ],
      );
      return row?.send ?? null;
    });
  }

  // A send's step 9, the last. For `sent`, the fingerprints sync will compute for the copy: the
  // `source_id` of `gmailItemId(id)` and the `thread` of the thread id.
  finish(send: string, result: SendResult): Promise<boolean> {
    const sent = result.outcome === "sent" ? result : null;
    const status = result.outcome === "failed" ? result.status : null;
    return this.#transaction(async (query) => {
      const [row] = await query<{ done: boolean }>("select ledger.finish_send($1, $2, $3, $4, $5) as done", [
        send,
        result.outcome,
        status,
        sent === null ? null : fingerprint(this.#keys, "source_id", gmailItemId(sent.id)),
        sent?.threadId == null ? null : fingerprint(this.#keys, "thread", sent.threadId),
      ]);
      return row?.done === true;
    });
  }

  settle(send: string, answer: "sent" | "not_sent"): Promise<"settled" | "sync_pending" | "not_settleable"> {
    return this.#transaction(async (query) => {
      const [row] = await query<{ answer: "settled" | "sync_pending" | "not_settleable" }>(
        "select ledger.settle_send($1, $2, $3, $4) as answer",
        [send, newId("rul"), answer, requestId()],
      );
      return row?.answer ?? "not_settleable";
    });
  }

  // A label's send secret, sealed under `own` as every secret is, and opened only under its name.
  secret(label: string): Promise<string | null> {
    const name = secretName(label);
    return this.#transaction(async (query) => {
      const [row] = await query<{ value_enc: Sealed }>("select value_enc from policy.secrets where name = $1", [name]);
      return row === undefined
        ? null
        : open(
            this.#keys,
            { id: name, compartments: ownLabel(), value_enc: row.value_enc },
            "policy.secrets.value_enc",
            "throw",
          );
    });
  }

  putSecret(label: string, value: string): Promise<void> {
    const name = secretName(label);
    const sealed = sealRow(this.#keys, "own", secretAt(name), value);
    return this.#transaction(async (query) => {
      await query(
        `insert into policy.secrets (name, value_enc, updated_at) values ($1, $2, now())
         on conflict (name) do update set value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
        [name, sealed],
      );
    });
  }

  // Whether a secret was there to delete.
  deleteSecret(label: string): Promise<boolean> {
    return this.#transaction(
      async (query) =>
        (await query("delete from policy.secrets where name = $1 returning name", [secretName(label)])).length > 0,
    );
  }

  // What `pi send connect` needs of a label: whether it is connected for reading, and its mail
  // account: whether it is `own`, and its address, opened only when it is.
  account(label: string): Promise<{ readConnected: boolean; mail: { own: boolean; address: string | null } | null }> {
    return this.#transaction(async (query) => {
      const readConnected =
        (await query<{ connected: boolean }>("select policy.read_connected($1) as connected", [label]))[0]
          ?.connected === true;
      const [row] = await query<{ id: string; compartments: string[]; address_enc: Sealed }>(
        "select id, compartments, address_enc from vault.source_accounts where label = $1 and connector = 'google_mail'",
        [label],
      );
      if (row === undefined) return { readConnected, mail: null };
      const own = row.compartments.length === 1 && row.compartments[0] === "own";
      return {
        readConnected,
        mail: { own, address: own ? open(this.#keys, row, "vault.source_accounts.address_enc", "throw") : null },
      };
    });
  }

  status(): Promise<SendStatusView> {
    return this.#transaction(async (query) => {
      const secrets = await query<{ name: string; updated_at: Date }>(
        "select name, updated_at from policy.secrets where starts_with(name, $1) order by name",
        [SECRET_PREFIX],
      );
      const labels: SendStatusView["labels"] = [];
      for (const secret of secrets) {
        const label = secret.name.slice(SECRET_PREFIX.length);
        const connected =
          (await query<{ connected: boolean }>("select policy.read_connected($1) as connected", [label]))[0]
            ?.connected === true;
        labels.push({ label, connectedAt: stamp(secret.updated_at), orphaned: !connected });
      }
      const accounts = await query<{ label: string; last_sync_at: Date | null; last_outcome: string | null }>(
        "select label, last_sync_at, last_outcome from vault.source_accounts where connector = 'google_mail' and label = any ($1::text[]) order by label",
        [labels.map((one) => one.label)],
      );
      const [switchRow] = await query<{ state: "on" | "off" }>(KILL_SWITCH_STATE);
      const sends = await this.#sends(query);
      const last = sends.at(-1);
      const drafts = await query<{ status: DraftStatus; n: number }>(
        `select e.event as status, count(*)::int as n from ledger.drafts d
         cross join lateral (${latestRow("event", "draft", "d.id", { alias: "" })}) e
         where e.event in ('made', 'held') group by e.event`,
      );
      const drafted = (status: DraftStatus): number => drafts.find((row) => row.status === status)?.n ?? 0;
      return {
        labels,
        accounts: accounts.map((row) => ({
          label: row.label,
          lastSyncAt: stampOrNull(row.last_sync_at),
          lastOutcome: row.last_outcome,
        })),
        killSwitch: switchRow?.state ?? "off",
        lastSend: last === undefined ? null : { id: last.id, status: last.status, begunAt: last.begunAt },
        counts: {
          made: drafted("made"),
          held: drafted("held"),
          unknown: sends.filter((send) => send.status === "unknown").length,
          stale: sends.filter((send) => send.stale).length,
          copyMissing: sends.filter((send) => send.copyMissing).length,
        },
      };
    });
  }
}

export function createSender(options: SenderOptions): Sender {
  return Sender.create(options);
}
