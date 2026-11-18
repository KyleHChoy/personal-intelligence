import { type CardId, GateFacts } from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { testId } from "../test-support/clients.ts";
import { logClaimState } from "../test-support/commitment-fixtures.ts";
import { one, readAs, session, sqlState, withToken } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";
import {
  age,
  appendDraft,
  appendDraftWith,
  appendGateWith,
  author,
  begin,
  beginArgs,
  beginWith,
  checksJson,
  connectForSend,
  count,
  deferredCard,
  deleteMessage,
  draftArgs,
  events,
  factsAsProxy,
  factsTextAsReader,
  finish,
  gateDraft,
  gateSend,
  hex,
  holding,
  insertAccount,
  insertInteraction,
  insertMessage,
  insertPerson,
  insertSendClient,
  killSwitch,
  knownTo,
  labelOf,
  latest,
  logRead,
  madeDraft,
  OWN,
  opportunity,
  opportunityStatus,
  pending,
  proxy,
  readyReply,
  recipient,
  type SendCtx,
  sendNow,
  settle,
  suppress,
  syncedAt,
  TIMEOUT,
  veto,
  waitingCard,
  watched,
  withSendWorld,
} from "../test-support/send-fixtures.ts";

// Every refusal has its positive control in the same test.

const draftRow = async (w: SendCtx, id: string) =>
  one(
    await w.admin<{
      created_by: string;
      compartments: string[];
      source_account_id: string;
      thread_fp: string | null;
      reply_to_evidence_id: string | null;
      case_key: string | null;
      recipient_fps: string[];
      session_id: string | null;
      tainted_at: Date | null;
      body_enc: unknown;
    }>(
      "select created_by, compartments, source_account_id, thread_fp, reply_to_evidence_id, case_key, recipient_fps, session_id, tainted_at, body_enc from ledger.drafts where id = $1",
      [id],
    ),
  );
const drafts = (w: SendCtx): Promise<number> => count(w, "ledger.drafts");

// A refusal that writes nothing: the SQLSTATE, and every watched table as it was.
async function refusedQuietly(w: SendCtx, run: () => Promise<unknown>): Promise<string | null> {
  const before = await watched(w.db);
  const state = await sqlState(run);
  expect(await watched(w.db)).toEqual(before);
  return state;
}
// A null answer that writes nothing.
async function nullQuietly(w: SendCtx, run: () => Promise<string | null>): Promise<void> {
  const before = await watched(w.db);
  expect(await run()).toBeNull();
  expect(await watched(w.db)).toEqual(before);
}

// The gate at send written first, then a begin_send that answers null and writes nothing.
async function beginNull(
  w: SendCtx,
  draft: { id: string; payloadFp: string },
  more: Parameters<typeof beginArgs>[2] = {},
): Promise<void> {
  const decision = await gateSend(w, draft.id, draft.payloadFp);
  await nullQuietly(w, () => begin(w, beginArgs(draft, decision, more)));
}

describe("append_draft", { timeout: TIMEOUT }, () => {
  it("a draft's author, label, account and thread are the token's and the stored rows'", () =>
    withSendWorld(async (w) => {
      const message = await insertMessage(w, {
        from: "rowan@send-example.test",
      });
      const a = draftArgs(w, { replyTo: message.id });
      expect(await appendDraft(w, a)).toBe(a.id);
      const row = await draftRow(w, a.id);
      expect(row).toMatchObject({
        created_by: author(w.client),
        compartments: labelOf(w.client.compartments),
        source_account_id: w.account.id,
        thread_fp: message.threadFp,
        reply_to_evidence_id: message.evidence,
        session_id: w.client.session,
        tainted_at: null,
      });
      // The compartments are ledger.label of the clearance.
      expect(row.compartments).toEqual(
        one(await w.admin<{ l: string[] }>("select ledger.label($1::text[]) as l", [w.client.compartments])).l,
      );

      // A reply to a message of another account's label, and an account label outside the
      // clearance: each refused with no row.
      const office = await insertAccount(w.db, w.admin, "office", ["employer:example"]);
      const theirs = await insertMessage(w, { account: office });
      expect(await refusedQuietly(w, () => appendDraft(w, draftArgs(w, { replyTo: theirs.id })))).toBe("42501");
      expect(await refusedQuietly(w, () => appendDraft(w, draftArgs(w, { accountLabel: office.label })))).toBe("42501");
      // The positive control for a new message: the client's own account by its label.
      const fresh = draftArgs(w);
      expect(await appendDraft(w, fresh)).toBe(fresh.id);
      expect(await draftRow(w, fresh.id)).toMatchObject({
        source_account_id: w.account.id,
        thread_fp: null,
        reply_to_evidence_id: null,
      });
    }));

  it("a client with no draft_message tool, or no work view, or another client's session, is refused with 42501", () =>
    withSendWorld(async (w) => {
      const noTool = await insertSendClient(w.db, "no-tool", OWN, {
        tools: ["get_self", "read_message"],
      });
      const noView = await insertSendClient(w.db, "no-view", OWN, {
        views: ["self", "people"],
      });
      const other = await insertSendClient(w.db, "other");
      expect(await refusedQuietly(w, () => appendDraft(w, draftArgs({ ...w, client: noTool }), noTool))).toBe("42501");
      expect(await refusedQuietly(w, () => appendDraft(w, draftArgs({ ...w, client: noView }), noView))).toBe("42501");
      expect(await refusedQuietly(w, () => appendDraft(w, draftArgs(w, { session: other.session })))).toBe("42501");
      expect(await refusedQuietly(w, () => readAs(w.db, null, (query) => appendDraftWith(query, draftArgs(w))))).toBe(
        "42501",
      );
      const ok = draftArgs(w);
      expect(await appendDraft(w, ok)).toBe(ok.id);
    }));

  it("a reply_to, an opportunity or a ref the client cannot see, and a reply_to or a ref that names a held message, each refuse the draft with 42501 and no row, as an id that does not exist does", () =>
    withSendWorld(async (w) => {
      const office = await insertAccount(w.db, w.admin, "office", ["employer:example"]);
      const hidden = await insertMessage(w, { account: office });
      const held = await insertMessage(w, { held: true });
      const visible = await insertMessage(w);
      const missing = testId("msg");
      const theirOpportunity = await (async () => {
        const other = await insertSendClient(w.db, "office-agent", ["employer:example"]);
        const ctx = { ...w, client: other, account: office };
        return opportunity(ctx);
      })();
      const cases = [
        draftArgs(w, { replyTo: hidden.id }),
        draftArgs(w, { replyTo: held.id }),
        draftArgs(w, { replyTo: missing }),
        draftArgs(w, { opportunity: theirOpportunity }),
        draftArgs(w, { opportunity: testId("opp") }),
        draftArgs(w, { refs: [["message", hidden.id]] }),
        draftArgs(w, { refs: [["message", held.id]] }),
        draftArgs(w, { refs: [["message", missing]] }),
      ];
      for (const a of cases)
        expect(
          await refusedQuietly(w, () => appendDraft(w, a)),
          JSON.stringify([a.replyTo, a.opportunity, a.refIds]),
        ).toBe("42501");
      // The positive controls: the visible message as reply_to and as a ref.
      const reply = draftArgs(w, {
        replyTo: visible.id,
        refs: [["message", visible.id]],
      });
      expect(await appendDraft(w, reply)).toBe(reply.id);
    }));

  it("a malformed argument is refused with 22023 and no row", () =>
    withSendWorld(async (w) => {
      const bad = [
        { ...draftArgs(w), payloadFp: "not-a-fingerprint" },
        { ...draftArgs(w), bodyFp: "ABC" },
        { ...draftArgs(w), recipientFps: [], domainFps: [] },
        {
          ...draftArgs(w),
          recipientFps: Array.from({ length: 11 }, hex),
          domainFps: [hex()],
        },
        { ...draftArgs(w), refKinds: ["message"], refIds: [] },
      ];
      for (const a of bad) expect(await refusedQuietly(w, () => appendDraft(w, a))).toBe("22023");
      const ok = draftArgs(w);
      expect(await appendDraft(w, ok)).toBe(ok.id);
    }));

  it("a session that read a message with read_message, after which the message is deleted, is refused by append_draft with nothing written", () =>
    withSendWorld(async (w) => {
      const message = await insertMessage(w);
      await logRead(w, message);
      // The positive control: while the message stands, the session drafts.
      const first = draftArgs(w);
      expect(await appendDraft(w, first)).toBe(first.id);
      await deleteMessage(w, message);
      expect(await refusedQuietly(w, () => appendDraft(w, draftArgs(w)))).toBe("42501");
      // A session that read nothing deleted drafts as before.
      const other = await readAs(w.db, w.client.token, async (query) => {
        const id = testId("ses");
        await query("select policy.open_session($1)", [id]);
        return id;
      });
      const fresh = draftArgs(w, { session: other });
      expect(await appendDraft(w, fresh)).toBe(fresh.id);
    }));

  it("the basis holds the refs given, the message answered, and an entity for each recipient the store knows", () =>
    withSendWorld(async (w) => {
      const known = "rowan@send-example.test";
      const unknown = "sorrel@send-example.test";
      const entity = await insertPerson(w, known);
      const cited = await insertMessage(w);
      const answered = await insertMessage(w, { from: known });
      const a = draftArgs(w, {
        replyTo: answered.id,
        to: [known, unknown],
        refs: [["message", cited.id]],
      });
      expect(await appendDraft(w, a)).toBe(a.id);
      const basis = await w.admin<{ ref_kind: string; ref_id: string }>(
        "select ref_kind, ref_id from ledger.basis where row_kind = 'draft' and row_id = $1 order by id",
        [a.id],
      );
      expect(basis).toEqual([
        { ref_kind: "message", ref_id: cited.id },
        { ref_kind: "message", ref_id: answered.id },
        { ref_kind: "entity", ref_id: entity },
      ]);
    }));

  it("a ref to a system_originated message, and one to a message that answers it, is system and not owner-backed; a ref to the owner's own hand-sent message is still an owner-backed source", () =>
    withSendWorld(async (w) => {
      const system = await insertMessage(w, {
        direction: "outbound",
        to: ["rowan@send-example.test"],
        systemOriginated: true,
      });
      const answer = await insertMessage(w, { answersSystem: true });
      const own = await insertMessage(w, {
        direction: "outbound",
        to: ["rowan@send-example.test"],
      });
      const a = draftArgs(w, {
        refs: [
          ["message", system.id],
          ["message", answer.id],
          ["message", own.id],
        ],
      });
      expect(await appendDraft(w, a)).toBe(a.id);
      const rows = await w.admin<{
        ref_id: string;
        source_class: string;
        owner_backed: boolean;
      }>(
        "select ref_id, source_class, owner_backed from ledger.basis where row_kind = 'draft' and row_id = $1 order by id",
        [a.id],
      );
      expect(rows).toEqual([
        { ref_id: system.id, source_class: "system", owner_backed: false },
        { ref_id: answer.id, source_class: "system", owner_backed: false },
        { ref_id: own.id, source_class: "source", owner_backed: true },
      ]);
    }));

  it("a draft that cites an item records, for the fact of each claim of that item within its label, the state the trigger log last wrote for its clearance, and no belief id or version", () =>
    withSendWorld(async (w) => {
      const seed = seeder(w.db, w.admin);
      const cited = await insertMessage(w);
      const other = await insertMessage(w);
      const claim = await seed.claim(OWN, cited.evidence);
      const otherClaim = await seed.claim(OWN, other.evidence);
      // Two states of the cited fact under the draft's clearance, one under another, one of another item's.
      await logClaimState(w, claim, sha256("state earlier"));
      const fact = await logClaimState(w, claim, sha256("state latest"));
      await logClaimState(w, claim, sha256("state wider"), ["employer:example", "own"]);
      await logClaimState(w, otherClaim, sha256("state other item"));
      const a = draftArgs(w, { refs: [["message", cited.id]] });
      expect(await appendDraft(w, a)).toBe(a.id);
      const rows = await w.admin("select * from ledger.draft_beliefs where draft_id = $1", [a.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ draft_id: a.id, fact_key_fp: fact, state_fp: sha256("state latest") });
      expect(Object.keys(rows[0] ?? {})).not.toContain("version");
      expect(Object.keys(rows[0] ?? {})).not.toContain("belief_id");
    }));

  it("case_key is opportunity:<id> with an opportunity; two proposals with one thread and one set of recipients have one 64-character key, and another recipient gives another", () =>
    withSendWorld(async (w) => {
      const opp = await opportunity(w);
      const withOpp = draftArgs(w, { opportunity: opp });
      expect(await appendDraft(w, withOpp)).toBe(withOpp.id);
      expect((await draftRow(w, withOpp.id)).case_key).toBe(`opportunity:${opp}`);

      const message = await insertMessage(w, {
        from: "rowan@send-example.test",
      });
      const one1 = draftArgs(w, {
        replyTo: message.id,
        to: ["sorrel@send-example.test", "rowan@send-example.test"],
      });
      const one2 = draftArgs(w, {
        replyTo: message.id,
        to: ["rowan@send-example.test", "sorrel@send-example.test"],
      });
      const another = draftArgs(w, {
        replyTo: message.id,
        to: ["rowan@send-example.test"],
      });
      for (const a of [one1, one2, another]) expect(await appendDraft(w, a)).toBe(a.id);
      const key = (await draftRow(w, one1.id)).case_key;
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect((await draftRow(w, one2.id)).case_key).toBe(key);
      expect((await draftRow(w, another.id)).case_key).not.toBe(key);
      // The key is the hex SHA-256 of the thread fingerprint, a line feed and the sorted fingerprints.
      const fps = [...one1.recipientFps].sort().join(",");
      expect(key).toBe(sha256(`${message.threadFp}\n${fps}`));
      // A new thread hashes the word new.
      const fresh = draftArgs(w, { to: ["rowan@send-example.test"] });
      expect(await appendDraft(w, fresh)).toBe(fresh.id);
      expect((await draftRow(w, fresh.id)).case_key).toBe(sha256(`new\n${fresh.recipientFps[0]}`));
    }));

  it("recipient fingerprints are stored sorted, each once", () =>
    withSendWorld(async (w) => {
      const a = draftArgs(w, {
        to: ["zed@send-example.test", "abe@send-example.test"],
      });
      const doubled = {
        ...a,
        recipientFps: [...a.recipientFps, ...a.recipientFps],
      };
      expect(await appendDraft(w, doubled)).toBe(a.id);
      expect((await draftRow(w, a.id)).recipient_fps).toEqual([...new Set(a.recipientFps)].sort());
    }));

  it("the fifty-first draft of a client that has fifty made or held is rate_limited and writes nothing; an expired, rejected or sent one does not count; another client's do not count", () =>
    withSendWorld(async (w) => {
      const ids: string[] = [];
      await session(w.db.urls.reader, async (query) => {
        for (let index = 0; index < 50; index += 1) {
          const a = draftArgs(w);
          await withToken(query, w.client.token, async (run) => {
            expect(await appendDraftWith(run, a)).toBe(a.id);
            await appendGateWith(
              run,
              testId("gdc"),
              a.id,
              "draft",
              a.payloadFp,
              checksJson(index % 2 === 0 ? [] : ["disclosure"]),
              null,
            );
          });
          ids.push(a.id);
        }
      });
      const before = await watched(w.db);
      expect(await appendDraft(w, draftArgs(w))).toBe("rate_limited");
      expect(await watched(w.db)).toEqual(before);
      // Another client's cap is its own.
      const other = await insertSendClient(w.db, "other");
      const theirs = draftArgs({ ...w, client: other });
      expect(await appendDraft(w, theirs, other)).toBe(theirs.id);
      // An expired, a rejected and a sent draft each free a place.
      for (const [index, event] of (["expired", "rejected", "sent"] as const).entries()) {
        await w.admin(
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('draft', $1, $2, now(), 'system:test', '{own}')",
          [ids[index], event],
        );
        const next = draftArgs(w);
        expect(await appendDraft(w, next), event).toBe(next.id);
        await gateDraft(w, next.id, next.payloadFp);
        expect(await appendDraft(w, draftArgs(w)), `full again after ${event}`).toBe("rate_limited");
      }
    }));

  it("two append_draft calls of one client at once, at forty-nine, store one", () =>
    withSendWorld(async (w) => {
      await session(w.db.urls.reader, async (query) => {
        for (let index = 0; index < 49; index += 1) {
          const a = draftArgs(w);
          await withToken(query, w.client.token, async (run) => {
            await appendDraftWith(run, a);
            await appendGateWith(run, testId("gdc"), a.id, "draft", a.payloadFp, checksJson(), null);
          });
        }
      });
      const [one1, two] = [draftArgs(w), draftArgs(w)];
      const answers = await Promise.all([appendDraft(w, one1), appendDraft(w, two)]);
      expect(answers.filter((answer) => answer === "rate_limited")).toHaveLength(1);
      expect(await drafts(w)).toBe(50);
    }));

  it("a repeated request id returns the first result and writes nothing", () =>
    withSendWorld(async (w) => {
      const a = draftArgs(w);
      expect(await appendDraft(w, a)).toBe(a.id);
      const before = await watched(w.db);
      expect(await appendDraft(w, { ...draftArgs(w), requestId: a.requestId })).toBe(a.id);
      expect(await watched(w.db)).toEqual(before);
      // Another request id stores another draft.
      const b = draftArgs(w);
      expect(await appendDraft(w, b)).toBe(b.id);
    }));
});

