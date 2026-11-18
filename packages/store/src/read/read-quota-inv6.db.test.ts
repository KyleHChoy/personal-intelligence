import type { MessageId, ReadOutcome } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { seedQuotaMail } from "../test-support/quotas.ts";
import { recordingPool } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { registration } from "../test-support/values.ts";
import { WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";

// Gate test V2: two stores, the second with `employer:example` messages interleaved in time with
// the client's own, which the client, cleared for `own` alone, cannot see. Its sequence of answers,
// the call on which it is first refused, the statements sent and the bytes of the refusal are the
// same in both.

const OWN = 6;
const QUOTA = { maxItemsDay: 3, maxCharsDay: 100_000, maxRowsDay: 14, maxCallsMinute: 600 };

type Step = { tool: string; answer: string; statements: string[] };

// What one client of a store, cleared for `own` alone, is answered as it pages and reads until
// refused, then lists until refused. Message ids are made per store, so each is replaced by the
// order in which the client first met it.
async function walk(store: TestStore): Promise<Step[]> {
  const recorded = recordingPool(store.readerPool);
  const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
  const { token } = await store.admin.clients.addClient(
    registration("own-only", ["own"], { tools: ["find_messages", "read_message"], quota: QUOTA }),
  );
  const seen = new Map<string, string>();
  const plain = (value: unknown): string =>
    JSON.stringify(value).replaceAll(/msg_[0-9A-HJKMNP-TV-Z]{26}/g, (id) => {
      let name = seen.get(id);
      if (name === undefined) {
        name = `msg#${seen.size}`;
        seen.set(id, name);
      }
      return name;
    });
  const steps: Step[] = [];
  const step = async <T>(tool: string, run: () => Promise<ReadOutcome<T>>): Promise<ReadOutcome<T>> => {
    recorded.statements.length = 0;
    const answer = await run();
    steps.push({ tool, answer: plain(answer), statements: [...recorded.statements] });
    return answer;
  };

  const ids: MessageId[] = [];
  let to: string | undefined;
  for (let pages = 0; pages < 10; pages += 1) {
    const page = await step("find_messages", () =>
      reader.findMessages(token, { limit: 2, ...(to === undefined ? {} : { to }) }),
    );
    if (!page.ok) break;
    ids.push(...page.value.messages.map((message) => message.id as MessageId));
    for (const message of page.value.messages)
      await step("read_message", () => reader.readMessage(token, { id: message.id }));
    const last = page.value.messages.at(-1);
    if (!page.value.more || last === undefined) break;
    to = new Date(new Date(last.at).getTime() - 1).toISOString();
  }
  // Every message again, then listing until refused.
  for (const id of ids) await step("read_message", () => reader.readMessage(token, { id }));
  for (let calls = 0; calls < 20; calls += 1)
    if (!(await step("find_messages", () => reader.findMessages(token, { limit: 50 }))).ok) break;
  return steps;
}

describe("a quota reveals nothing of a row the client cannot see", { timeout: DB_TEST_TIMEOUT }, () => {
  it("the answers, the first refusal, the statements and the refusal's bytes are the same with and without hidden rows", async () => {
    const plainStore = await openStore({ now: WORLD_NOW });
    const mixedStore = await openStore({ now: WORLD_NOW });
    try {
      await seedQuotaMail(plainStore.writer, WORLD_NOW, { own: OWN, employer: 0 });
      await seedQuotaMail(mixedStore.writer, WORLD_NOW, { own: OWN, employer: OWN });
      const plain = await walk(plainStore);
      const mixed = await walk(mixedStore);
      expect(mixed).toEqual(plain);
      // The walk reached both refusals, and each is the same bytes.
      const refusals = plain.filter(
        (one) => one.answer === JSON.stringify({ ok: false, code: "rate_limited", refusal: "rate_limited_day" }),
      );
      expect(refusals.map((one) => one.tool)).toContain("read_message");
      expect(refusals.at(-1)?.tool).toBe("find_messages");
      // The positive control: the mixed store does hold rows the client was not shown.
      const counts = async (store: TestStore) =>
        (await store.adminPool.query<{ n: number }>("select count(*)::int as n from knowledge.messages")).rows[0]?.n;
      expect(await counts(plainStore)).toBe(OWN);
      expect(await counts(mixedStore)).toBe(2 * OWN);
    } finally {
      await plainStore.close();
      await mixedStore.close();
    }
  });
});
