import type { GmailMessage, PersonalSource } from "@intelligence/personal-core/items";
import { world } from "@intelligence/personal-core/testing";
import { createReader, type Writer } from "@intelligence/personal-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_OK,
  addressesIn,
  cleanUp,
  count,
  DAY,
  first,
  fromNell,
  gmailId,
  isStored,
  LONG,
  message,
  NELL,
  NOW,
  personalOf,
  rows,
  type Stack,
  type Sync,
  sourcesOf,
  stack,
  stacks,
  threeAtATime,
  withAdmin,
} from "../test-support/sync-db-fixtures.ts";
import { runSync } from "./sync.ts";

// runSync killed after each item and rerun, on its own: the slowest test, so a worker of its own.
// Shared setup is in sync-db-fixtures.ts.

// The machine is shared: a test that makes a database and syncs the world may take a while.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
afterEach(cleanUp);

describe("runSync", () => {
  it(
    "a sync killed after each item and rerun gives the same rows",
    async () => {
      const w = world({ now: NOW });
      const late = fromNell("19c0000000000001", w.accounts[1]?.address ?? "");
      // After the first sync, the owner replies in the thread of the Social message the rule
      // left out: history hands over the reply and, after it on the same page, that message.
      const social = w.handles.socialLeftOutMessageId;
      const stranger =
        addressesIn(personalOf(w).messages.find((one) => one.id === social) as GmailMessage, ["from"])[0] ?? "";
      const reply = {
        ...message("19c0000000000002", `Avery Quinn <${first(w.owner.addresses)}>`, stranger, 20, { labels: ["SENT"] }),
        threadId: social,
      };

      // Two syncs of the world into `s`, the second after the reply, with the call numbered
      // `killAt` failing, and the sync it failed in run again with no failure. The calls counted
      // are the four fakes' and the writer's ingestItem. It notes the call that reads the
      // personal rest pass's first page, between the two passes, and the ingest of the Social
      // message, between it and the sent reply on its page.
      const run = async (
        s: Stack,
        killAt?: number,
      ): Promise<{ calls: number; workProfile: number; restPass: number; conditional: number; result: Sync }> => {
        const { all, personal } = sourcesOf(w);
        personal.gmail.add(late);
        let calls = 0;
        let kill = killAt;
        let fired = false;
        let workProfile = 0;
        let restPass = 0;
        let conditional = 0;
        const tick = (): void => {
          calls += 1;
          if (calls === kill) {
            fired = true;
            throw Object.assign(new Error("unavailable"), { code: "unavailable" });
          }
        };
        const counted = all.map(
          (source): PersonalSource => ({
            label: source.label,
            compartment: source.compartment,
            async profile() {
              tick();
              if (source.label === "work") workProfile = calls;
              return source.profile();
            },
            connector(id, account, options) {
              const made = source.connector(id, account, options);
              return {
                ...made,
                async listChanges(...given) {
                  tick();
                  const at = calls;
                  const page = await made.listChanges(...given);
                  if (
                    source.label === "personal" &&
                    id === "google_mail" &&
                    restPass === 0 &&
                    page.items.some((item) => !item.markers.includes("SENT"))
                  )
                    restPass = at;
                  return page;
                },
              };
            },
          }),
        );
        const writer: Writer = {
          ...s.writer,
          async ingestItem(...given) {
            tick();
            if (given[1].sourceItemId === gmailId(social) && conditional === 0) conditional = calls;
            return s.writer.ingestItem(...given);
          },
        };
        const once = (): Promise<Sync> => runSync({ writer, sources: counted, log: s.log, now: NOW });
        let result: Sync = ALL_OK as Sync;
        for (const before of [() => {}, () => personal.gmail.add(reply)]) {
          before();
          result = await once();
          if (fired) {
            expect(
              result.outcomes.some((one) => one.outcome !== "ok"),
              `killed at call ${kill}`,
            ).toBe(true);
            fired = false;
            kill = undefined;
            result = await once();
          }
        }
        return { calls, workProfile, restPass, conditional, result };
      };

      const whole = await stack();
      const tables = (
        await rows<{ name: string }>(
          whole,
          "select table_schema || '.' || table_name as name from information_schema.tables where table_schema in ('policy', 'vault', 'knowledge') order by 1",
        )
      ).map((row) => row.name);
      expect(tables).toContain("vault.listed_items");
      // Every address of the world that is not the owner's, and the late message's sender.
      const addresses = [
        ...new Set(
          [
            ...w.accounts.flatMap((account) => [
              ...account.messages.flatMap((one) =>
                one.headers
                  .filter((header) => ["From", "To", "Cc", "Bcc"].includes(header.name))
                  .map((header) => header.value),
              ),
              ...account.events.flatMap((one) => [
                one.organizer?.email ?? "",
                ...(one.attendees ?? []).map((attendee) => attendee.email),
              ]),
            ]),
            NELL,
          ].flatMap((text) => text.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+/g) ?? []),
        ),
      ].filter((address) => !w.owner.addresses.includes(address));
      expect(addresses.length).toBeGreaterThan(500);
      const withoutIds = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(withoutIds)
          : typeof value === "object" && value !== null
            ? Object.fromEntries(
                Object.entries(value)
                  .filter(([key]) => key !== "id")
                  .map(([key, one]) => [key, withoutIds(one)]),
              )
            : value;
      // Each address's timeline, as a client cleared for both compartments reads it: its entries
      // with every id removed, in a fixed order. `null` is an address no entity holds.
      const timelines = (s: Stack): Promise<Record<string, unknown>> =>
        withAdmin(s, async (admin) => {
          const reader = createReader({ url: s.db.urls.reader, keys: s.db.keys, log: s.log, now: () => NOW });
          try {
            // The contract's largest read quota: the default's 60 calls a minute would refuse most
            // of these hundreds of timeline reads as rate_limited.
            const { token } = await admin.clients.addClient({
              name: "both",
              runtime: "local",
              vendorRetention: "unknown",
              compartments: ["own", "employer:example"],
              views: ["self", "people"],
              tools: ["get_timeline"],
              quota: { maxItemsDay: 100_000, maxCharsDay: 100_000_000, maxRowsDay: 1_000_000, maxCallsMinute: 600 },
            });
            const read: Record<string, unknown> = {};
            // Four addresses at a time, as many as the reader's pool holds.
            for (let at = 0; at < addresses.length; at += 4) {
              await Promise.all(
                addresses.slice(at, at + 4).map(async (address) => {
                  // Read after the run: entity ids are not stable across a re-derive.
                  const entity = await admin.accounts.inspect(address);
                  if (entity === null) read[address] = null;
                  else {
                    const timeline = await reader.getTimeline(token, {
                      id: entity.id,
                      to: new Date(NOW.getTime() + 30 * DAY).toISOString(),
                      limit: 100,
                    });
                    read[address] = timeline.ok
                      ? timeline.value.entries.map((entry) => JSON.stringify(withoutIds(entry))).sort()
                      : timeline.code;
                  }
                }),
              );
            }
            return read;
          } finally {
            await reader.close();
          }
        });
      const SYNC_LOG = "vault.sync_outcomes";
      expect(tables).toContain(SYNC_LOG);
      // The counts and the evidence are read before the timelines, which register a client.
      const state = async (s: Stack) => ({
        counts: Object.fromEntries(
          await Promise.all(
            tables.filter((table) => table !== SYNC_LOG).map(async (table) => [table, await count(s, table)] as const),
          ),
        ),
        evidence: await rows(s, "select source_item_fp, revision_tag_fp from vault.evidence_items order by 1, 2"),
        timelines: await timelines(s),
      });

      // The uninterrupted run. Its first sync needs a re-derive: the late message names the work
      // address. The Social message is stored by the second.
      const uninterrupted = await run(whole);
      expect(uninterrupted.result).toEqual(ALL_OK);
      expect(await isStored(whole, gmailId(social))).toBe(true);
      expect([uninterrupted.restPass, uninterrupted.conditional].every((at) => at > 0)).toBe(true);
      const expected = await state(whole);
      expect(await count(whole, SYNC_LOG)).toBeGreaterThan(0);
      expect(expected.evidence.length).toBeGreaterThan(60);
      // The timelines are worth comparing: people have entries, and the owner's addresses none.
      expect(
        Object.values(expected.timelines).filter((one) => Array.isArray(one) && one.length > 0).length,
      ).toBeGreaterThan(500);
      expect(expected.timelines[w.handles.topContactAddress]).toHaveLength(8);

      // Fourteen kill points over its calls: ten spread evenly, the calls just before and just
      // after the work label's profile call, the call between the sent pass and the rest pass,
      // and the ingest between the sent reply and the Social message of its page.
      const total = uninterrupted.calls;
      const points = new Set([
        uninterrupted.workProfile - 1,
        uninterrupted.workProfile + 1,
        uninterrupted.restPass,
        uninterrupted.conditional,
      ]);
      for (let at = 1; at <= 10; at += 1) points.add(Math.round((at * total) / 11));
      for (let filler = 1; points.size < 14; filler += 1) points.add(filler);
      expect(points.size).toBe(14);

      await threeAtATime(
        [...points].sort((a, b) => a - b),
        async (point) => {
          const s = await stack(whole.db.keyFile);
          const killed = await run(s, point);
          expect(killed.result.outcomes, `killed at call ${point}`).toEqual(ALL_OK.outcomes);
          expect(killed.result.rederive, `killed at call ${point}`).not.toBe("failed");
          expect(await state(s), `killed at call ${point}`).toEqual(expected);
          // The log keeps every completed sync's rows, and the killed one's beside them.
          expect(await count(s, SYNC_LOG), `killed at call ${point}`).toBeGreaterThanOrEqual(
            await count(whole, SYNC_LOG),
          );
          stacks.splice(stacks.indexOf(s), 1);
          await s.writer.close();
          await s.db.drop();
        },
      );
    },
    LONG,
  );
});