describe("append_gate_decision", { timeout: TIMEOUT }, () => {
  it("ledger.gate_checks holds nine rows for a decision, with no request id; eight checks, or a kind twice, is refused", () =>
    withSendWorld(async (w) => {
      const a = draftArgs(w);
      await appendDraft(w, a);
      const eight = JSON.stringify(JSON.parse(checksJson()).slice(0, 8));
      const twice = JSON.stringify([...JSON.parse(checksJson()).slice(0, 8), { kind: "authority", passed: true }]);
      for (const checks of [eight, twice]) {
        expect(
          await refusedQuietly(w, () =>
            readAs(w.db, w.client.token, (query) =>
              appendGateWith(query, testId("gdc"), a.id, "draft", a.payloadFp, checks, null),
            ),
          ),
        ).toBe("22023");
      }
      const decision = await gateDraft(w, a.id, a.payloadFp);
      const rows = await w.admin("select * from ledger.gate_checks where decision_id = $1", [decision]);
      expect(rows).toHaveLength(9);
      expect(Object.keys(rows[0] ?? {})).not.toContain("request_id");
      expect(rows.map((row) => row.kind).sort()).toEqual(
        [...JSON.parse(checksJson()).map((c: { kind: string }) => c.kind)].sort(),
      );
    }));

  it("at phase draft a decision of nine true rows makes the draft made, and one false row held; a second phase-draft decision is refused", () =>
    withSendWorld(async (w) => {
      const made = await madeDraft(w);
      expect(await latest(w, "draft", made.id)).toBe("made");
      const held = await madeDraft(w, {}, ["freshness"]);
      expect(await latest(w, "draft", held.id)).toBe("held");
      // A held draft is not made again by another decision.
      expect(await refusedQuietly(w, () => gateDraft(w, held.id, held.payloadFp))).toBe("22023");
      expect(await latest(w, "draft", held.id)).toBe("held");
      // Stored rows: the decision is the draft author's, with no facts.
      const rows = await w.admin<{
        created_by: string;
        facts: unknown;
        phase: string;
      }>("select created_by, facts, phase from ledger.gate_checks where decision_id = $1", [made.decision]);
      expect(
        rows.every((row) => row.created_by === author(w.client) && row.facts === null && row.phase === "draft"),
      ).toBe(true);
    }));

  it("as pi_reader, phase send is refused", () =>
    withSendWorld(async (w) => {
      const a = draftArgs(w);
      await appendDraft(w, a);
      expect(
        await refusedQuietly(w, () =>
          readAs(w.db, w.client.token, (query) =>
            appendGateWith(query, testId("gdc"), a.id, "send", a.payloadFp, checksJson(), null),
          ),
        ),
      ).toBe("42501");
      await gateDraft(w, a.id, a.payloadFp);
    }));

  it("at phase send the facts are stored with draft.ageSeconds and account.syncAgeSeconds zero, and at phase draft none", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      await age(w.db, "ledger.drafts", "created_at", "id = $1", [ready.id], 600);
      const decision = await gateSend(w, ready.id, ready.payloadFp);
      const rows = await w.admin<{ facts: GateFacts; created_by: string }>(
        "select facts, created_by from ledger.gate_checks where decision_id = $1",
        [decision],
      );
      expect(rows).toHaveLength(9);
      for (const row of rows) {
        expect(row.created_by).toBe("owner");
        expect(GateFacts.parse(row.facts).draft.ageSeconds).toBe(0);
        expect(row.facts.account.syncAgeSeconds).toBe(0);
      }
      // The facts as they stand still carry the ages.
      expect((await factsAsProxy(w, ready.id)).draft.ageSeconds).toBeGreaterThanOrEqual(600);
      expect(
        await w.admin("select facts from ledger.gate_checks where decision_id = $1 and facts is not null", [
          ready.decision,
        ]),
      ).toEqual([]);
    }));

  it("the draft_disclosure call row is hold when disclosure failed and no_finding otherwise", () =>
    withSendWorld(async (w) => {
      const clean = await madeDraft(w);
      const held = await madeDraft(w, {}, ["disclosure"]);
      const call = (decision: string) =>
        w.admin<{
          point: string;
          rung: number;
          output: string;
          effect: string;
          effect_class: string;
          subject_kind: string;
          subject_id: string;
          request_id: string;
          input_hash: string;
        }>(
          "select point, rung, output, effect, effect_class, subject_kind, subject_id, request_id, input_hash from ledger.decision_point_calls where id = $1",
          [`dpc_${decision.slice(4)}`],
        );
      expect(await call(clean.decision)).toEqual([
        expect.objectContaining({
          point: "draft_disclosure",
          rung: 0,
          output: "no_finding",
          effect: "record_silence",
          effect_class: "narrow",
          subject_kind: "draft",
          subject_id: clean.id,
          request_id: clean.decision,
        }),
      ]);
      expect(await call(held.decision)).toEqual([
        expect.objectContaining({
          point: "draft_disclosure",
          output: "hold",
          effect: "hold",
          subject_id: held.id,
        }),
      ]);
    }));

  it("the input_hash of draft_disclosure is the hash of the draft, the phase, the decision and the nine booleans, and holds no fingerprint", () =>
    withSendWorld(async (w) => {
      const held = await madeDraft(w, {}, ["disclosure"]);
      const checks = Object.fromEntries(
        JSON.parse(checksJson(["disclosure"])).map((c: { kind: string; passed: boolean }) => [c.kind, c.passed]),
      );
      const expected = one(
        await w.admin<{ h: string }>(
          "select encode(sha256(convert_to(jsonb_build_object('draft', $1::text, 'phase', 'draft', 'decision', $2::text, 'checks', $3::jsonb)::text, 'UTF8')), 'hex') as h",
          [held.id, held.decision, JSON.stringify(checks)],
        ),
      ).h;
      expect(
        one(
          await w.admin<{ input_hash: string }>("select input_hash from ledger.decision_point_calls where id = $1", [
            `dpc_${held.decision.slice(4)}`,
          ]),
        ).input_hash,
      ).toBe(expected);
    }));
});

