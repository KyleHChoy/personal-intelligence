import type { CardId, DraftId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { sealUnder } from "../core/seal.ts";
import { testId } from "../test-support/clients.ts";
import { one, sqlState } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { eventLogger } from "../test-support/recording.ts";
import {
  age,
  author,
  finish,
  insertMessage,
  labelOf,
  madeDraft,
  readyReply,
  recipient,
  type SendCtx,
  sendNow,
  TIMEOUT,
  veto,
  withSendWorld,
} from "../test-support/send-fixtures.ts";
import { createDispatch, type Dispatch } from "./dispatch.ts";

// The tick's two steps for drafts, as the store's Dispatch writes them under pi_work. Drafts are
// made as the send database's tests make them; the owner's reject goes through the admin's decide.
// Reserved domains only.

const DAY = 86_400_000;

async function withDispatch<T>(w: SendCtx, fn: (dispatch: Dispatch) => Promise<T>): Promise<T> {
  const dispatch = createDispatch({ url: w.db.urls.work, log: eventLogger(), journal: "" }); // The two steps never read the journal.;
  try {
    return await fn(dispatch);
  } finally {
    await dispatch.close();
  }
}

type CardRow = {
  id: CardId;
  kind: string;
  author: string;
  state: string;
  case_key: string | null;
  options: string[];
  expires_at: Date | null;
  body_enc: unknown;
  compartments: string[];
};
const cardsOf = (w: SendCtx, draft: string): Promise<CardRow[]> =>
  w.admin(
    `select c.id, c.kind, c.created_by as author, c.case_key, c.options, c.expires_at, c.body_enc, c.compartments,
       (select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) as state
     from ledger.cards c where c.target_kind = 'draft' and c.target_id = $1 order by c.created_at, c.id`,
    [draft],
  );
const draftState = async (w: SendCtx, draft: string): Promise<string | null> =>
  (
    await w.admin<{ event: string }>(
      "select event from ledger.record_events where row_kind = 'draft' and row_id = $1 order by id desc limit 1",
      [draft],
    )
  )[0]?.event ?? null;

// The tick's step 1 for every draft that waits, as the tick runs it.
async function raiseAll(dispatch: Dispatch, now = new Date()): Promise<(CardId | null)[]> {
  const raised: (CardId | null)[] = [];
  for (const id of await dispatch.draftsWithoutCard()) raised.push(await dispatch.raiseDraftCard(id, now));
  return raised;
}

// Its admin is closed after the one decision: an open pi_admin pool would keep the test
// database from being dropped.
async function reject(w: SendCtx, card: CardId) {
  const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: eventLogger() });
  try {
    return await admin.cards.decide({ cards: [card], answer: "reject", requestId: testId("req") });
  } finally {
    await admin.close();
  }
}

// A source ref of the draft's own: an inbound message cited in its basis.
const sourceRef = async (w: SendCtx): Promise<readonly [string, string]> =>
  ["message", (await insertMessage(w)).id] as const;

