import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersonalLogger } from "@intelligence/contracts/personal";
import { REGISTRY } from "@intelligence/personal-ladder";
import { createDispatch, ensureJournal } from "@intelligence/personal-store";
import { age, author, madeDraft, type SendCtx, TIMEOUT, withSendWorld } from "@intelligence/personal-store/testing";
import { describe, expect, it } from "vitest";
import { runTick } from "./tick.ts";

// The tick's two steps for drafts, through runTick as `pi work tick` runs it. Drafts are made as
// the send database's tests make them. Reserved domains only.

const log: PersonalLogger = { info: () => {}, warn: () => {}, error: () => {} };

// One tick on the world's database, with an empty erasure journal level with it.
async function tick(w: SendCtx, now = new Date()) {
  const folder = await mkdtemp(join(tmpdir(), "pi-tick-drafts-"));
  const journal = join(folder, "erasures.jsonl");
  await ensureJournal(journal);
  const dispatch = createDispatch({ url: w.db.urls.work, log, journal });
  try {
    return await runTick({ dispatch, registry: REGISTRY, log, now: () => now });
  } finally {
    await dispatch.close();
    await rm(folder, { recursive: true, force: true });
  }
}

const cardsOf = (w: SendCtx, draft: string): Promise<{ kind: string; author: string; state: string }[]> =>
  w.admin(
    `select c.kind, c.created_by as author,
       (select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) as state
     from ledger.cards c where c.target_kind = 'draft' and c.target_id = $1`,
    [draft],
  );
const draftState = async (w: SendCtx, draft: string): Promise<string | null> =>
  (
    await w.admin<{ event: string }>(
      "select event from ledger.record_events where row_kind = 'draft' and row_id = $1 order by id desc limit 1",
      [draft],
    )
  )[0]?.event ?? null;

describe("pi work tick, for drafts", { timeout: TIMEOUT }, () => {
  it("a made draft gets its card from the tick, a held one none, and a second tick raises nothing more", () =>
    withSendWorld(async (w) => {
      const made = await madeDraft(w, { to: ["one@send-example.test"] });
      // Held by a check the reader's caller answers: as pi_reader, append_gate_decision computes
      // vetoes, conflict_lists and channel_cap itself, so a failed vetoes is not taken.
      const held = await madeDraft(w, { to: ["two@send-example.test"] }, ["disclosure"]);
      expect(await tick(w)).toMatchObject({ cards: 1 });
      expect(await cardsOf(w, made.id)).toEqual([
        { kind: "draft_waiting", author: author(w.client), state: "pending" },
      ]);
      expect(await cardsOf(w, held.id)).toEqual([]);
      expect(await tick(w)).toMatchObject({ cards: 0 });
    }));

  it("a draft seven days old is expired by the tick and gets no card; one six days old gets one", () =>
    withSendWorld(async (w) => {
      const old = await madeDraft(w, { to: ["old@send-example.test"] });
      const young = await madeDraft(w, { to: ["young@send-example.test"] });
      await age(w.db, "ledger.drafts", "created_at", "id = $1", [old.id], 7 * 86_400 + 60);
      await age(w.db, "ledger.drafts", "created_at", "id = $1", [young.id], 6 * 86_400);
      expect(await tick(w)).toMatchObject({ expired: 1, cards: 1 });
      expect(await draftState(w, old.id)).toBe("expired");
      expect(await cardsOf(w, old.id)).toEqual([]);
      expect(await draftState(w, young.id)).toBe("made");
      expect(await cardsOf(w, young.id)).toHaveLength(1);
    }));

  it("with the kill switch on, the tick raises no draft card", () =>
    withSendWorld(async (w) => {
      const draft = await madeDraft(w, { to: ["one@send-example.test"] });
      await w.admin(
        "insert into ledger.kill_switch (request_id, created_by, compartments, state) values ('request-kill-0001', 'owner', '{own}', 'on')",
      );
      expect(await tick(w)).toMatchObject({ cards: 0 });
      expect(await cardsOf(w, draft.id)).toEqual([]);
    }));
});