describe("gate_facts", { timeout: TIMEOUT }, () => {
  // A reply that clears at both phases, with an opportunity of kind reply the owner decided go.
  const clearing = async (w: SendCtx) => {
    const ready = await readyReply(w);
    return ready;
  };
  const clear = (facts: GateFacts) => ({
    found: facts.draft.found,
    tainted: facts.draft.tainted,
    status: facts.draft.status,
    withinCap: facts.draft.withinCap,
    consentFree: facts.draft.consentFree,
    authorCurrent: facts.draft.authorCurrent,
    connected: facts.account.connected,
    own: facts.account.own,
    copyMissing: facts.account.copyMissing,
    recipients: facts.recipients,
    about: facts.about,
    basis: facts.basis,
    beliefs: facts.beliefs,
    thread: facts.thread,
    sent: facts.sent,
    killSwitch: facts.killSwitch,
  });

  it("a clearing draft's facts are clear, and parse as GateFacts", () =>
    withSendWorld(async (w) => {
      const ready = await clearing(w);
      const facts = await factsAsProxy(w, ready.id);
      expect(clear(facts)).toEqual({
        found: true,
        tainted: false,
        status: "made",
        withinCap: true,
        consentFree: true,
        authorCurrent: true,
        connected: true,
        own: true,
        copyMissing: false,
        recipients: { count: 1, vetoed: 0, suppressed: 0, firstContact: 0 },
        about: { vetoed: false },
        basis: { missing: 0, tainted: 0, flagged: 0, unscreened: 1 },
        beliefs: { changed: 0 },
        thread: { isNew: false, found: true, newer: 0 },
        sent: { already: false },
        killSwitch: false,
      });
      expect(facts.account.syncAgeSeconds).toBeLessThan(60);
      expect(facts.work).toEqual({
        named: false,
        go: false,
        open: false,
        tainted: false,
      });
      // An id that names no draft answers found false.
      expect((await factsAsProxy(w, testId("drf"))).draft.found).toBe(false);
      // Before the gate the status is new.
      const a = draftArgs(w);
      await appendDraft(w, a);
      expect((await factsAsProxy(w, a.id, "draft")).draft.status).toBe("new");
    }));

  it("a veto on a recipient's address, and one on a recipient's domain, each move recipients.vetoed", () =>
    withSendWorld(async (w) => {
      const ready = await clearing(w);
      const r = recipient(w.db, ready.to[0] ?? "");
      expect((await factsAsProxy(w, ready.id)).recipients.vetoed).toBe(0);
      const ruling = await veto(w, "person", [r.fp]);
      expect((await factsAsProxy(w, ready.id)).recipients.vetoed).toBeGreaterThan(0);
      await w.admin("update knowledge.vetoes set lifted_at = now(), lift_ruling_id = $1 where ruling_id = $1", [
        ruling,
      ]);
      expect((await factsAsProxy(w, ready.id)).recipients.vetoed).toBe(0);
      await veto(w, "organization", [r.domainFp]);
      expect((await factsAsProxy(w, ready.id)).recipients.vetoed).toBeGreaterThan(0);
    }));

  it("a veto on the kind of work moves about.vetoed, and one on what the opportunity is about moves about.vetoed", () =>
    withSendWorld(async (w) => {
      const opp = await opportunity(w, "reply");
      const ready = await readyReply(w, { opportunity: opp });
      expect((await factsAsProxy(w, ready.id)).about.vetoed).toBe(false);
      const ruling = await veto(w, "any", [], "reply");
      expect((await factsAsProxy(w, ready.id)).about.vetoed).toBe(true);
      await w.admin("update knowledge.vetoes set lifted_at = now(), lift_ruling_id = $1 where ruling_id = $1", [
        ruling,
      ]);
      expect((await factsAsProxy(w, ready.id)).about.vetoed).toBe(false);
      // What the opportunity is about: its message's sender.
      const about = one(
        await w.admin<{ about_id: string }>("select about_id from ledger.opportunities where id = $1", [opp]),
      ).about_id;
      const sender = one(
        await w.admin<{ sender_fp: string }>("select sender_fp from knowledge.messages where id = $1", [about]),
      ).sender_fp;
      await veto(w, "person", [sender]);
      expect((await factsAsProxy(w, ready.id)).about.vetoed).toBe(true);
    }));

  it("a veto on a basis ref moves about.vetoed", () =>
    withSendWorld(async (w) => {
      const cited = await insertMessage(w, { from: "teal@send-cited.test" });
      const ready = await readyReply(w, { refs: [["message", cited.id]] });
      expect((await factsAsProxy(w, ready.id)).about.vetoed).toBe(false);
      await veto(w, "person", [recipient(w.db, "teal@send-cited.test").fp]);
      expect((await factsAsProxy(w, ready.id)).about.vetoed).toBe(true);
    }));

  it("a suppressed recipient moves recipients.suppressed, and a first contact recipients.firstContact", () =>
    withSendWorld(async (w) => {
      const ready = await clearing(w);
      await suppress(w, recipient(w.db, ready.to[0] ?? "").fp);
      expect((await factsAsProxy(w, ready.id)).recipients.suppressed).toBe(1);
      const fresh = await madeDraft(w, { to: ["never@send-example.test"] });
      expect((await factsAsProxy(w, fresh.id)).recipients.firstContact).toBe(1);
      expect((await factsAsProxy(w, ready.id)).recipients.firstContact).toBe(0);
    }));

  it("a missing ref, a tainted ref, a flagged ref and an unscreened ref each move their own count and not the other", () =>
    withSendWorld(async (w) => {
      const seed = seeder(w.db, w.admin);
      const screened = await insertMessage(w);
      await seed.pipelineItem(OWN, screened.evidence);
      const factsFor = async (ref: Awaited<ReturnType<typeof insertMessage>>) => {
        const d = await madeDraft(w, { refs: [["message", ref.id]] });
        return d;
      };
      const base = await factsFor(screened);
      // The clean, screened ref: nothing counted beyond the reply-less new draft's.
      expect((await factsAsProxy(w, base.id)).basis).toEqual({
        missing: 0,
        tainted: 0,
        flagged: 0,
        unscreened: 0,
      });

      // Unscreened: no withheld_items answer; and one answered screened false and withheld false.
      const unanswered = await factsFor(await insertMessage(w));
      expect((await factsAsProxy(w, unanswered.id)).basis).toEqual({
        missing: 0,
        tainted: 0,
        flagged: 0,
        unscreened: 1,
      });
      const notScreened = await insertMessage(w);
      await seed.pipelineItem(OWN, notScreened.evidence);
      await w.admin("update vault.pipeline_items set screened = false where evidence_id = $1", [notScreened.evidence]);
      const d2 = await factsFor(notScreened);
      expect((await factsAsProxy(w, d2.id)).basis).toEqual({
        missing: 0,
        tainted: 0,
        flagged: 0,
        unscreened: 1,
      });

      // Flagged: withheld, held (after the draft was made), an agent record with flagged_at.
      const withheld = await insertMessage(w);
      await seed.pipelineItem(OWN, withheld.evidence);
      const d3 = await factsFor(withheld);
      await w.admin("update vault.pipeline_items set withheld = true where evidence_id = $1", [withheld.evidence]);
      expect((await factsAsProxy(w, d3.id)).basis).toEqual({
        missing: 0,
        tainted: 0,
        flagged: 1,
        unscreened: 0,
      });
      const later = await insertMessage(w);
      await seed.pipelineItem(OWN, later.evidence);
      const d4 = await factsFor(later);
      await w.admin("update knowledge.messages set held = true where id = $1", [later.id]);
      expect((await factsAsProxy(w, d4.id)).basis).toEqual({
        missing: 0,
        tainted: 0,
        flagged: 1,
        unscreened: 0,
      });

      // Tainted, and missing: the cited message deleted and taint_citing run as the writer does.
      const gone = await insertMessage(w);
      await seed.pipelineItem(OWN, gone.evidence);
      const d5 = await factsFor(gone);
      await deleteMessage(w, gone);
      const basis = (await factsAsProxy(w, d5.id)).basis;
      expect(basis.missing).toBe(1);
      expect(basis.flagged).toBe(0);
      expect(basis.unscreened).toBe(0);
      await queryAs(w.db.urls.writer, "select ledger.taint_citing($1::text[], '{}'::text[], '{}'::text[])", [
        [gone.evidence],
      ]);
      expect((await factsAsProxy(w, d5.id)).basis.tainted).toBe(1);
    }));

  it("flagged plus unscreened equals the number of refs for which ledger.basis_flagged answers true", () =>
    withSendWorld(async (w) => {
      const seed = seeder(w.db, w.admin);
      const clean = await insertMessage(w);
      await seed.pipelineItem(OWN, clean.evidence);
      const unscreened = await insertMessage(w);
      const withheld = await insertMessage(w);
      await seed.pipelineItem(OWN, withheld.evidence);
      const d = await madeDraft(w, {
        refs: [
          ["message", clean.id],
          ["message", unscreened.id],
          ["message", withheld.id],
        ],
      });
      await w.admin("update vault.pipeline_items set withheld = true where evidence_id = $1", [withheld.evidence]);
      const facts = (await factsAsProxy(w, d.id)).basis;
      let flaggedRefs = 0;
      for (const ref of [clean, unscreened, withheld]) {
        const [row] = await queryAs<{ flagged: boolean }>(
          w.db.urls.work,
          "select ledger.basis_flagged(array['message'], array[$1::text]) as flagged",
          [ref.id],
        );
        if (row?.flagged === true) flaggedRefs += 1;
      }
      expect(facts.flagged + facts.unscreened).toBe(flaggedRefs);
      expect(flaggedRefs).toBe(2);
    }));

  it("a cited fact whose last state in the trigger log changed moves beliefs.changed, and one changed back does not; a state of another clearance moves nothing; one with no state yet moves it once a state is written", () =>
    withSendWorld(async (w) => {
      const seed = seeder(w.db, w.admin);
      const cited = await insertMessage(w);
      const claim = await seed.claim(OWN, cited.evidence);
      await logClaimState(w, claim, sha256("state first"));
      const d = await madeDraft(w, { refs: [["message", cited.id]] });
      expect((await factsAsProxy(w, d.id)).beliefs.changed).toBe(0);
      await logClaimState(w, claim, sha256("state wider"), ["employer:example", "own"]);
      expect((await factsAsProxy(w, d.id)).beliefs.changed).toBe(0);
      await logClaimState(w, claim, sha256("state second"));
      expect((await factsAsProxy(w, d.id)).beliefs.changed).toBe(1);
      await logClaimState(w, claim, sha256("state first"));
      expect((await factsAsProxy(w, d.id)).beliefs.changed).toBe(0);
      const fresh = await insertMessage(w);
      const freshClaim = await seed.claim(OWN, fresh.evidence);
      const later = await madeDraft(w, { refs: [["message", fresh.id]] });
      expect((await factsAsProxy(w, later.id)).beliefs.changed).toBe(0);
      await logClaimState(w, freshClaim, sha256("state after the draft"));
      expect((await factsAsProxy(w, later.id)).beliefs.changed).toBe(1);
    }));

  it("a later message on the thread moves thread.newer, and a deleted answered message thread.found", () =>
    withSendWorld(async (w) => {
      const ready = await clearing(w);
      const thread = one(
        await w.admin<{ thread_fp: string }>("select thread_fp from knowledge.messages where id = $1", [
          ready.message.id,
        ]),
      ).thread_fp;
      // A later message of the same thread: inserted with the same thread fingerprint.
      const later = await insertMessage(w, { at: new Date().toISOString() });
      await w.admin("update knowledge.messages set thread_fp = $2 where id = $1", [later.id, thread]);
      await w.admin("update vault.evidence_items set thread_fp = $2 where id = $1", [later.evidence, thread]);
      expect((await factsAsProxy(w, ready.id)).thread.newer).toBe(1);
      await deleteMessage(w, later);
      expect((await factsAsProxy(w, ready.id)).thread).toEqual({
        isNew: false,
        found: true,
        newer: 0,
      });
      await deleteMessage(w, ready.message);
      expect((await factsAsProxy(w, ready.id)).thread.found).toBe(false);
    }));

  it("sent.already: a send of this draft sending; a second draft's send of the same text and recipients unknown; a stored outbound message with the draft's body fingerprint and recipients observed after the draft was made", () =>
    withSendWorld(async (w) => {
      const ready = await clearing(w);
      expect((await factsAsProxy(w, ready.id)).sent.already).toBe(false);
      await sendNow(w, ready);
      expect((await factsAsProxy(w, ready.id)).sent.already).toBe(true);

      const twin = await madeDraft(w, {
        to: ready.to,
        replyTo: ready.message.id,
        bodyFp: ready.bodyFp,
      });
      expect((await factsAsProxy(w, twin.id)).sent.already).toBe(true);

      // A stored copy the owner sent by hand: observed after the draft was made.
      const third = await madeDraft(w, { to: ["third@send-example.test"] });
      expect((await factsAsProxy(w, third.id)).sent.already).toBe(false);
      await insertMessage(w, {
        direction: "outbound",
        to: third.to,
        bodyFp: third.bodyFp,
        at: new Date(Date.now() - 3_600_000 * 24).toISOString(),
      });
      expect((await factsAsProxy(w, third.id)).sent.already, "observed before the draft").toBe(false);
      await insertMessage(w, {
        direction: "outbound",
        to: third.to,
        bodyFp: third.bodyFp,
        at: new Date(Date.now() + 1000).toISOString(),
      });
      expect((await factsAsProxy(w, third.id)).sent.already).toBe(true);
    }));

  it("an opportunity not decided go, and the kill switch, each move their fact", () =>
    withSendWorld(async (w) => {
      const noGo = await opportunity(w, "reply", "proposed", null);
      const go = await opportunity(w, "reply");
      const d1 = await madeDraft(w, { opportunity: noGo });
      const d2 = await madeDraft(w, { opportunity: go });
      expect((await factsAsProxy(w, d1.id)).work).toEqual({
        named: true,
        go: false,
        open: false,
        tainted: false,
      });
      expect((await factsAsProxy(w, d2.id)).work).toEqual({
        named: true,
        go: true,
        open: true,
        tainted: false,
      });
      expect((await factsAsProxy(w, d2.id)).killSwitch).toBe(false);
      await killSwitch(w, "on");
      expect((await factsAsProxy(w, d2.id)).killSwitch).toBe(true);
      await killSwitch(w, "off");
      expect((await factsAsProxy(w, d2.id)).killSwitch).toBe(false);
    }));

  it("no send secret, a send secret whose label has no read secret, a sync 31 minutes old and a last sync that ended other than ok each move their fact", () =>
    withSendWorld(async (w) => {
      const d = await madeDraft(w);
      expect((await factsAsProxy(w, d.id)).account.connected).toBe(false);
      await connectForSend(w, w.account, { read: false });
      expect((await factsAsProxy(w, d.id)).account.connected, "send secret, no read secret").toBe(false);
      await connectForSend(w, w.account);
      expect((await factsAsProxy(w, d.id)).account.connected).toBe(true);
      await syncedAt(w, w.account, 31 * 60);
      expect((await factsAsProxy(w, d.id)).account.syncAgeSeconds).toBeGreaterThanOrEqual(31 * 60);
      await syncedAt(w, w.account, 5, "token_failed");
      expect((await factsAsProxy(w, d.id)).account.syncAgeSeconds).toBeNull();
      // read_connected answers the same, for either of the two read secrets.
      expect(
        one(await proxy<{ c: boolean }>(w.db, "select policy.read_connected($1::text) as c", [w.account.label])).c,
      ).toBe(true);
      expect(one(await proxy<{ c: boolean }>(w.db, "select policy.read_connected($1::text) as c", ["nobody"])).c).toBe(
        false,
      );
    }));

  it("own and the author's own agent compartment are within the cap; another client's is not", () =>
    withSendWorld(
      async (w) => {
        const recorder = await insertSendClient(w.db, "drafter-two", ["own", "agent:drafter-two"]);
        const r = { ...w, client: recorder };
        const mine = await madeDraft(r);
        expect((await factsAsProxy(w, mine.id)).draft.withinCap).toBe(true);
        const wide = await insertSendClient(w.db, "wide", ["own", "agent:other"]);
        const theirs = await madeDraft({ ...w, client: wide });
        expect((await factsAsProxy(w, theirs.id)).draft.withinCap).toBe(false);
        const employer = await insertSendClient(w.db, "employer", ["own", "employer:example"]);
        const em = await madeDraft({ ...w, client: employer });
        expect((await factsAsProxy(w, em.id)).draft.withinCap).toBe(false);
      },
      { keyCompartments: ["own", "employer:example", "agent:drafter-two", "agent:other"] },
    ));

  it("consentFree holds for a reply, a follow_up and a proposal with no opportunity, and not for another kind; authorCurrent fails for a revoked author", () =>
    withSendWorld(async (w) => {
      const reply = await madeDraft(w, {
        opportunity: await opportunity(w, "reply"),
      });
      const follow = await madeDraft(w, {
        opportunity: await opportunity(w, "follow_up"),
      });
      const other = await madeDraft(w, {
        opportunity: await opportunity(w, "investigate"),
      });
      const proposal = await madeDraft(w);
      expect((await factsAsProxy(w, reply.id)).draft.consentFree).toBe(true);
      expect((await factsAsProxy(w, follow.id)).draft.consentFree).toBe(true);
      expect((await factsAsProxy(w, proposal.id)).draft.consentFree).toBe(true);
      expect((await factsAsProxy(w, other.id)).draft.consentFree).toBe(false);
      expect((await factsAsProxy(w, proposal.id)).draft.authorCurrent).toBe(true);
      await w.admin("update policy.clients set status = 'revoked', revoked_at = now() where id = $1", [w.client.id]);
      expect((await factsAsProxy(w, proposal.id)).draft.authorCurrent).toBe(false);
    }));

  it("as pi_reader, the facts for a draft to a vetoed address, to a suppressed address and to a plain address are byte-equal, and so are those with the kill switch on and with a copy missing", () =>
    withSendWorld(async (w) => {
      const vetoed = "vetoed@send-example.test";
      const suppressed = "suppressed@send-example.test";
      const plain = "plain@send-example.test";
      await knownTo(w, [vetoed, suppressed, plain]);
      await veto(w, "person", [recipient(w.db, vetoed).fp]);
      await suppress(w, recipient(w.db, suppressed).fp);
      const drafts = [];
      for (const to of [vetoed, suppressed, plain]) {
        const a = draftArgs(w, { to: [to] });
        await appendDraft(w, a);
        drafts.push(a.id);
      }
      const texts = await Promise.all(drafts.map((id) => factsTextAsReader(w, id)));
      expect(texts[0]).toBe(texts[2]);
      expect(texts[1]).toBe(texts[2]);
      // The true facts differ, as the proxy reads them.
      expect((await factsAsProxy(w, drafts[0] ?? "", "draft")).recipients.vetoed).toBeGreaterThan(0);
      expect((await factsAsProxy(w, drafts[1] ?? "", "draft")).recipients.suppressed).toBe(1);
      // The kill switch on, and a copy missing: the reader's facts do not move. The account is
      // connected and synced first, as readyReply does, so only those two change below; the sync
      // is set again to 5 seconds before the last read, so its age reads the same.
      await connectForSend(w, w.account);
      await syncedAt(w, w.account, 5);
      const before = await factsTextAsReader(w, drafts[2] ?? "");
      await killSwitch(w, "on");
      const ready = await readyReply(w, { to: ["copy@send-example.test"] });
      await killSwitch(w, "off");
      const send = await sendNow(w, ready);
      await finish(w, send, "sent");
      await age(w.db, "ledger.sent_messages", "sent_at", "id = $1", [send], 45 * 60);
      await killSwitch(w, "on");
      expect((await factsAsProxy(w, drafts[2] ?? "", "draft")).account.copyMissing).toBe(true);
      expect((await factsAsProxy(w, drafts[2] ?? "", "draft")).killSwitch).toBe(true);
      await syncedAt(w, w.account, 5);
      // The draft's own age moves with the clock between the two reads, by more than a second
      // under load; it is the one field set to the same value in both before they are compared.
      const atAgeZero = (text: string): string => text.replace(/"ageSeconds": \d+/, '"ageSeconds": 0');
      expect(before).toMatch(/"draft": \{[^}]*"ageSeconds": \d+/);
      expect(atAgeZero(await factsTextAsReader(w, drafts[2] ?? ""))).toBe(atAgeZero(before));
    }));

  it("as pi_reader, append_gate_decision stores the vetoes, conflict_lists and channel_cap rows from the true facts, so the vetoed and the suppressed drafts are held and the plain one made", () =>
    withSendWorld(async (w) => {
      const vetoed = "vetoed@send-example.test";
      const suppressed = "suppressed@send-example.test";
      await veto(w, "person", [recipient(w.db, vetoed).fp]);
      await suppress(w, recipient(w.db, suppressed).fp);
      const results: Record<string, { state: string | null; rows: Record<string, boolean> }> = {};
      for (const to of [vetoed, suppressed, "plain@send-example.test"]) {
        const d = await madeDraft(w, { to: [to] });
        const rows = await w.admin<{ kind: string; passed: boolean }>(
          "select kind, passed from ledger.gate_checks where decision_id = $1",
          [d.decision],
        );
        results[to] = {
          state: await latest(w, "draft", d.id),
          rows: Object.fromEntries(rows.map((row) => [row.kind, row.passed])),
        };
      }
      expect(results[vetoed]).toMatchObject({
        state: "held",
        rows: { vetoes: false, conflict_lists: true },
      });
      expect(results[suppressed]).toMatchObject({
        state: "held",
        rows: { vetoes: true, conflict_lists: false },
      });
      expect(results["plain@send-example.test"]).toMatchObject({
        state: "made",
        rows: { vetoes: true, conflict_lists: true, channel_cap: true },
      });
      // channel_cap from the true label: another client's agent compartment holds it, whatever the caller says.
      const wide = await insertSendClient(w.db, "wide", ["own", "agent:other"]);
      const d = await madeDraft({ ...w, client: wide });
      expect(await latest(w, "draft", d.id)).toBe("held");
      expect(
        one(
          await w.admin<{ passed: boolean }>(
            "select passed from ledger.gate_checks where decision_id = $1 and kind = 'channel_cap'",
            [d.decision],
          ),
        ).passed,
      ).toBe(false);
    }));

  it("as pi_reader, at phase draft, the channel_cap row is computed without the send secret and missing copy clauses, so a draft from an account with no send secret or with a missing copy is made", () =>
    withSendWorld(async (w) => {
      const noSecret = await madeDraft(w, { to: ["one@send-example.test"] });
      expect(await latest(w, "draft", noSecret.id)).toBe("made");
      const ready = await readyReply(w, { to: ["two@send-example.test"] });
      const send = await sendNow(w, ready);
      await finish(w, send, "sent");
      await age(w.db, "ledger.sent_messages", "sent_at", "id = $1", [send], 45 * 60);
      expect((await factsAsProxy(w, ready.id)).account.copyMissing).toBe(true);
      const missing = await madeDraft(w, { to: ["three@send-example.test"] });
      expect(await latest(w, "draft", missing.id)).toBe("made");
    }));

  it("gate_facts as pi_reader is refused for another client's draft and for phase send", () =>
    withSendWorld(async (w) => {
      const other = await insertSendClient(w.db, "other");
      const theirs = draftArgs({ ...w, client: other });
      await appendDraft(w, theirs, other);
      const mine = draftArgs(w);
      await appendDraft(w, mine);
      const call = (draft: string, phase: string) =>
        readAs(w.db, w.client.token, (query) => query("select ledger.gate_facts($1::text, $2::text)", [draft, phase]));
      expect(await sqlState(() => call(theirs.id, "draft"))).toBe("42501");
      expect(await sqlState(() => call(mine.id, "send"))).toBe("42501");
      expect(await sqlState(() => call(mine.id, "draft"))).toBeNull();
    }));

  it("disclosureOnly is true for a draft held by disclosure alone and false for one held by another check or made, and false at phase draft", () =>
    withSendWorld(async (w) => {
      const disclosure = await madeDraft(w, {}, ["disclosure"]);
      const other = await madeDraft(w, {}, ["disclosure", "freshness"]);
      const made = await madeDraft(w);
      expect((await factsAsProxy(w, disclosure.id)).draft.disclosureOnly).toBe(true);
      expect((await factsAsProxy(w, other.id)).draft.disclosureOnly).toBe(false);
      expect((await factsAsProxy(w, made.id)).draft.disclosureOnly).toBe(false);
      expect((await factsAsProxy(w, disclosure.id, "draft")).draft.disclosureOnly).toBe(false);
    }));

  it("a sent copy deleted at the source after its sync stops the account for 24 hours and not after; settle --sent lifts it at once", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const send = await sendNow(w, ready);
      const copyFp = hex();
      await finish(w, send, "sent", { sourceFp: copyFp });
      const other = await madeDraft(w, { to: ["other@send-example.test"] });
      // Under 30 minutes: not missing yet.
      expect((await factsAsProxy(w, other.id)).account.copyMissing).toBe(false);
      // The copy came back, then the owner deleted it at the source: no evidence row names it.
      await age(w.db, "ledger.sent_messages", "sent_at", "id = $1", [send], 3600);
      expect((await factsAsProxy(w, other.id)).account.copyMissing).toBe(true);
      await age(w.db, "ledger.sent_messages", "sent_at", "id = $1", [send], 23 * 3600 + 60);
      expect((await factsAsProxy(w, other.id)).account.copyMissing, "after 24 hours").toBe(false);

      // Within the window again, a settle --sent lifts it.
      const second = await readyReply(w, { to: ["second@send-example.test"] });
      const send2 = await sendNow(w, second);
      await finish(w, send2, "sent");
      await age(w.db, "ledger.sent_messages", "sent_at", "id = $1", [send2], 3600);
      expect((await factsAsProxy(w, other.id)).account.copyMissing).toBe(true);
      expect(await settle(w, send2, "sent")).toBe("settled");
      expect((await factsAsProxy(w, other.id)).account.copyMissing).toBe(false);
    }));

  it("a stored copy that names the send clears copyMissing", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const send = await sendNow(w, ready);
      const sourceItemId = `gmail-id:copy-${hex().slice(0, 8)}`;
      const sourceFp = hex();
      await finish(w, send, "sent", { sourceFp });
      await age(w.db, "ledger.sent_messages", "sent_at", "id = $1", [send], 3600);
      expect((await factsAsProxy(w, ready.id)).account.copyMissing).toBe(true);
      await insertMessage(w, {
        direction: "outbound",
        to: ready.to,
        systemOriginated: true,
        sentId: send,
        sourceItemId,
      });
      expect((await factsAsProxy(w, ready.id)).account.copyMissing).toBe(false);
    }));
});