describe("the tick's two steps for drafts", { timeout: TIMEOUT }, () => {
  // A draft's card names what it sends and to whom, as the agent wrote them,
  // so the owner's page titles it by its subject; a draft whose body is not a send's names nothing.
  it("a draft's card lines carry its subject and recipients as the agent's", () =>
    withSendWorld((w) =>
      withDispatch(w, async (dispatch) => {
        const id = testId("drf");
        const payload = {
          v: 1,
          account: w.account.id,
          to: ["one@send-example.test"],
          cc: [],
          subject: "Re: the venue",
          body: "Hi",
          thread: null,
        };
        const body = sealUnder(
          w.db.keys,
          labelOf(w.client.compartments),
          { table: "ledger.drafts", id, column: "body_enc" },
          JSON.stringify(payload),
        );
        await madeDraft(w, { id, to: ["one@send-example.test"], body });
        const plain = await madeDraft(w, { to: ["two@send-example.test"] });
        await raiseAll(dispatch);
        const [card] = (await cardsOf(w, id)).map((row) => row.id);
        const [other] = (await cardsOf(w, plain.id)).map((row) => row.id);
        const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: eventLogger() });
        try {
          const lines = (await admin.cards.card(card as CardId))?.lines ?? [];
          expect(lines.filter((line) => line.from !== "code")).toEqual([
            {
              text: "subject: Re: the venue",
              from: "agent",
              key: "draft_subject",
              value: [{ kind: "text", text: "Re: the venue" }],
            },
            {
              text: "to: one@send-example.test",
              from: "agent",
              key: "draft_to",
              value: [{ kind: "text", text: "one@send-example.test" }],
            },
          ]);
          expect(
            ((await admin.cards.card(other as CardId))?.lines ?? []).filter((line) => line.from !== "code"),
          ).toEqual([]);
        } finally {
          await admin.close();
        }
      }),
    ));

  it("a made draft gets one card, authored by its client, and a held one gets none", () =>
    withSendWorld((w) =>
      withDispatch(w, async (dispatch) => {
        const made = await madeDraft(w, { to: ["one@send-example.test"] });
        const held = await madeDraft(w, { to: ["two@send-example.test"] }, ["disclosure"]);
        expect(await dispatch.draftsWithoutCard()).toEqual([made.id]);
        const [card] = await raiseAll(dispatch);
        const [row] = await cardsOf(w, made.id);
        expect(row).toMatchObject({
          id: card,
          kind: "draft_waiting",
          author: author(w.client),
          state: "pending",
          case_key: `draft:${made.id}`,
          options: ["reject", "acknowledge"],
          body_enc: null,
        });
        expect(row?.compartments).toEqual(w.client.compartments);
        // It expires with the draft: its created_at plus seven days.
        const [draft] = await w.admin<{ created_at: Date }>("select created_at from ledger.drafts where id = $1", [
          made.id,
        ]);
        expect(row?.expires_at?.getTime()).toBe((draft?.created_at.getTime() ?? 0) + 7 * DAY);
        expect(await cardsOf(w, held.id)).toEqual([]);
        // A second tick raises nothing more.
        expect(await raiseAll(dispatch)).toEqual([]);
        expect(await cardsOf(w, made.id)).toHaveLength(1);
      }),
    ));

  it("a draft on a vetoed person gets no card", () =>
    withSendWorld((w) =>
      withDispatch(w, async (dispatch) => {
        const draft = await madeDraft(w, { to: ["vetoed@send-example.test"] });
        await veto(w, "person", [recipient(w.db, "vetoed@send-example.test").fp]);
        expect(await raiseAll(dispatch)).toEqual([null]);
        expect(await cardsOf(w, draft.id)).toEqual([]);
        // A domain veto, and one on the kind of work, stop it the same way; the control has none.
        const domain = await madeDraft(w, { to: ["someone@vetoed-domain.test"] });
        await veto(w, "organization", [recipient(w.db, "someone@vetoed-domain.test").domainFp]);
        const plain = await madeDraft(w, { to: ["plain@send-example.test"] });
        await dispatch.raiseDraftCard(domain.id as DraftId, new Date());
        await dispatch.raiseDraftCard(plain.id as DraftId, new Date());
        expect(await cardsOf(w, domain.id)).toEqual([]);
        expect(await cardsOf(w, plain.id)).toHaveLength(1);
      }),
    ));

  it("reject of a draft whose send is sending writes no draft event", () =>
    withSendWorld((w) =>
      withDispatch(w, async (dispatch) => {
        const ready = await readyReply(w, { to: ["sending@send-example.test"] });
        await raiseAll(dispatch);
        const [card] = await cardsOf(w, ready.id);
        await sendNow(w, ready);
        await reject(w, card?.id as CardId);
        expect(await draftState(w, ready.id)).toBe("made");
        // The control: a made draft with no send is rejected.
        const plain = await madeDraft(w, { to: ["plain@send-example.test"] });
        await raiseAll(dispatch);
        const [other] = await cardsOf(w, plain.id);
        await reject(w, other?.id as CardId);
        expect(await draftState(w, plain.id)).toBe("rejected");
      }),
    ));

  it("the eleventh waiting draft of one client is pending: no cap holds it back", () =>
    withSendWorld((w) =>
      withDispatch(w, async (dispatch) => {
        const drafts = [];
        for (let n = 0; n < 11; n += 1) drafts.push(await madeDraft(w, { to: [`n${n}@send-example.test`] }));
        await raiseAll(dispatch);
        const states = [];
        for (const draft of drafts) states.push((await cardsOf(w, draft.id))[0]?.state);
        expect(states.filter((state) => state === "pending")).toHaveLength(11);
      }),
    ));

  it("after reject, a second draft for the same case raises no card, and one whose basis has a new source ref does; a system ref is not one", () =>
    withSendWorld((w) =>
      withDispatch(w, async (dispatch) => {
        const first = await madeDraft(w, { to: ["case@send-example.test"], refs: [await sourceRef(w)] });
        await raiseAll(dispatch);
        await reject(w, (await cardsOf(w, first.id))[0]?.id as CardId);
        // The same case, the same basis: no card.
        const again = await madeDraft(w, { to: ["case@send-example.test"], refs: [] });
        // A system ref: a message the system sent.
        const system = await insertMessage(w, { direction: "outbound", systemOriginated: true });
        const bySystem = await madeDraft(w, { to: ["case@send-example.test"], refs: [["message", system.id]] });
        // A new source ref: a card.
        const news = await madeDraft(w, { to: ["case@send-example.test"], refs: [await sourceRef(w)] });
        await raiseAll(dispatch);
        expect(await cardsOf(w, again.id)).toEqual([]);
        expect(await cardsOf(w, bySystem.id)).toEqual([]);
        expect(await cardsOf(w, news.id)).toHaveLength(1);
        // Another case is not held back by the rejection.
        const other = await madeDraft(w, { to: ["other@send-example.test"] });
        await raiseAll(dispatch);
        expect(await cardsOf(w, other.id)).toHaveLength(1);
      }),
    ));

  it("a draft made seven days ago is expired, one made six days ago is not, and one whose send is sending or unknown is not", () =>
    withSendWorld((w) =>
      withDispatch(w, async (dispatch) => {
        const old = await madeDraft(w, { to: ["old@send-example.test"] });
        const oldHeld = await madeDraft(w, { to: ["held@send-example.test"] }, ["disclosure"]);
        const young = await madeDraft(w, { to: ["young@send-example.test"] });
        const sending = await readyReply(w, { to: ["sending@send-example.test"] });
        await sendNow(w, sending);
        const unknown = await readyReply(w, { to: ["unknown@send-example.test"] });
        await finish(w, await sendNow(w, unknown), "unknown");
        for (const draft of [old, oldHeld, sending, unknown])
          await age(w.db, "ledger.drafts", "created_at", "id = $1", [draft.id], 7 * 86_400 + 60);
        await age(w.db, "ledger.drafts", "created_at", "id = $1", [young.id], 6 * 86_400);
        expect([...(await dispatch.draftsToExpire())].sort()).toEqual([old.id, oldHeld.id].sort());
        for (const id of await dispatch.draftsToExpire()) expect(await dispatch.expireDraft(id)).toBe(true);
        expect(await draftState(w, old.id)).toBe("expired");
        expect(await draftState(w, oldHeld.id)).toBe("expired");
        expect(await draftState(w, young.id)).toBe("made");
        expect(await draftState(w, sending.id)).toBe("made");
        expect(await draftState(w, unknown.id)).toBe("made");
        // Safe to repeat: an expired draft is not expired again.
        expect(await dispatch.expireDraft(old.id as DraftId)).toBe(false);
      }),
    ));

  it("a draft_waiting card expires when its draft does, with no effect", () =>
    withSendWorld((w) =>
      withDispatch(w, async (dispatch) => {
        const draft = await madeDraft(w, { to: ["old@send-example.test"] });
        await raiseAll(dispatch);
        const later = new Date(Date.now() + 7 * DAY + 60_000);
        const items = await dispatch.expired(later);
        const card = (await cardsOf(w, draft.id))[0];
        expect(items).toContainEqual({ kind: "card", card: card?.id });
        for (const item of items) await dispatch.expire(item, later);
        expect((await cardsOf(w, draft.id))[0]?.state).toBe("expired");
        // No effect: the card's expiry writes no draft event.
        expect(await draftState(w, draft.id)).toBe("made");
      }),
    ));

  it("a tainted draft's card is withdrawn by taint_citing, not by the tick, and no new one is raised", () =>
    withSendWorld((w) =>
      withDispatch(w, async (dispatch) => {
        const message = await insertMessage(w);
        const draft = await madeDraft(w, { to: ["taint@send-example.test"], refs: [["message", message.id]] });
        await raiseAll(dispatch);
        await queryAs(w.db.urls.admin, "select ledger.taint_citing($1, '{}', '{}')", [[message.evidence]]);
        expect((await cardsOf(w, draft.id)).map((card) => card.state)).toEqual(["withdrawn"]);
        expect(await dispatch.draftsWithoutCard()).toEqual([]);
        expect(await dispatch.raiseDraftCard(draft.id as DraftId, new Date())).toBeNull();
        expect(await cardsOf(w, draft.id)).toHaveLength(1);
      }),
    ));

  it("the tick opens no draft: it holds no key", () =>
    withSendWorld((w) =>
      withDispatch(w, async (dispatch) => {
        const draft = await madeDraft(w, { to: ["one@send-example.test"] });
        await raiseAll(dispatch);
        expect((await cardsOf(w, draft.id))[0]?.body_enc).toBeNull();
        // pi_work cannot select a draft's body, so nothing it runs can open one.
        expect(await sqlState(() => queryAs(w.db.urls.work, "select body_enc from ledger.drafts"))).toBe("42501");
        expect(
          one(
            await queryAs<{ n: number }>(w.db.urls.work, "select count(*)::int as n from ledger.drafts where id = $1", [
              draft.id,
            ]),
          ).n,
        ).toBe(1);
      }),
    ));
});
