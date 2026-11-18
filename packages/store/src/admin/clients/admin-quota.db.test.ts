import { type MessageId, QUOTA_DEFAULTS } from "@intelligence/contracts/personal";
import { afterEach, describe, expect, it } from "vitest";
import { readAs } from "../../test-support/connections.ts";
import { queryAs } from "../../test-support/database.ts";
import { seedQuotaMail } from "../../test-support/quotas.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { outcomeValue, refusedWith, registration } from "../../test-support/values.ts";
import { WORLD_NOW } from "../../test-support/world.ts";

// The owner's side of read quotas, through Admin as pi_admin: the budgets set, and each client's use
// against them, counts only.

const stores: TestStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

async function quotaStore(): Promise<TestStore> {
  const store = await openStore({ now: WORLD_NOW });
  stores.push(store);
  await seedQuotaMail(store.writer, WORLD_NOW, { own: 4, employer: 0 });
  return store;
}

const budgetsOf = async (store: TestStore, name: string) =>
  queryAs(
    store.db.urls.admin,
    "select max_items_day, max_chars_day::int as max_chars_day, max_rows_day, max_calls_minute from policy.clients where name = $1",
    [name],
  );

describe("Admin: read quotas", { timeout: DB_TEST_TIMEOUT }, () => {
  it("addClient stores the kind's defaults, or the quota given", async () => {
    const store = await quotaStore();
    await store.admin.clients.addClient(registration("plain", ["own"]));
    await store.admin.clients.addClient(
      registration("given", ["own"], { quota: { maxItemsDay: 7, maxCharsDay: 8, maxRowsDay: 9, maxCallsMinute: 10 } }),
    );
    await store.admin.clients.addClient(registration("thinker", ["own"], { kind: "reasoner", tools: ["get_self"] }));
    expect(await budgetsOf(store, "plain")).toEqual([
      { max_items_day: 300, max_chars_day: 3_000_000, max_rows_day: 5_000, max_calls_minute: 60 },
    ]);
    expect(await budgetsOf(store, "given")).toEqual([
      { max_items_day: 7, max_chars_day: 8, max_rows_day: 9, max_calls_minute: 10 },
    ]);
    expect(await budgetsOf(store, "thinker")).toEqual([
      { max_items_day: 600, max_chars_day: 6_000_000, max_rows_day: 20_000, max_calls_minute: 240 },
    ]);
    // A quota outside the bounds is an invalid registration, and nothing is stored.
    expect(
      await refusedWith(() =>
        store.admin.clients.addClient(
          registration("wide", ["own"], { quota: { ...QUOTA_DEFAULTS.agent, maxCallsMinute: 601 } }),
        ),
      ),
    ).toEqual({
      name: "AdminError",
      code: "invalid_registration",
    });
    expect(await budgetsOf(store, "wide")).toEqual([]);
  });

  it("setQuota changes the budgets named and keeps the rest; a value outside the bounds and an unknown or revoked name are refused", async () => {
    const store = await quotaStore();
    await store.admin.clients.addClient(registration("alpha", ["own"]));
    await store.admin.clients.setQuota("alpha", { maxItemsDay: 12, maxCallsMinute: 600 });
    expect(await budgetsOf(store, "alpha")).toEqual([
      { max_items_day: 12, max_chars_day: 3_000_000, max_rows_day: 5_000, max_calls_minute: 600 },
    ]);
    for (const bad of [
      { maxCallsMinute: 0 },
      { maxCallsMinute: 601 },
      { maxItemsDay: -1 },
      { maxCharsDay: 1.5 },
      { maxRowsDay: 1_000_001 },
    ]) {
      expect(await refusedWith(() => store.admin.clients.setQuota("alpha", bad)), JSON.stringify(bad)).toEqual({
        name: "AdminError",
        code: "invalid_argument",
      });
    }
    expect(await budgetsOf(store, "alpha")).toEqual([
      { max_items_day: 12, max_chars_day: 3_000_000, max_rows_day: 5_000, max_calls_minute: 600 },
    ]);
    expect(await refusedWith(() => store.admin.clients.setQuota("nobody", { maxItemsDay: 1 }))).toEqual({
      name: "AdminError",
      code: "not_found",
    });
    await store.admin.clients.revokeClient("alpha");
    expect(await refusedWith(() => store.admin.clients.setQuota("alpha", { maxItemsDay: 1 }))).toEqual({
      name: "AdminError",
      code: "not_found",
    });
  });

  it("usage counts each client's own use against its budgets, and its rate_limited calls", async () => {
    const store = await quotaStore();
    const { token } = await store.admin.clients.addClient(
      registration("alpha", ["own"], {
        tools: ["find_messages", "read_message"],
        quota: { ...QUOTA_DEFAULTS.agent, maxItemsDay: 2 },
      }),
    );
    await store.admin.clients.addClient(registration("beta", ["own"]));
    const list = outcomeValue(await store.reader.findMessages(token, {}));
    const ids = list.messages.map((message) => message.id);
    let chars = 0;
    for (const id of ids.slice(0, 2))
      chars += [...(outcomeValue(await store.reader.readMessage(token, { id })).text?.untrusted ?? "")].length;
    expect(await store.reader.readMessage(token, { id: ids[2] as MessageId })).toEqual({
      ok: false,
      code: "rate_limited",
      refusal: "rate_limited_day",
    });
    // A rate_limited call of a tool that is no read (record's own quota) is no read quota hit,
    // and no call of the read minute: only read tools spend a read budget.
    await readAs(store.db, token, (query) => query("select policy.log_call('record', 0, 'rate_limited')"));
    const usage = await store.admin.clients.usage();
    expect(usage.map((row) => row.client)).toEqual(["alpha", "beta"]);
    expect(usage[0]).toEqual({
      client: "alpha",
      kind: "agent",
      status: "active",
      quota: { ...QUOTA_DEFAULTS.agent, maxItemsDay: 2 },
      used: { itemsDay: 2, charsDay: chars, rowsDay: ids.length + 2, callsMinute: 4 },
      rateLimitedDay: 1,
    });
    expect(usage[1]).toMatchObject({
      client: "beta",
      used: { itemsDay: 0, charsDay: 0, rowsDay: 0, callsMinute: 0 },
      rateLimitedDay: 0,
    });
    // One client by name; an unknown name has no row.
    expect(await store.admin.clients.usage("beta")).toEqual([usage[1]]);
    expect(await store.admin.clients.usage("nobody")).toEqual([]);
  });
});