describe("use_only_candidates and first_contacts", { timeout: TIMEOUT }, () => {
  const candidates = (w: SendCtx, draft: string, as: "reader" | "proxy") =>
    as === "reader"
      ? readAs(w.db, w.client.token, (query) =>
          query<{
            claim_id: string;
            cited_item: boolean;
            compartments: string[];
          }>("select claim_id, cited_item, compartments from ledger.use_only_candidates($1::text)", [draft]),
        )
      : proxy<{
          claim_id: string;
          cited_item: boolean;
          compartments: string[];
        }>(w.db, "select claim_id, cited_item, compartments from ledger.use_only_candidates($1::text)", [draft]);

  it("a claim whose thread holds every recipient is not returned; a recipient off the thread returns it, cited or not", () =>
    withSendWorld(async (w) => {
      const seed = seeder(w.db, w.admin);
      const on = "on@send-example.test";
      const off = "off@send-example.test";
      // The claim's message is from `on`.
      const source = await insertMessage(w, { from: on });
      const claim = await seed.claim(OWN, source.evidence);
      const toOn = await madeDraft(w, {
        to: [on],
        refs: [["message", source.id]],
      });
      expect((await candidates(w, toOn.id, "proxy")).map((row) => row.claim_id)).not.toContain(claim);
      const toOff = await madeDraft(w, {
        to: [off],
        refs: [["message", source.id]],
      });
      const rows = await candidates(w, toOff.id, "proxy");
      expect(rows.filter((row) => row.claim_id === claim)).toEqual([
        { claim_id: claim, cited_item: true, compartments: OWN },
      ]);
      const uncited = await madeDraft(w, { to: [off] });
      expect((await candidates(w, uncited.id, "proxy")).filter((row) => row.claim_id === claim)).toEqual([
        { claim_id: claim, cited_item: false, compartments: OWN },
      ]);
    }));

  it("a recipient who sent the claim's message or a later one, one the owner wrote to at or after it, and one with an interaction row for one of them are each on it", () =>
    withSendWorld(async (w) => {
      const seed = seeder(w.db, w.admin);
      const t0 = Date.now() - 10 * 3_600_000;
      const at = (hours: number) => new Date(t0 + hours * 3_600_000).toISOString();
      const thread = `thread-on-${hex().slice(0, 6)}`;
      const source = await insertMessage(w, {
        thread,
        from: "first@send-example.test",
        at: at(0),
      });
      const claim = await seed.claim(OWN, source.evidence);
      await insertMessage(w, {
        thread,
        from: "later@send-example.test",
        at: at(1),
      });
      await insertMessage(w, {
        thread,
        direction: "outbound",
        to: ["written@send-example.test"],
        at: at(2),
      });
      const interacted = "met@send-example.test";
      const entity = await insertPerson(w, interacted);
      await insertInteraction(w, source.evidence, entity);
      for (const to of [
        "first@send-example.test",
        "later@send-example.test",
        "written@send-example.test",
        interacted,
      ]) {
        const d = await madeDraft(w, { to: [to] });
        expect(
          (await candidates(w, d.id, "proxy")).map((row) => row.claim_id),
          to,
        ).not.toContain(claim);
      }
      const d = await madeDraft(w, { to: ["stranger@send-example.test"] });
      expect((await candidates(w, d.id, "proxy")).map((row) => row.claim_id)).toContain(claim);
    }));

  it("a person on the thread only before the claim's message is off it, so the claim is returned", () =>
    withSendWorld(async (w) => {
      const seed = seeder(w.db, w.admin);
      const t0 = Date.now() - 10 * 3_600_000;
      const thread = `thread-before-${hex().slice(0, 6)}`;
      await insertMessage(w, {
        thread,
        from: "early@send-example.test",
        at: new Date(t0).toISOString(),
      });
      const source = await insertMessage(w, {
        thread,
        from: "speaker@send-example.test",
        at: new Date(t0 + 3_600_000).toISOString(),
      });
      const claim = await seed.claim(OWN, source.evidence);
      const d = await madeDraft(w, { to: ["early@send-example.test"] });
      expect((await candidates(w, d.id, "proxy")).map((row) => row.claim_id)).toContain(claim);
    }));

  it("a claim whose item has no thread has that item alone as its thread", () =>
    withSendWorld(async (w) => {
      const seed = seeder(w.db, w.admin);
      const source = await insertMessage(w, {
        thread: null,
        from: "alone@send-example.test",
      });
      const claim = await seed.claim(OWN, source.evidence);
      const to = await madeDraft(w, { to: ["alone@send-example.test"] });
      expect((await candidates(w, to.id, "proxy")).map((row) => row.claim_id)).not.toContain(claim);
      const off = await madeDraft(w, { to: ["elsewhere@send-example.test"] });
      expect((await candidates(w, off.id, "proxy")).map((row) => row.claim_id)).toContain(claim);
    }));

  it("as pi_reader, a claim outside the clearance is not returned; as pi_proxy, it is; and only the caller's own draft is answered", () =>
    withSendWorld(async (w) => {
      const seed = seeder(w.db, w.admin);
      const office = await insertAccount(w.db, w.admin, "office", ["employer:example"]);
      const source = await insertMessage(w, {
        account: office,
        from: "work@send-example.test",
      });
      const claim = await seed.claim(["employer:example"], source.evidence);
      const d = await madeDraft(w, { to: ["stranger@send-example.test"] });
      expect((await candidates(w, d.id, "reader")).map((row) => row.claim_id)).not.toContain(claim);
      expect((await candidates(w, d.id, "proxy")).map((row) => row.claim_id)).toContain(claim);
      const other = await insertSendClient(w.db, "other");
      const theirs = draftArgs({ ...w, client: other });
      await appendDraft(w, theirs, other);
      expect(await sqlState(() => candidates(w, theirs.id, "reader"))).toBe("42501");
    }));

  it("first_contacts returns the recipients with no sent_recipients row of the draft's account, and not those the owner wrote to from it", () =>
    withSendWorld(async (w) => {
      const office = await insertAccount(w.db, w.admin, "office", ["employer:example"]);
      await knownTo(w, ["known@send-example.test"]);
      // Written to from another account only: still a first contact from this one.
      await knownTo(w, ["elsewhere@send-example.test"], office);
      const d = await madeDraft(w, {
        to: ["known@send-example.test", "elsewhere@send-example.test", "new@send-example.test"],
      });
      const first = one(
        await proxy<{ fps: string[] }>(w.db, "select ledger.first_contacts($1::text) as fps", [d.id]),
      ).fps;
      expect([...first].sort()).toEqual(
        [recipient(w.db, "elsewhere@send-example.test").fp, recipient(w.db, "new@send-example.test").fp].sort(),
      );
    }));
});

