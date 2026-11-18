import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PersonalPage, PersonalSource } from "@intelligence/personal-core/items";
import { world } from "@intelligence/personal-core/testing";
import { googleSecretName, journalPath } from "@intelligence/personal-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountOf,
  cleanUp,
  first,
  folders,
  LONG,
  message,
  NOW,
  pi,
  rows,
  type Stack,
  sourcesOf,
  stack,
  sync,
  withAdmin,
} from "../test-support/sync-db-fixtures.ts";
import { runSync } from "./sync.ts";

// What sync, the jobs and `pia status --coverage` write and print for coverage. The Gmail fake is
// not changed: a wrapper around the source sets `added` on the history pages it hands over, as the
// Gmail connector's history phase sets it.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
afterEach(cleanUp);

// The source with its mail connector's history pages given `added` by `addedOf`, and, with `drop`,
// every page emptied of items, as if history had listed additions that never arrived.
function wrapped(
  source: PersonalSource,
  addedOf: (page: PersonalPage, at: number) => number,
  drop = false,
): PersonalSource {
  let historyPages = 0;
  return {
    ...source,
    connector: (id, account, options) => {
      const connector = source.connector(id, account, options);
      if (id !== "google_mail") return connector;
      return {
        ...connector,
        listChanges: async (...args) => {
          const page = await connector.listChanges(...args);
          const shown = drop ? { ...page, items: [] } : page;
          if (page.listing !== undefined) return shown;
          historyPages += 1;
          return { ...shown, added: addedOf(page, historyPages) };
        },
      };
    },
  };
}

type OutcomeRow = {
  sync_kind: string | null;
  code: string;
  added: number | null;
  stored: number;
  junk: number;
  decided: number;
};
const outcomesOf = async (s: Stack, accountId: string): Promise<OutcomeRow[]> =>
  rows<OutcomeRow>(
    s,
    "select sync_kind, code, added, stored, junk, decided from vault.sync_outcomes where account_id = $1 order by id",
    [accountId],
  );
// The real clock, for the syncs whose outcomes coverage reads: the admin's window ends at the real
// now, and the fixtures' NOW is months before it.
const REAL_NOW = new Date();
const adminEnv = (s: Stack): Record<string, string> => ({
  PI_DATABASE_URL_ADMIN: s.db.urls.admin,
  PI_KEY_FILE: s.db.keyFile,
});

describe("sync's outcomes for coverage", () => {
  it(
    "a sync whose history listed 3 added and decided none reads silent; the control, the same additions decided, covered",
    async () => {
      const lost = await stack();
      const w = world({ now: REAL_NOW });
      const { personal } = sourcesOf(w);
      await runSync({
        writer: lost.writer,
        sources: [wrapped(personal, (_page, at) => (at === 1 ? 3 : 0), true)],
        log: lost.log,
        now: REAL_NOW,
      });
      const lostMail = await accountOf(lost, "personal", "google_mail");
      const [row] = await outcomesOf(lost, lostMail.id);
      expect(row).toMatchObject({ sync_kind: "full", code: "ok", added: 3, decided: 0 });
      const lostRows = await withAdmin(lost, (admin) => admin.box.coverage(7, { generation: 1 }));
      expect(lostRows.find((one) => one.kind === "account" && one.id === lostMail.id)?.state).toBe("silent");

      const kept = await stack();
      await runSync({
        writer: kept.writer,
        sources: [wrapped(sourcesOf(world({ now: REAL_NOW })).personal, (_page, at) => (at === 1 ? 3 : 0))],
        log: kept.log,
        now: REAL_NOW,
      });
      const keptMail = await accountOf(kept, "personal", "google_mail");
      expect(first(await outcomesOf(kept, keptMail.id)).decided).toBeGreaterThan(0);
      const keptRows = await withAdmin(kept, (admin) => admin.box.coverage(7, { generation: 1 }));
      expect(keptRows.find((one) => one.kind === "account" && one.id === keptMail.id)?.state).toBe("covered");
    },
    LONG,
  );

  it(
    "sync sums added over its pages and counts every item it disposed of in decided, drafts and junk among them",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { personal } = sourcesOf(w);
      const source = wrapped(personal, (page) => page.items.length);
      await runSync({ writer: s.writer, sources: [source], log: s.log, now: NOW });
      const to = first(w.owner.addresses);
      personal.gmail.add(message("19c00000000c0001", "Nell Ashdown <nell.ashdown@example.org>", to, 2));
      personal.gmail.add(
        message("19c00000000c0002", "Nell Ashdown <nell.ashdown@example.org>", to, 2, { labels: ["DRAFT"] }),
      );
      personal.gmail.add(message("19c00000000c0003", "Offers <offers@example.net>", to, 2, { labels: ["SPAM"] }));
      await runSync({ writer: s.writer, sources: [source], log: s.log, now: NOW });
      const mail = await accountOf(s, "personal", "google_mail");
      const outcomes = await outcomesOf(s, mail.id);
      expect(outcomes).toHaveLength(2);
      expect(outcomes.at(-1)).toEqual({ sync_kind: "full", code: "ok", added: 3, stored: 1, junk: 1, decided: 3 });
      // A calendar lists no additions: its outcomes carry no added.
      const calendar = await accountOf(s, "personal", "google_calendar");
      expect((await outcomesOf(s, calendar.id)).map((one) => one.added)).toEqual([null, null]);
    },
    LONG,
  );

  it(
    "a fast run's outcomes are of kind fast",
    async () => {
      const s = await stack();
      await sync(s, sourcesOf(world({ now: NOW })).all);
      await runSync({
        writer: s.writer,
        sources: sourcesOf(world({ now: NOW })).all,
        log: s.log,
        now: NOW,
        fast: true,
      });
      const mail = await accountOf(s, "personal", "google_mail");
      expect((await outcomesOf(s, mail.id)).map((one) => one.sync_kind)).toEqual(["full", "fast"]);
    },
    LONG,
  );
});

