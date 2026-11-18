import { createAdmin } from "@intelligence/personal-store";
import {
  DB_TEST_TIMEOUT,
  fingerprint,
  MAIL,
  type PipelineStore,
  stored,
  withPipeline,
} from "@intelligence/personal-store/testing";
import { describe, expect, it } from "vitest";
import { quiet } from "../test-support/extract-fixtures.ts";
import {
  asAdmin,
  commitAll,
  groupingRows,
  sameFactCards,
  scripted,
  situation,
  sweep,
} from "../test-support/same-fact-fixtures.ts";

// Invariant 6 for the same-fact sweep: an audience's pairs, the calls made for them and the cards
// raised for them are the same with and without twelve keys it cannot see, of the same subject,
// kind and domain, newer than its own and phrased alike. The hidden keys are in `employer:example`,
// which the client's audience (`own`) does not hold; the owner's audience holds both, so there they
// are paired, called and carded, and crowd that audience's ten newest keys and its label's cards.
// Fingerprints are keyed per database, so each world's are named by the phrase they were made from
// before the two are compared.

const VISIBLE = ["lives in Portland", "based in Portland, OR"];
const HIDDEN = Array.from({ length: 12 }, (_, n) => `lives in Portland ward ${n + 1}`);

type Seen = { rows: unknown[]; calls: unknown[]; asked: string[]; cards: unknown[] };

async function world(hidden: boolean): Promise<Seen> {
  return withPipeline(async (store: PipelineStore) => {
    const admin = createAdmin({ url: store.db.urls.admin, keys: store.db.keys, log: quiet });
    try {
      await admin.clients.addClient({
        name: "alpha",
        runtime: "local",
        vendorRetention: "none",
        compartments: ["own"],
        views: ["self", "people", "work"],
        tools: ["get_self"],
      } as never);
    } finally {
      await admin.close();
    }
    const canary = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
    await commitAll(
      store,
      canary,
      VISIBLE.map((phrase, n) => situation(store, canary, "own", n + 1, phrase, "home", "2026-09-01T09:00:00.000Z")),
    );
    if (hidden) {
      const work = await stored(store.writer, store.accounts.workMail, MAIL.workCanary);
      await commitAll(
        store,
        work,
        HIDDEN.map((phrase, n) =>
          situation(store, work, "employer:example", n + 1, phrase, "home", "2026-09-20T09:00:00.000Z"),
        ),
      );
    }

    const names = new Map(
      [...VISIBLE, ...HIDDEN].map((phrase) => [
        fingerprint(store.db.keys, "fact", `k3a situation home ${phrase}`),
        phrase,
      ]),
    );
    const name = (text: string): string =>
      [...names].reduce((out, [fp, phrase]) => out.replaceAll(fp, `<${phrase}>`), text);
    // A pair's two keys are sorted by fingerprint, which each database keys its own way: named by
    // phrase, they are sorted again.
    const pairOf = (a: string, b: string): string => [name(a), name(b)].sort().join(" ");
    const slotOf = (slot: string): string => {
      const { type, a, b } = JSON.parse(slot) as { type: string; a: unknown; b: unknown };
      return JSON.stringify({ type, sides: [JSON.stringify(a), JSON.stringify(b)].sort() });
    };
    const decideModel = scripted(() => ({ same_fact: 0.97 }));
    await sweep(
      store,
      decideModel,
      scripted(() => ({ answer: "unsure", cites: [] })),
    );

    const own = (await groupingRows(store)).filter((row) => JSON.stringify(row.audience) === JSON.stringify(["own"]));
    const subjects = new Set(own.map((row) => `facts:${row.a_fp}:${row.b_fp}`));
    const calls = (
      await asAdmin<{ subject: string; prompt_id: string; compartments: string[] }>(
        store,
        "select subject, prompt_id, compartments from vault.decision_calls order by subject, prompt_id",
      )
    ).filter((one) => subjects.has(one.subject));
    const cardIds = new Set(own.map((row) => row.card_id));
    const cards = (await sameFactCards(store)).filter(
      (card) => JSON.stringify(card.compartments) === JSON.stringify(["own"]),
    );
    expect(cards.every((card) => cardIds.has(card.id))).toBe(true);
    return {
      rows: own.map(({ calls: made, card_id, a_fp, b_fp, ...rest }) => ({
        ...rest,
        pair: pairOf(a_fp, b_fp),
        calls: made.length,
        carded: card_id !== null,
      })),
      calls: calls.map((one) => ({
        ...one,
        subject: pairOf(...(one.subject.split(":").slice(1) as [string, string])),
      })),
      asked: decideModel.sent
        .filter((request) => JSON.stringify(request.label.compartments) === JSON.stringify(["own"]))
        .map((request) => slotOf(String(request.data.pair ?? ""))),
      cards: cards.map((card) => ({
        options: card.options,
        compartments: card.compartments,
        days: card.expires_after_days,
      })),
    };
  });
}

describe("invariant 6: hidden keys change nothing of an audience's same-fact pairs, calls and cards", {
  timeout: DB_TEST_TIMEOUT,
}, () => {
  it("the client's audience sees the same rows, calls, questions and cards with and without twelve hidden keys", async () => {
    const without = await world(false);
    const withHidden = await world(true);
    // The positive control: the audience has its pair, its call and its card.
    expect(without.rows).toEqual([
      {
        audience: ["own"],
        band: "accept",
        rung: 1,
        state: "proposed",
        compartments: ["own"],
        pair: expect.stringContaining("<"),
        calls: 1,
        carded: true,
      },
    ]);
    expect(without.calls).toHaveLength(1);
    expect(without.cards).toHaveLength(1);
    expect(withHidden).toEqual(without);
  });
});