describe("begin_send: the chain", { timeout: TIMEOUT }, () => {
  it("begin_send writes, in one transaction, the owner's decision, the send's row with every expected column and begun_at, the decision point call at rung 4, and the event sending", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const card = await waitingCard(w, ready.id, author(w.client));
      const decision = await gateSend(w, ready.id, ready.payloadFp);
      const a = beginArgs(ready, decision);
      const pendingCards = one(
        await w.admin<{ n: number }>(
          "select count(*)::int as n from ledger.cards c where (select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) = 'pending'",
        ),
      ).n;
      expect(await begin(w, a)).toBe(a.send);
      const ruling = one(await w.admin("select * from knowledge.owner_decisions where id = $1", [a.ruling]));
      expect(ruling).toMatchObject({
        request_id: a.requestId,
        kind: "send",
        target_kind: "draft",
        target_id: ready.id,
        answer: "clear",
        card_id: card,
        batch: false,
        labels: [],
        details: { firstContact: false, newThread: false, released: [] },
        queue_depth: pendingCards,
        compartments: labelOf(w.client.compartments),
      });
      const row = one(await w.admin("select * from ledger.sent_messages where id = $1", [a.send]));
      expect(row).toMatchObject({
        draft_id: ready.id,
        ruling_id: a.ruling,
        decision_id: decision,
        source_account_id: w.account.id,
        recipient_fps: ready.recipientFps,
        payload_fp: ready.payloadFp,
        body_fp: ready.bodyFp,
        created_by: "owner",
        request_id: a.requestId,
        source_item_fp: null,
        thread_fp: null,
        sent_at: null,
      });
      expect(row.begun_at).toBeInstanceOf(Date);
      expect(await events(w, "send", a.send)).toEqual(["sending"]);
      const call = one(
        await w.admin("select * from ledger.decision_point_calls where id = $1", [`dpc_${a.send.slice(4)}`]),
      );
      expect(call).toMatchObject({
        point: "send_clear",
        rung: 4,
        output: "clear",
        effect: "clear_external_move",
        effect_class: "external",
        subject_kind: "send",
        subject_id: a.send,
        request_id: a.requestId,
      });
      // N25: its input hash is the hash of ids, words, booleans and a count.
      const expected = one(
        await w.admin<{ h: string }>(
          "select encode(sha256(convert_to(jsonb_build_object('draft', $1::text, 'send', $2::text, 'point', 'send_clear', 'firstContact', false, 'newThread', false, 'released', 0)::text, 'UTF8')), 'hex') as h",
          [ready.id, a.send],
        ),
      ).h;
      expect(call.input_hash).toBe(expected);
    }));

  it("begin_send refuses another role's session, phase draft, another draft's decision, another fingerprint, a decision 61 seconds old, and one false row, each with null and nothing written", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const other = await readyReply(w, { to: ["other@send-example.test"] });
      // Phase draft: a decision the proxy wrote at phase draft for a fresh draft of the same text.
      const draftPhase = ready.decision;
      const otherDecision = await gateSend(w, other.id, other.payloadFp);
      const wrongFp = await gateSend(w, ready.id, hex());
      const old = await gateSend(w, ready.id, ready.payloadFp);
      await age(w.db, "ledger.gate_checks", "created_at", "decision_id = $1", [old], 61);
      const falseRow = await gateSend(w, ready.id, ready.payloadFp, ["consent"]);
      for (const decision of [draftPhase, otherDecision, wrongFp, old, falseRow])
        await nullQuietly(w, () => begin(w, beginArgs(ready, decision)));
      // Another role: the reader cannot call it at all, and the admin neither.
      const good = await gateSend(w, ready.id, ready.payloadFp);
      expect(
        await refusedQuietly(w, () =>
          readAs(w.db, w.client.token, (query) => beginWith(query, beginArgs(ready, good))),
        ),
      ).toBe("42501");
      expect(
        await refusedQuietly(w, () => session(w.db.urls.admin, (query) => beginWith(query, beginArgs(ready, good)))),
      ).toBe("42501");
      // The positive control.
      const a = beginArgs(ready, good);
      expect(await begin(w, a)).toBe(a.send);
    }));

  it("a suppression added after the decision, a belief whose state changed and a later message on the thread each make begin_send null with nothing written; a draft one minute older than when the gate ran, and a sync one minute older, do not", () =>
    withSendWorld(async (w) => {
      const seed = seeder(w.db, w.admin);
      // Suppression.
      const one1 = await readyReply(w, { to: ["sup@send-example.test"] });
      const d1 = await gateSend(w, one1.id, one1.payloadFp);
      await suppress(w, recipient(w.db, "sup@send-example.test").fp);
      await nullQuietly(w, () => begin(w, beginArgs(one1, d1)));
      // A belief that moved.
      const cited = await insertMessage(w);
      const claim = await seed.claim(OWN, cited.evidence);
      await logClaimState(w, claim, sha256("state before"));
      const two = await readyReply(w, {
        to: ["bel@send-example.test"],
        refs: [["message", cited.id]],
      });
      const d2 = await gateSend(w, two.id, two.payloadFp);
      await logClaimState(w, claim, sha256("state after"));
      await nullQuietly(w, () => begin(w, beginArgs(two, d2)));
      // A later message on the thread.
      const three = await readyReply(w, { to: ["thr@send-example.test"] });
      const d3 = await gateSend(w, three.id, three.payloadFp);
      const later = await insertMessage(w, { at: new Date().toISOString() });
      await w.admin("update knowledge.messages set thread_fp = $2 where id = $1", [later.id, three.message.threadFp]);
      await w.admin("update vault.evidence_items set thread_fp = $2 where id = $1", [
        later.evidence,
        three.message.threadFp,
      ]);
      await nullQuietly(w, () => begin(w, beginArgs(three, d3)));
      // The ages apart: the draft and the sync a minute older than when the gate ran.
      const four = await readyReply(w, { to: ["age@send-example.test"] });
      const d4 = await gateSend(w, four.id, four.payloadFp);
      await age(w.db, "ledger.drafts", "created_at", "id = $1", [four.id], 60);
      await age(w.db, "vault.source_accounts", "last_sync_at", "id = $1", [w.account.id], 60);
      const a = beginArgs(four, d4);
      expect(await begin(w, a)).toBe(a.send);
    }));

  it("a null syncAgeSeconds stays null on both sides of the comparison", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      await syncedAt(w, w.account, 5, "token_failed");
      // The gate's own rows are the caller's; the facts it stored hold a null sync age.
      const decision = await gateSend(w, ready.id, ready.payloadFp);
      const stored = one(
        await w.admin<{ facts: GateFacts }>("select facts from ledger.gate_checks where decision_id = $1 limit 1", [
          decision,
        ]),
      ).facts;
      expect(stored.account.syncAgeSeconds).toBeNull();
      // A sync that ends ok since the gate ran moves the fact: begin_send sees it.
      await syncedAt(w, w.account, 1, "ok");
      await nullQuietly(w, () => begin(w, beginArgs(ready, decision)));
    }));

  it("the chain, one test for each link: Send to draft, Draft to work, Trusted basis, Once, Switch, Vetoes, Confirmations and Gate each return null and write nothing", () =>
    withSendWorld(async (w) => {
      const seed = seeder(w.db, w.admin);
      // Send to draft: tainted; not made (held by another check); another fingerprint.
      const tainted = await readyReply(w, { to: ["t@send-example.test"] });
      const dt = await gateSend(w, tainted.id, tainted.payloadFp);
      await session(w.db.urls.bootstrap, async (query) => {
        await query("begin");
        await query("set local role pi_owner");
        await query("update ledger.drafts set tainted_at = now() where id = $1", [tainted.id]);
        await query("commit");
      });
      await nullQuietly(w, () => begin(w, beginArgs(tainted, dt)));
      const held = await readyReply(w, {
        to: ["h@send-example.test"],
        failed: ["freshness"],
      });
      await beginNull(w, held);
      // Draft to work: an opportunity with no go, and a tainted one.
      const noGo = await readyReply(w, {
        to: ["n@send-example.test"],
        opportunity: await opportunity(w, "reply", "go", "no_go"),
      });
      await beginNull(w, noGo);
      // Trusted basis: a flagged ref (withheld) and a missing one.
      const withheld = await insertMessage(w);
      await seed.pipelineItem(OWN, withheld.evidence);
      const flagged = await readyReply(w, {
        to: ["f@send-example.test"],
        refs: [["message", withheld.id]],
      });
      await w.admin("update vault.pipeline_items set withheld = true where evidence_id = $1", [withheld.evidence]);
      await beginNull(w, flagged);
      // Switch.
      const sw = await readyReply(w, { to: ["s@send-example.test"] });
      const dsw = await gateSend(w, sw.id, sw.payloadFp);
      await killSwitch(w, "on");
      await nullQuietly(w, () => begin(w, beginArgs(sw, dsw)));
      await killSwitch(w, "off");
      // Vetoes (the facts moved too, so the gate link also fails: either way null).
      const vt = await readyReply(w, { to: ["v@send-example.test"] });
      const dvt = await gateSend(w, vt.id, vt.payloadFp);
      await veto(w, "person", [recipient(w.db, "v@send-example.test").fp]);
      await nullQuietly(w, () => begin(w, beginArgs(vt, dvt)));
      // Confirmations: a first contact without its flag; a new thread without its flag.
      const fc = await madeDraft(w, {
        to: ["firstever@send-example.test"],
        replyTo: (await insertMessage(w, { from: "firstever@send-example.test" })).id,
      });
      const dfc = await gateSend(w, fc.id, fc.payloadFp);
      await nullQuietly(w, () => begin(w, beginArgs(fc, dfc, { point: "send_first_contact" })));
      // The positive control after all: the clean one sends; and the first contact with its flag.
      const fcSend = beginArgs(fc, dfc, {
        point: "send_first_contact",
        firstContact: true,
      });
      expect(await begin(w, fcSend)).toBe(fcSend.send);
      expect(await events(w, "send", fcSend.send)).toEqual(["sending"]);
    }));

  it("a first contact without first_contact, and a new thread without new_thread, are refused; a flag given where it is not needed is accepted and recorded; point is send_first_contact exactly when a recipient is a first contact, and the other is refused", () =>
    withSendWorld(async (w) => {
      await connectForSend(w, w.account);
      await syncedAt(w, w.account, 5);
      await knownTo(w, ["known@send-example.test"]);
      const fresh = await madeDraft(w, { to: ["known@send-example.test"] });
      const d = await gateSend(w, fresh.id, fresh.payloadFp);
      await nullQuietly(w, () => begin(w, beginArgs(fresh, d)));
      // A first contact's point given for a known recipient is refused.
      await nullQuietly(w, () =>
        begin(
          w,
          beginArgs(fresh, d, {
            newThread: true,
            point: "send_first_contact",
            firstContact: true,
          }),
        ),
      );
      const a = beginArgs(fresh, d, { newThread: true, firstContact: true });
      expect(await begin(w, a)).toBe(a.send);
      expect(
        one(
          await w.admin<{ details: unknown }>("select details from knowledge.owner_decisions where id = $1", [
            a.ruling,
          ]),
        ).details,
      ).toEqual({ firstContact: true, newThread: true, released: [] });

      const first = await madeDraft(w, { to: ["stranger@send-example.test"] });
      const d2 = await gateSend(w, first.id, first.payloadFp);
      await nullQuietly(w, () => begin(w, beginArgs(first, d2, { newThread: true })));
      await nullQuietly(w, () =>
        begin(
          w,
          beginArgs(first, d2, {
            newThread: true,
            firstContact: true,
            point: "send_clear",
          }),
        ),
      );
      const b = beginArgs(first, d2, {
        newThread: true,
        firstContact: true,
        point: "send_first_contact",
      });
      expect(await begin(w, b)).toBe(b.send);
      expect(
        one(
          await w.admin<{ effect: string }>("select effect from ledger.decision_point_calls where id = $1", [
            `dpc_${b.send.slice(4)}`,
          ]),
        ).effect,
      ).toBe("first_contact");
    }));

  it("a draft whose only untrusted ref is unscreened is begun; one with a withheld ref, a held ref or a flagged agent record is null with nothing written", () =>
    withSendWorld(async (w) => {
      const seed = seeder(w.db, w.admin);
      const unscreened = await insertMessage(w);
      const ok = await readyReply(w, {
        to: ["u@send-example.test"],
        refs: [["message", unscreened.id]],
      });
      const withheld = await insertMessage(w);
      await seed.pipelineItem(OWN, withheld.evidence);
      const wd = await readyReply(w, {
        to: ["w@send-example.test"],
        refs: [["message", withheld.id]],
      });
      await w.admin("update vault.pipeline_items set withheld = true where evidence_id = $1", [withheld.evidence]);
      const heldMsg = await insertMessage(w);
      const hd = await readyReply(w, {
        to: ["x@send-example.test"],
        refs: [["message", heldMsg.id]],
      });
      await w.admin("update knowledge.messages set held = true where id = $1", [heldMsg.id]);
      for (const d of [wd, hd]) await beginNull(w, d);
      const a = beginArgs(ok, await gateSend(w, ok.id, ok.payloadFp));
      expect(await begin(w, a)).toBe(a.send);
    }));

  it("a held draft whose phase-draft decision failed disclosure alone is begun with a non-empty released list and refused without one; a draft held by any other check is refused with one", () =>
    withSendWorld(async (w) => {
      const released = [hex()];
      const disclosure = await readyReply(w, {
        to: ["d@send-example.test"],
        failed: ["disclosure"],
      });
      expect(await latest(w, "draft", disclosure.id)).toBe("held");
      const d1 = await gateSend(w, disclosure.id, disclosure.payloadFp);
      await nullQuietly(w, () => begin(w, beginArgs(disclosure, d1)));
      const a = beginArgs(disclosure, d1, { released });
      expect(await begin(w, a)).toBe(a.send);
      expect(
        one(
          await w.admin<{ details: unknown }>("select details from knowledge.owner_decisions where id = $1", [
            a.ruling,
          ]),
        ).details,
      ).toEqual({ firstContact: false, newThread: false, released });
      // A finish of the held draft's send writes the draft's event sent.
      expect(await finish(w, a.send, "sent")).toBe(true);
      expect(await latest(w, "draft", disclosure.id)).toBe("sent");

      const both = await readyReply(w, {
        to: ["b@send-example.test"],
        failed: ["disclosure", "consent"],
      });
      await beginNull(w, both, { released });
      // A released id that is not a claim id's form is a bad request.
      const again = await readyReply(w, {
        to: ["c@send-example.test"],
        failed: ["disclosure"],
      });
      const dAgain = await gateSend(w, again.id, again.payloadFp);
      expect(await refusedQuietly(w, () => begin(w, beginArgs(again, dAgain, { released: ["not a claim id"] })))).toBe(
        "22023",
      );
    }));

  it("a send row with no ruling is refused", () =>
    withSendWorld(async (w) => {
      const d = await madeDraft(w);
      const insert = (ruling: string | null) =>
        session(w.db.urls.bootstrap, async (query) => {
          await query("begin");
          try {
            await query("set local role pi_owner");
            if (ruling !== null) {
              await query(
                "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'send', 0, '{}', '{}', now(), '{own}')",
                [ruling, testId("req")],
              );
            }
            await query(
              `insert into ledger.sent_messages (id, request_id, created_at, created_by, compartments, draft_id, ruling_id, decision_id, source_account_id, recipient_fps, payload_fp, body_fp, begun_at)
               values ($1, $2, now(), 'owner', '{own}', $3, $4, $5, $6, $7, $8, $9, now())`,
              [
                testId("snt"),
                testId("req"),
                d.id,
                ruling,
                d.decision,
                w.account.id,
                d.recipientFps,
                d.payloadFp,
                d.bodyFp,
              ],
            );
          } finally {
            await query("rollback");
          }
        });
      expect(await sqlState(() => insert(null))).toBe("23502");
      expect(await sqlState(() => insert(testId("rul")))).toBeNull();
    }));

  it("two begin_send calls at once begin one send; begin_send for two drafts with one text and one set of recipients, at once, begins one send", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const [d1, d2] = [await gateSend(w, ready.id, ready.payloadFp), await gateSend(w, ready.id, ready.payloadFp)];
      const answers = await Promise.all([begin(w, beginArgs(ready, d1)), begin(w, beginArgs(ready, d2))]);
      expect(answers.filter((answer) => answer !== null)).toHaveLength(1);
      expect(await count(w, "ledger.sent_messages", "draft_id = $1", [ready.id])).toBe(1);

      const message = await insertMessage(w, {
        from: "twin@send-example.test",
      });
      await knownTo(w, ["twin@send-example.test"]);
      const bodyFp = hex();
      const a = await madeDraft(w, {
        to: ["twin@send-example.test"],
        replyTo: message.id,
        bodyFp,
      });
      const b = await madeDraft(w, {
        to: ["twin@send-example.test"],
        replyTo: message.id,
        bodyFp,
      });
      const [ga, gb] = [await gateSend(w, a.id, a.payloadFp), await gateSend(w, b.id, b.payloadFp)];
      const both = await Promise.all([begin(w, beginArgs(a, ga)), begin(w, beginArgs(b, gb))]);
      expect(both.filter((answer) => answer !== null)).toHaveLength(1);
    }));

  it("begin_send is null while a send of the draft is sending, sent or unknown, and not after one failed", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const send = await sendNow(w, ready);
      await beginNull(w, ready);
      await finish(w, send, "unknown");
      await beginNull(w, ready);
      const failing = await readyReply(w, { to: ["f@send-example.test"] });
      const fsend = await sendNow(w, failing);
      expect(await finish(w, fsend, "failed", { status: 400 })).toBe(true);
      const again = beginArgs(failing, await gateSend(w, failing.id, failing.payloadFp));
      expect(await begin(w, again)).toBe(again.send);
      await finish(w, again.send, "sent");
      await beginNull(w, failing);
    }));

  it("a second draft with the first one's body and recipients is refused while the first is sending or unknown, and after it was sent; one made after the first was sent is not", () =>
    withSendWorld(async (w) => {
      const message = await insertMessage(w, {
        from: "twin@send-example.test",
      });
      const bodyFp = hex();
      // The account connected and synced, and the recipient written to before.
      await readyReply(w, { to: ["twin@send-example.test"], message });
      const firstDraft = await madeDraft(w, {
        to: ["twin@send-example.test"],
        replyTo: message.id,
        bodyFp,
      });
      const second = await madeDraft(w, {
        to: ["twin@send-example.test"],
        replyTo: message.id,
        bodyFp,
      });
      const send = await sendNow(w, firstDraft);
      await beginNull(w, second);
      await finish(w, send, "unknown");
      await beginNull(w, second);
      expect(await settle(w, send, "sent")).toBe("settled");
      await beginNull(w, second);
      // One made after the first was sent.
      await age(w.db, "ledger.record_events", "at", "row_kind = 'send' and row_id = $1", [send], 60);
      await age(w.db, "ledger.sent_messages", "begun_at", "id = $1", [send], 60);
      const third = await madeDraft(w, {
        to: ["twin@send-example.test"],
        replyTo: message.id,
        bodyFp,
      });
      const a = beginArgs(third, await gateSend(w, third.id, third.payloadFp));
      expect(await begin(w, a)).toBe(a.send);
    }));

  it("a veto that commits before begin_send stops it", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const decision = await gateSend(w, ready.id, ready.payloadFp);
      await veto(w, "organization", [recipient(w.db, ready.to[0] ?? "").domainFp]);
      await nullQuietly(w, () => begin(w, beginArgs(ready, decision)));
    }));

  it("an expired or done opportunity fails authority with work_closed and begin_send refuses it; a claimed one is open", () =>
    withSendWorld(async (w) => {
      for (const status of ["expired", "done"]) {
        const opp = await opportunity(w, "reply", "handed_to_owner");
        await opportunityStatus(w, opp, status);
        const d = await readyReply(w, {
          to: [`${status}@send-example.test`],
          opportunity: opp,
        });
        expect((await factsAsProxy(w, d.id)).work).toMatchObject({
          go: true,
          open: false,
        });
        await beginNull(w, d);
      }
      const claimed = await opportunity(w, "reply", "claimed");
      const c = await readyReply(w, {
        to: ["claimed@send-example.test"],
        opportunity: claimed,
      });
      expect((await factsAsProxy(w, c.id)).work).toMatchObject({
        go: true,
        open: true,
      });
      const a = beginArgs(c, await gateSend(w, c.id, c.payloadFp));
      expect(await begin(w, a)).toBe(a.send);
    }));

  it("a repeated request id returns the first send's id and writes nothing", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const decision = await gateSend(w, ready.id, ready.payloadFp);
      const a = beginArgs(ready, decision);
      expect(await begin(w, a)).toBe(a.send);
      const before = await watched(w.db);
      expect(
        await begin(w, {
          ...beginArgs(ready, decision),
          requestId: a.requestId,
        }),
      ).toBe(a.send);
      expect(await watched(w.db)).toEqual(before);
    }));
});