// A label whose stored client cannot ask Google records its accounts' outcome with the run's kind,
// as a label that failed does.
describe("a label that cannot ask Google", () => {
  it(
    "records reconnect_google on its accounts with the sync's kind",
    async () => {
      const s = await stack();
      const mail = await s.writer.ensureSourceAccount(
        "personal",
        "google_mail",
        "own",
        "owner@coverage-reconnect.test",
      );
      await withAdmin(s, async (admin) => {
        await admin.secrets.setSecret(googleSecretName("personal", "client"), "not json");
        await admin.secrets.setSecret(googleSecretName("personal", "refresh_token"), "sentinel-refresh-token-7f3a91");
      });
      expect(
        (await pi(["sync", "--fast"], { PI_DATABASE_URL_WRITER: s.db.urls.writer, PI_KEY_FILE: s.db.keyFile })).exit,
      ).toBe(1);
      expect(await outcomesOf(s, mail.id)).toEqual([
        { sync_kind: "fast", code: "reconnect_google", added: null, stored: 0, junk: 0, decided: 0 },
      ]);
    },
    LONG,
  );
});

describe("the scheduled jobs' runs", () => {
  it(
    "pi sync writes one sync row at its end, with read_hold from whether the file PI_READ_HOLD names exists, and its kind",
    async () => {
      const s = await stack();
      const env = { PI_DATABASE_URL_WRITER: s.db.urls.writer, PI_KEY_FILE: s.db.keyFile };
      const hold = join(first(folders), "read-hold");
      // No label is connected: the run ends with no_accounts, and still writes its row.
      expect((await pi(["sync"], { ...env, PI_READ_HOLD: hold })).exit).toBe(0);
      await writeFile(hold, "");
      expect((await pi(["sync"], { ...env, PI_READ_HOLD: hold })).exit).toBe(0);
      expect((await pi(["sync", "--fast"], env)).exit).toBe(0);
      expect(await rows(s, "select job, sync_kind, read_hold from ledger.job_runs order by id")).toEqual([
        { job: "sync", sync_kind: "full", read_hold: false },
        { job: "sync", sync_kind: "full", read_hold: true },
        { job: "sync", sync_kind: "fast", read_hold: false },
      ]);
    },
    LONG,
  );

  it(
    "pi erase settle writes an erase_settle row and pi work tick a work_tick row, each under its own role",
    async () => {
      const s = await stack();
      expect((await pi(["erase", "replay"], adminEnv(s))).exit).toBe(0);
      expect((await pi(["erase", "settle"], adminEnv(s))).exit).toBe(0);
      await pi(["work", "tick"], {
        PI_DATABASE_URL_WORK: s.db.urls.work,
        PI_ERASURE_JOURNAL: journalPath(s.db.keyFile),
      });
      expect(await rows(s, "select job, sync_kind, read_hold from ledger.job_runs order by id")).toEqual([
        { job: "erase_settle", sync_kind: null, read_hold: null },
        { job: "work_tick", sync_kind: null, read_hold: null },
      ]);
    },
    LONG,
  );
});

describe("pia status --coverage", () => {
  it(
    "prints { days, rows } by ids, and --record prints one coverage_silent line for a row that entered silent, once",
    async () => {
      const s = await stack();
      const { personal } = sourcesOf(world({ now: REAL_NOW }));
      await runSync({
        writer: s.writer,
        sources: [wrapped(personal, (_page, at) => (at === 1 ? 3 : 0), true)],
        log: s.log,
        now: REAL_NOW,
      });
      const mail = await accountOf(s, "personal", "google_mail");

      const shown = await pi(["status", "--coverage"], adminEnv(s));
      expect(shown.exit, shown.stderr).toBe(0);
      const view = JSON.parse(shown.stdout) as { days: number; rows: { kind: string; id: string; state: string }[] };
      expect(view.days).toBe(7);
      expect(view.rows.find((one) => one.kind === "account" && one.id === mail.id)?.state).toBe("silent");
      expect(JSON.parse((await pi(["status", "--coverage", "--days", "3"], adminEnv(s))).stdout)).toMatchObject({
        days: 3,
      });

      const recorded = await pi(["status", "--coverage", "--record"], adminEnv(s));
      expect(recorded.exit, recorded.stderr).toBe(0);
      const lines = recorded.stdout
        .trim()
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { event: string; ids: Record<string, string>; code: string });
      // Nothing but the fixed lines.
      for (const line of lines) {
        expect(Object.keys(line)).toEqual(["event", "ids", "code"]);
        expect(line.event).toBe("coverage_silent");
        expect(Object.keys(line.ids)).toHaveLength(1);
      }
      expect(lines.filter((line) => line.ids.account === mail.id)).toHaveLength(1);
      // Still silent: not printed again.
      const again = await pi(["status", "--coverage", "--record"], adminEnv(s));
      expect(again.exit, again.stderr).toBe(0);
      expect(again.stdout).not.toContain(mail.id);
    },
    LONG,
  );
});