describe("finish_send and settle_send", { timeout: TIMEOUT }, () => {
  it("finish_send sent fills the three columns once, writes the send's and the draft's event sent, the waiting card's event decided, and the opportunity's done when send is the last stage of its kind", () =>
    withSendWorld(async (w) => {
      const opp = await opportunity(w, "reply", "handed_to_owner");
      const ready = await readyReply(w, { opportunity: opp });
      const card = await waitingCard(w, ready.id, author(w.client));
      const send = await sendNow(w, ready);
      const [sourceFp, threadFp] = [hex(), hex()];
      expect(await finish(w, send, "sent", { sourceFp, threadFp })).toBe(true);
      expect(
        one(
          await w.admin(
            "select source_item_fp, thread_fp, sent_at is not null as at from ledger.sent_messages where id = $1",
            [send],
          ),
        ),
      ).toEqual({ source_item_fp: sourceFp, thread_fp: threadFp, at: true });
      expect(await latest(w, "send", send)).toBe("sent");
      expect(await latest(w, "draft", ready.id)).toBe("sent");
      expect(await latest(w, "card", card)).toBe("decided");
      expect(await latest(w, "opportunity", opp)).toBe("done");
      // A second finish is false and changes nothing: the fill is once.
      const before = await watched(w.db);
      expect(await finish(w, send, "sent", { sourceFp: hex() })).toBe(false);
      expect(await watched(w.db)).toEqual(before);
    }));

  it("finish_send writes done from handed_to_owner and nothing from claimed", () =>
    withSendWorld(async (w) => {
      const claimed = await opportunity(w, "reply", "claimed");
      const ready = await readyReply(w, { opportunity: claimed });
      const send = await sendNow(w, ready);
      await finish(w, send, "sent");
      expect(await latest(w, "opportunity", claimed)).toBe("claimed");
      // An opportunity whose last stage is not send (investigate has none) stays as it was.
      const investigate = await opportunity(w, "investigate", "handed_to_owner");
      const other = await readyReply(w, {
        to: ["inv@send-example.test"],
        opportunity: investigate,
      });
      // consent fails for investigate at the gate, but the proxy's rows are its own: pass them all.
      const s2 = await sendNow(w, other);
      await finish(w, s2, "sent");
      expect(await latest(w, "opportunity", investigate)).toBe("handed_to_owner");
    }));

  it("finish_send failed writes the send's event with its status, and the draft stays made; unknown writes the send's event and nothing else; it is false for a send that is not sending", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const send = await sendNow(w, ready);
      expect(await finish(w, send, "failed", { status: 403 })).toBe(true);
      expect(
        one(
          await w.admin<{ event: string; code: string }>(
            "select event, code from ledger.record_events where row_kind = 'send' and row_id = $1 order by id desc limit 1",
            [send],
          ),
        ),
      ).toEqual({
        event: "failed",
        code: "status_403",
      });
      expect(await latest(w, "draft", ready.id)).toBe("made");
      expect(await finish(w, send, "sent")).toBe(false);

      const second = await readyReply(w, { to: ["two@send-example.test"] });
      const s2 = await sendNow(w, second);
      const before = await count(w, "ledger.record_events");
      expect(await finish(w, s2, "unknown")).toBe(true);
      expect(await count(w, "ledger.record_events")).toBe(before + 1);
      expect(await latest(w, "send", s2)).toBe("unknown");
      expect(await latest(w, "draft", second.id)).toBe("made");
    }));

  it("finish_send writes the draft's event only when the draft is still made, and the card's only when it is pending", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const card = await waitingCard(w, ready.id, author(w.client));
      const send = await sendNow(w, ready);
      // The owner rejected the draft while it was sending, and the card was answered.
      await w.admin(
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('draft', $1, 'rejected', now(), 'owner', '{own}')",
        [ready.id],
      );
      await w.admin(
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'decided', now(), 'owner', '{own}')",
        [card],
      );
      await finish(w, send, "sent");
      expect(await events(w, "draft", ready.id)).toEqual(["made", "rejected"]);
      expect(await events(w, "card", card)).toEqual(["pending", "decided"]);
    }));

  it("a card taken out of pending by finish_send or settle_send admits the author's oldest deferred card; a deferred card of a sent draft is withdrawn", () =>
    withSendWorld(async (w) => {
      const who = author(w.client);
      // Ten pending cards of the author fill its queue, so the next is deferred.
      const filler = [];
      for (let index = 0; index < 9; index += 1) {
        const id = testId("crd");
        await w.admin(
          "insert into ledger.cards (id, request_id, created_at, created_by, kind, options, compartments) values ($1, $2, now(), $3, 'notice', '{acknowledge}', '{own}')",
          [id, testId("req"), who],
        );
        await w.admin(
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'pending', now(), 'system:test', '{own}')",
          [id],
        );
        filler.push(id);
      }
      const ready = await readyReply(w);
      const card = await waitingCard(w, ready.id, who, "pending");
      const waiting = await deferredCard(w, who);
      const send = await sendNow(w, ready);
      await finish(w, send, "sent");
      expect(await latest(w, "card", card)).toBe("decided");
      expect(await latest(w, "card", waiting)).toBe("pending");

      // settle_send of an unknown send does the same. The admitted card fills the queue again,
      // so one filler card is acknowledged first: nine pending and the waiting card make ten.
      await w.admin(
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'decided', now(), 'system:test', '{own}')",
        [filler[0]],
      );
      const second = await readyReply(w, { to: ["two@send-example.test"] });
      const card2 = await waitingCard(w, second.id, who, "pending");
      const waiting2 = await deferredCard(w, who);
      const s2 = await sendNow(w, second);
      await finish(w, s2, "unknown");
      expect(await settle(w, s2, "sent")).toBe("settled");
      expect(await latest(w, "card", card2)).toBe("decided");
      expect(await latest(w, "card", waiting2)).toBe("pending");

      // A deferred card of a sent draft is withdrawn.
      const third = await readyReply(w, { to: ["three@send-example.test"] });
      const deferredWaiting = await waitingCard(w, third.id, who, "deferred");
      const s3 = await sendNow(w, third);
      await finish(w, s3, "sent");
      expect(await latest(w, "card", deferredWaiting)).toBe("withdrawn");
    }));

  it("finish_send and settle_send lock the draft, its card, the author's word and the opportunity before they read, and a tick expiring the opportunity at once leaves one outcome", () =>
    withSendWorld(async (w) => {
      for (const which of ["finish", "settle"] as const) {
        const opp = await opportunity(w, "reply", "handed_to_owner");
        const ready = await readyReply(w, {
          to: [`${which}@send-example.test`],
          opportunity: opp,
        });
        const card = await waitingCard(w, ready.id, author(w.client));
        const send = await sendNow(w, ready);
        if (which === "settle") await finish(w, send, "unknown");
        // The tick holds the same locks, expires the opportunity and the card, and commits.
        const tick = await holding(w.db.urls.work, [
          ["select ledger.lock_rows($1::text[])", [[ready.id, card, `author:${author(w.client)}`, opp]]],
          [
            "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('opportunity', $1, 'expired', now(), 'system:tick', '{own}')",
            [opp],
          ],
          [
            "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'expired', now(), 'system:tick', '{own}')",
            [card],
          ],
        ]);
        const call = which === "finish" ? finish(w, send, "sent") : settle(w, send, "sent");
        expect(await pending(call), which).toBe(true);
        await tick.release();
        await call;
        // One terminal status each: the tick's.
        expect(
          (await events(w, "opportunity", opp)).filter((event) => event === "done" || event === "expired"),
        ).toEqual(["expired"]);
        expect((await events(w, "card", card)).filter((event) => event !== "pending")).toEqual(["expired"]);
      }
    }));

  it("a sending send younger than two minutes is not_settleable, and older is settled", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const send = await sendNow(w, ready);
      const before = await watched(w.db);
      expect(await settle(w, send, "sent")).toBe("not_settleable");
      expect(await watched(w.db)).toEqual(before);
      await age(w.db, "ledger.sent_messages", "begun_at", "id = $1", [send], 121);
      expect(await settle(w, send, "sent")).toBe("settled");
      expect(await latest(w, "send", send)).toBe("sent");
    }));

  it("an unknown send settled sent writes a send_settle decision and the events finish_send writes for sent, with no fill", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const card = await waitingCard(w, ready.id, author(w.client));
      const send = await sendNow(w, ready);
      await finish(w, send, "unknown");
      const ruling = testId("rul");
      const requestId = testId("req");
      expect(await settle(w, send, "sent", requestId, ruling)).toBe("settled");
      expect(
        one(
          await w.admin(
            "select kind, target_kind, target_id, answer, details, request_id from knowledge.owner_decisions where id = $1",
            [ruling],
          ),
        ),
      ).toEqual({
        kind: "send_settle",
        target_kind: "send",
        target_id: send,
        answer: "sent",
        details: {},
        request_id: requestId,
      });
      expect(await latest(w, "send", send)).toBe("sent");
      expect(await latest(w, "draft", ready.id)).toBe("sent");
      expect(await latest(w, "card", card)).toBe("decided");
      expect(
        one(await w.admin("select source_item_fp, thread_fp, sent_at from ledger.sent_messages where id = $1", [send])),
      ).toEqual({ source_item_fp: null, thread_fp: null, sent_at: null });
      // A repeated request id answers settled and writes nothing.
      const before = await watched(w.db);
      expect(await settle(w, send, "sent", requestId)).toBe("settled");
      expect(await watched(w.db)).toEqual(before);
    }));

  it("not_sent before a good sync that ended after begun_at is sync_pending, and after one it writes the decision and failed, and the draft can be begun again", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const send = await sendNow(w, ready);
      await finish(w, send, "unknown");
      // The last good sync started before the send began.
      await syncedAt(w, w.account, 600);
      const before = await watched(w.db);
      expect(await settle(w, send, "not_sent")).toBe("sync_pending");
      expect(await watched(w.db)).toEqual(before);
      // N16: a sync that started after the send began, but did not end ok, does not count.
      await w.admin(
        "update vault.source_accounts set last_sync_at = now(), last_outcome = 'token_failed' where id = $1",
        [w.account.id],
      );
      expect(await settle(w, send, "not_sent")).toBe("sync_pending");
      await w.admin("update vault.source_accounts set last_sync_at = now(), last_outcome = 'ok' where id = $1", [
        w.account.id,
      ]);
      expect(await settle(w, send, "not_sent")).toBe("settled");
      expect(await latest(w, "send", send)).toBe("failed");
      expect(await latest(w, "draft", ready.id)).toBe("made");
      const again = beginArgs(ready, await gateSend(w, ready.id, ready.payloadFp));
      expect(await begin(w, again)).toBe(again.send);
    }));

  it("settle --not-sent of a send whose copy is stored is not_settleable", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const send = await sendNow(w, ready);
      await finish(w, send, "unknown");
      await syncedAt(w, w.account, 0);
      await insertMessage(w, {
        direction: "outbound",
        to: ready.to,
        systemOriginated: true,
        sentId: send,
      });
      expect(await settle(w, send, "not_sent")).toBe("not_settleable");
      expect(await settle(w, send, "sent")).toBe("settled");
    }));

  it("a sent send whose copy is missing is settled by sent, which clears copyMissing, and not_sent is not_settleable; a sent, failed or settled send is otherwise not_settleable", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const send = await sendNow(w, ready);
      await finish(w, send, "sent");
      await age(w.db, "ledger.sent_messages", "sent_at", "id = $1", [send], 3600);
      expect(await settle(w, send, "not_sent")).toBe("not_settleable");
      const events1 = await events(w, "send", send);
      expect(await settle(w, send, "sent")).toBe("settled");
      // The decision alone settles a missing copy: no new event.
      expect(await events(w, "send", send)).toEqual(events1);
      expect((await factsAsProxy(w, ready.id)).account.copyMissing).toBe(false);
      expect(await settle(w, send, "sent")).toBe("not_settleable");

      const failing = await readyReply(w, { to: ["f@send-example.test"] });
      const fsend = await sendNow(w, failing);
      await finish(w, fsend, "failed");
      expect(await settle(w, fsend, "sent")).toBe("not_settleable");
      expect(await settle(w, fsend, "not_sent")).toBe("not_settleable");
    }));

  it("begin_send and settle_send write their owner decision under the ruling id handed in", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const decision = await gateSend(w, ready.id, ready.payloadFp);
      const a = beginArgs(ready, decision);
      await begin(w, a);
      expect(await count(w, "knowledge.owner_decisions", "id = $1 and kind = 'send'", [a.ruling])).toBe(1);
      await finish(w, a.send, "unknown");
      const ruling = testId("rul");
      await settle(w, a.send, "sent", testId("req"), ruling);
      expect(await count(w, "knowledge.owner_decisions", "id = $1 and kind = 'send_settle'", [ruling])).toBe(1);
    }));

  it("finish_send and settle_send refuse every role but pi_proxy", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const send = await sendNow(w, ready);
      for (const url of [w.db.urls.admin, w.db.urls.writer, w.db.urls.work]) {
        expect(
          await sqlState(() =>
            queryAs(url, "select ledger.finish_send($1::text, 'sent', 200, $2::text, null)", [send, hex()]),
          ),
        ).toBe("42501");
        expect(
          await sqlState(() =>
            queryAs(url, "select ledger.settle_send($1::text, $2::text, 'sent', $3::text)", [
              send,
              testId("rul"),
              testId("req"),
            ]),
          ),
        ).toBe("42501");
      }
      expect(await finish(w, send, "sent")).toBe(true);
    }));
});

describe("taint_citing and drafts", { timeout: TIMEOUT }, () => {
  it("taint_citing clears a draft's body, sets tainted_at, clears reply_to_evidence_id for the gone evidence, and withdraws its card", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const card = await waitingCard(w, ready.id, author(w.client));
      const untouched = await readyReply(w, {
        to: ["other@send-example.test"],
      });
      await deleteMessage(w, ready.message);
      await queryAs(w.db.urls.writer, "select ledger.taint_citing($1::text[], array['message'], array[$2::text])", [
        [ready.message.evidence],
        ready.message.id,
      ]);
      const row = await draftRow(w, ready.id);
      expect(row.tainted_at).toBeInstanceOf(Date);
      expect(row.body_enc).toBeNull();
      expect(row.reply_to_evidence_id).toBeNull();
      expect(await latest(w, "card", card)).toBe("withdrawn");
      // The other draft is as it was.
      expect(await draftRow(w, untouched.id)).toMatchObject({
        tainted_at: null,
        reply_to_evidence_id: untouched.message.evidence,
      });
      // A tainted draft cannot be begun.
      await beginNull(w, ready);
    }));

  it("owner-surface's decide refuses, not_pending, a card whose draft target is tainted, and decides one whose draft is not", () =>
    withSendWorld(async (w) => {
      const admin = createAdmin({
        url: w.db.urls.admin,
        keys: w.db.keys,
        log: { info: () => {}, warn: () => {}, error: () => {} },
      });
      try {
        const notice = async (draft: string): Promise<CardId> => {
          const id = testId("crd") as CardId;
          await w.admin(
            `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, compartments) values ($1, $2, now(), 'system:test', 'notice', 'draft', $3, '{acknowledge}', '{own}')`,
            [id, testId("req"), draft],
          );
          await w.admin(
            "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'pending', now(), 'system:test', '{own}')",
            [id],
          );
          return id;
        };
        const clean = await readyReply(w);
        const dirty = await readyReply(w, { to: ["dirty@send-example.test"] });
        const [cleanCard, dirtyCard] = [await notice(clean.id), await notice(dirty.id)];
        await session(w.db.urls.bootstrap, async (query) => {
          await query("begin");
          await query("set local role pi_owner");
          await query("update ledger.drafts set tainted_at = now() where id = $1", [dirty.id]);
          await query("commit");
        });
        await expect(
          admin.cards.decide({
            cards: [dirtyCard],
            answer: "acknowledge",
            requestId: testId("req"),
          }),
        ).rejects.toMatchObject({ code: "not_pending" });
        expect(
          await admin.cards.decide({
            cards: [cleanCard],
            answer: "acknowledge",
            requestId: testId("req"),
          }),
        ).toHaveLength(1);
      } finally {
        await admin.close();
      }
    }));

  it("a draft whose session read a deleted message by id before it was written is tainted, and one written before the read is not", () =>
    withSendWorld(async (w) => {
      const message = await insertMessage(w);
      const before = await madeDraft(w);
      await age(w.db, "ledger.drafts", "created_at", "id = $1", [before.id], 5);
      await logRead(w, message);
      const after = await madeDraft(w);
      // The read stays dated before the second draft.
      await deleteMessage(w, message);
      await queryAs(w.db.urls.writer, "select ledger.taint_citing($1::text[], '{}'::text[], '{}'::text[])", [
        [message.evidence],
      ]);
      expect((await draftRow(w, after.id)).tainted_at).toBeInstanceOf(Date);
      expect((await draftRow(w, before.id)).tainted_at).toBeNull();
    }));

  it("owner-surface's and durable-work's own taint tests run unchanged against this migration: a card of owner-surface's and a work row of durable-work's are still tainted beside a draft", () =>
    withSendWorld(async (w) => {
      const message = await insertMessage(w);
      const d = await madeDraft(w, { refs: [["message", message.id]] });
      const opp = await opportunity(w);
      const about = one(
        await w.admin<{ about_id: string }>("select about_id from ledger.opportunities where id = $1", [opp]),
      ).about_id;
      const aboutEvidence = one(
        await w.admin<{ evidence_id: string }>("select evidence_id from knowledge.messages where id = $1", [about]),
      ).evidence_id;
      const n = one(
        await queryAs<{ n: number }>(
          w.db.urls.writer,
          "select ledger.taint_citing($1::text[], '{}'::text[], '{}'::text[]) as n",
          [[message.evidence, aboutEvidence]],
        ),
      ).n;
      expect(n).toBeGreaterThanOrEqual(2);
      expect((await draftRow(w, d.id)).tainted_at).toBeInstanceOf(Date);
      expect(
        one(
          await w.admin<{ t: boolean }>("select tainted_at is not null as t from ledger.opportunities where id = $1", [
            opp,
          ]),
        ).t,
      ).toBe(true);
      // A second call returns 0 and writes nothing.
      expect(
        one(
          await queryAs<{ n: number }>(
            w.db.urls.writer,
            "select ledger.taint_citing($1::text[], '{}'::text[], '{}'::text[]) as n",
            [[message.evidence, aboutEvidence]],
          ),
        ).n,
      ).toBe(0);
    }));
});

describe("an erased sent copy, and draft_accounts", { timeout: TIMEOUT }, () => {
  it("a sent copy that an erasure removed does not make the copy missing", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const send = await sendNow(w, ready);
      const sourceFp = hex();
      await finish(w, send, "sent", { sourceFp });
      await age(w.db, "ledger.sent_messages", "sent_at", "id = $1", [send], 3600);
      const other = await madeDraft(w, { to: ["other@send-example.test"] });
      // The control: an hour on, with no copy stored, it is missing.
      expect((await factsAsProxy(w, other.id)).account.copyMissing).toBe(true);
      // The erasure's hook clears the copy's source fingerprint: the copy came back and was erased.
      expect(
        one(
          await w.admin<{ n: number }>("select ledger.forget_sent_source($1::text[], $2::text[]) as n", [
            [w.account.id],
            [sourceFp],
          ]),
        ).n,
      ).toBe(1);
      expect((await factsAsProxy(w, other.id)).account.copyMissing).toBe(false);
    }));

  const accounts = (w: SendCtx, token: string | null, replyTo: string | null, label: string | null) =>
    readAs(w.db, token, (query) =>
      query<{ id: string; label: string }>("select id, label from ledger.draft_accounts($1::text, $2::text)", [
        replyTo,
        label,
      ]),
    );

  it("draft_accounts gives the client's google_mail accounts within its clearance, by label when given, ordered by id", () =>
    withSendWorld(async (w) => {
      const second = await insertAccount(w.db, w.admin, "second");
      const office = await insertAccount(w.db, w.admin, "office", ["employer:example"]);
      const mine = [w.account, second]
        .map((a) => ({ id: a.id, label: a.label }))
        .sort((x, y) => (x.id < y.id ? -1 : 1));
      expect(await accounts(w, w.client.token, null, null)).toEqual(mine);
      expect(await accounts(w, w.client.token, null, "second")).toEqual([{ id: second.id, label: "second" }]);
      // An account outside the clearance is never given, by label or otherwise.
      expect(await accounts(w, w.client.token, null, office.label)).toEqual([]);
      // No current client: no row.
      expect(await accounts(w, null, null, null)).toEqual([]);
      expect(await accounts(w, "pit_not-a-token", null, null)).toEqual([]);
    }));

  it("draft_accounts for a reply gives only the answered message's account, and nothing for a held or hidden message", () =>
    withSendWorld(async (w) => {
      await insertAccount(w.db, w.admin, "second");
      const office = await insertAccount(w.db, w.admin, "office", ["employer:example"]);
      const message = await insertMessage(w, {
        from: "rowan@send-example.test",
      });
      expect(await accounts(w, w.client.token, message.id, null)).toEqual([
        { id: w.account.id, label: w.account.label },
      ]);
      // A label beside the reply that is not the message's account gives nothing.
      expect(await accounts(w, w.client.token, message.id, "second")).toEqual([]);
      const held = await insertMessage(w, {
        from: "rowan@send-example.test",
        held: true,
      });
      expect(await accounts(w, w.client.token, held.id, null)).toEqual([]);
      const hidden = await insertMessage(w, { account: office });
      expect(await accounts(w, w.client.token, hidden.id, null)).toEqual([]);
      expect(await accounts(w, w.client.token, "msg_none", null)).toEqual([]);
    }));

  it("draft_accounts is executable by pi_reader alone", () =>
    withSendWorld(async (w) => {
      for (const url of [w.db.urls.admin, w.db.urls.writer, w.db.urls.proxy, w.db.urls.work, w.db.urls.pipeline]) {
        expect(await sqlState(() => queryAs(url, "select * from ledger.draft_accounts(null, null)"))).toBe("42501");
      }
      expect(await sqlState(() => accounts(w, w.client.token, null, null))).toBeNull();
    }));
});

// GateFacts is imported for its parse; labelOf and hex for shapes.
void GateFacts;
