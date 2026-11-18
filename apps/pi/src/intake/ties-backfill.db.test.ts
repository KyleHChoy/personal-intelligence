import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import type { GmailMessage, PersonalSource, TiesPass } from "@intelligence/personal-core/items";
import { deriveItem, gmailHeadersItem, gmailItem } from "@intelligence/personal-core/items";
import { createWriter, journalPath, type Writer } from "@intelligence/personal-store";
import { fingerprint } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanUp, count, DAY, message, NOW, pi, rows, type Stack, stack } from "../test-support/sync-db-fixtures.ts";
import { runTies, type TiesRun, tiesLimitBytes } from "./ties-backfill.ts";

// `pi ties backfill` over a fake mailbox: what a run keeps, what a second run and a killed run
// fetch again, and what it leaves alone: dry runs, erasures, the ceiling.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
afterEach(cleanUp);

const OWNER = "owner@example.org";
const ADA = "Ada Example <ada@example.com>";
const days = (n: number): number => n * 24;
const sentTo = (id: string, to: string, daysAgo: number): GmailMessage =>
  message(id, OWNER, to, days(daysAgo), { labels: ["SENT"] });
const from = (id: string, sender: string, daysAgo: number, labels = ["INBOX"]): GmailMessage =>
  message(id, sender, OWNER, days(daysAgo), { labels });

// A fake mailbox: sent mail in one pass and the rest in the other, each newest first, within the
// window, at most `pageSize` ids a page, with what each call asked for kept.
function mailbox(messages: GmailMessage[], pageSize = 2) {
  const fetched: string[] = [];
  const windows: { pass: TiesPass; after: number; before?: number }[] = [];
  let failAfter = Number.POSITIVE_INFINITY;
  const source: PersonalSource = {
    label: "personal",
    compartment: "own",
    profile: async () => ({ address: OWNER }),
    connector: () => {
      throw new Error("the ties backfill uses no connector");
    },
    ties: (sourceAccount) => ({
      list: async (pass, window, pageToken) => {
        if (pageToken === undefined) windows.push({ pass, ...window });
        const inPass = messages
          .filter((one) => one.labelIds.includes("SENT") === (pass === "sent"))
          .filter((one) => one.internalDate / 1000 > window.after)
          .filter((one) => window.before === undefined || one.internalDate / 1000 < window.before)
          .sort((a, b) => b.internalDate - a.internalDate);
        const start = Number(pageToken ?? 0);
        const ids = inPass.slice(start, start + pageSize).map((one) => one.id);
        return { ids, ...(start + pageSize < inPass.length ? { next: String(start + pageSize) } : {}) };
      },
      fetch: async (ids) => {
        if (fetched.length + ids.length > failAfter)
          throw Object.assign(new Error("rate_limited"), { code: "rate_limited" });
        fetched.push(...ids);
        const there = ids.flatMap((id) => messages.filter((one) => one.id === id));
        return {
          items: there.map((one) => gmailHeadersItem(one, { sourceAccount, changeKind: "backfill" })),
          gone: ids.length - there.length,
          skipped: [],
        };
      },
    }),
  };
  const remove = (id: string): void => {
    const at = messages.findIndex((one) => one.id === id);
    if (at >= 0) messages.splice(at, 1);
  };
  return { source, fetched, windows, remove, failAfter: (n: number) => void (failAfter = n) };
}

// The run's writer holds the erasure journal's path, as the command's does.
const runOf = async (s: Stack, source: PersonalSource, more: Partial<TiesRun> = {}) => {
  const writer = createWriter({
    url: s.db.urls.writer,
    keys: s.db.keys,
    log: s.log,
    journal: journalPath(s.db.keyFile),
  });
  try {
    return await runTies({
      writer,
      sources: [source],
      log: s.log,
      now: NOW,
      days: 3_650,
      dryRun: false,
      ceilingBytes: 1024 ** 4,
      sleep: async () => {},
      ...more,
    });
  } finally {
    await writer.close();
  }
};
const ownerEnv = (s: Stack) => ({ PI_DATABASE_URL_ADMIN: s.db.urls.admin, PI_KEY_FILE: s.db.keyFile });
const MAIL = [
  sentTo("1a", ADA, 900),
  sentTo("1b", ADA, 800),
  from("2a", ADA, 890),
  from("2b", ADA, 790),
  from("2c", "Bo Example <bo@example.com>", 700),
];

describe("pi ties backfill", () => {
  it("stores the mailbox's ties and fetches none of them a second time", async () => {
    const s = await stack();
    const box = mailbox(MAIL);
    const [first] = await runOf(s, box.source);
    expect(first).toMatchObject({ outcome: "ok", tally: { listed: 5, stored: 5, known: 0 } });
    expect(box.fetched).toHaveLength(5);
    expect(await count(s, "knowledge.interaction_log", "channel = 'mail_headers'")).toBe(5);
    expect(await count(s, "knowledge.messages")).toBe(0);

    const [second] = await runOf(s, box.source);
    expect(second).toMatchObject({ outcome: "ok", tally: { stored: 0 } });
    expect(box.fetched).toHaveLength(5);
    expect(await count(s, "knowledge.interaction_log")).toBe(5);
  });

  it("a dry run counts what is new and writes and fetches nothing", async () => {
    const s = await stack();
    const box = mailbox(MAIL);
    const [dry] = await runOf(s, box.source, { dryRun: true });
    expect(dry).toMatchObject({ outcome: "ok", tally: { listed: 5, known: 0, stored: 0 } });
    expect(box.fetched).toEqual([]);
    expect(await count(s, "vault.source_accounts", "connector = 'google_mail'")).toBe(0);

    await runOf(s, box.source);
    const [after] = await runOf(s, box.source, { dryRun: true });
    expect(after?.tally.listed).toBe(after?.tally.known);
  });

  it("a run that stopped resumes from its oldest message, its sent mail before the rest", async () => {
    const s = await stack();
    const box = mailbox(MAIL);
    box.failAfter(3);
    const [stopped] = await runOf(s, box.source);
    expect(stopped?.outcome).toBe("rate_limited");
    const stored = await count(s, "vault.evidence_items");
    expect(stored).toBeLessThan(5);

    box.failAfter(Number.POSITIVE_INFINITY);
    box.windows.length = 0;
    const before = box.fetched.length;
    const [resumed] = await runOf(s, box.source);
    expect(resumed?.outcome).toBe("ok");
    // Each pass from a day past its oldest stored message.
    expect(box.windows[0]?.before).toBe(Math.floor((NOW.getTime() - 900 * DAY) / 1000) + 86_400);
    expect(await count(s, "vault.evidence_items")).toBe(5);
    expect(box.fetched.length - before).toBe(5 - stored);
    expect(new Set(box.fetched).size).toBe(box.fetched.length);
  });

  it("leaves out bulk, junk and forum mail nobody answered, by the rules sync applies", async () => {
    const s = await stack();
    const box = mailbox([
      from("3a", "Spammer <spam@example.com>", 400, ["SPAM"]),
      from("3b", "Offers <offers@example.com>", 400, ["CATEGORY_PROMOTIONS"]),
      from("3c", "Forum <forum@example.com>", 400, ["CATEGORY_FORUMS"]),
      from("3d", "Update <update@example.com>", 400, ["CATEGORY_UPDATES"]),
    ]);
    const [run] = await runOf(s, box.source);
    expect(run).toMatchObject({ tally: { stored: 0, left: 3, no_tie: 1 } });
    expect(await count(s, "vault.evidence_items")).toBe(0);
  });

  it("an erased person does not come back, by the removed-evidence check or their suppression", async () => {
    const s = await stack();
    const box = mailbox(MAIL);
    await runOf(s, box.source);
    const [ada] = await rows<{ entity_id: string }>(s, "select entity_id from knowledge.accounts where value_fp = $1", [
      fingerprint(s.db.keys, "address", "ada@example.com"),
    ]);
    const erased = await pi(["erase", "person", ada?.entity_id ?? ""], ownerEnv(s));
    expect(erased.exit, erased.stderr).toBe(0);
    expect(await count(s, "knowledge.interaction_log")).toBe(1);
    expect(await count(s, "knowledge.removed_evidence")).toBeGreaterThan(0);

    const fetchedBefore = box.fetched.length;
    await runOf(s, box.source);
    expect(box.fetched.length).toBe(fetchedBefore);
    expect(await count(s, "knowledge.interaction_log")).toBe(1);

    // Even handed one directly, the writer refuses it.
    const account = (await s.writer.listSourceAccounts()).find((one) => one.connector === "google_mail");
    if (account === undefined) throw new Error("no account");
    const raw = gmailHeadersItem(MAIL[2] as GmailMessage, { sourceAccount: account.id, changeKind: "backfill" });
    expect(await s.writer.ingestItem(account, raw, () => Promise.reject(new Error("not read")))).toBe("removed");
    // A new message from an erased address is suppressed.
    const later = mailbox([from("9z", ADA, 800)]);
    const [again] = await runOf(s, later.source);
    expect(again?.tally.suppressed).toBe(1);
    expect(await count(s, "knowledge.interaction_log")).toBe(1);
  });

  it("stops at its reserve and while a listing of the account is under way", async () => {
    const s = await stack();
    const box = mailbox(MAIL);
    const [full] = await runOf(s, box.source, { ceilingBytes: 1 });
    expect(full?.outcome).toBe("ties_reserve");
    expect(await count(s, "vault.evidence_items")).toBe(0);

    const account = (await s.writer.listSourceAccounts()).find((one) => one.connector === "google_mail");
    if (account === undefined) throw new Error("no account");
    await rows(
      s,
      "insert into vault.listed_items (account_id, source_item_fp, compartments) values ($1, $2, '{own}')",
      [account.id, "a".repeat(64)],
    );
    const [listing] = await runOf(s, box.source);
    expect(listing?.outcome).toBe("listing_under_way");
    expect(await count(s, "vault.evidence_items")).toBe(0);
  });

  it("leaves sync's own window to sync", async () => {
    const s = await stack();
    const box = mailbox([from("4a", ADA, 30), from("4b", ADA, 100)]);
    const [run] = await runOf(s, box.source);
    expect(box.fetched).toEqual(["4b"]);
    expect(run?.tally.listed).toBe(1);
  });

  it("an erased addressee does not come back in a message that also names someone else", async () => {
    const s = await stack();
    await runOf(s, mailbox(MAIL).source);
    const [ada] = await rows<{ entity_id: string }>(s, "select entity_id from knowledge.accounts where value_fp = $1", [
      fingerprint(s.db.keys, "address", "ada@example.com"),
    ]);
    const erased = await pi(["erase", "person", ada?.entity_id ?? ""], ownerEnv(s));
    expect(erased.exit, erased.stderr).toBe(0);
    const before = await count(s, "vault.evidence_items");

    const CY = "Cy Example <cy@example.com>";
    // Never stored, so no removed-evidence row can stop them: the suppression must.
    const later = mailbox([
      sentTo("7a", `${ADA}, ${CY}`, 600),
      message("7b", CY, `${OWNER}, ${ADA}`, days(800)),
      message("7c", CY, OWNER, days(810)),
    ]);
    const [run] = await runOf(s, later.source);
    expect(run?.tally).toMatchObject({ suppressed: 2, stored: 1 });
    expect(await count(s, "vault.evidence_items")).toBe(before + 1);
    expect(await count(s, "vault.sent_recipients")).toBe(0);
  });

  it("stops short of the ceiling, leaving Drive and capture their room", async () => {
    const s = await stack();
    const box = mailbox(MAIL);
    const bytes = await s.writer.databaseBytes();
    // Under the ceiling, and past the part of it the backfill may use.
    const [run] = await runOf(s, box.source, { ceilingBytes: Math.ceil(bytes * 1.1) });
    expect(run?.outcome).toBe("ties_reserve");
    expect(await count(s, "vault.evidence_items")).toBe(0);
    expect(tiesLimitBytes(1000)).toBe(800);
  });

  it("mail read by its headers lifts Social and Forums within the backfill and never for sync", async () => {
    const s = await stack();
    const FAY = "Fay Example <fay@example.com>";
    const answered = sentTo("8a", FAY, 900);
    const social = from("8b", FAY, 800, ["CATEGORY_SOCIAL"]);
    const box = mailbox([answered, social]);
    const [run] = await runOf(s, box.source);
    // Within the backfill the owner wrote to Fay, so Fay's Social mail names a tie.
    expect(run?.tally).toMatchObject({ stored: 2, left: 0, no_tie: 0 });

    const account = (await s.writer.listSourceAccounts()).find((one) => one.connector === "google_mail");
    if (account === undefined) throw new Error("no account");
    // For sync, Fay has not been written to, by address or by thread.
    expect(await s.writer.ownerWrote(account, { sender: "fay@example.com", threadId: answered.threadId })).toEqual({
      sender: false,
      thread: false,
    });
    expect(
      await s.writer.ownerWrote(account, { sender: "fay@example.com", threadId: answered.threadId, headers: true }),
    ).toEqual({ sender: true, thread: true });
    // New Social mail from Fay, handed to the writer as sync does, stays bulk.
    const fresh = from("8c", FAY, 2, ["CATEGORY_SOCIAL"]);
    const raw = gmailItem(fresh, { sourceAccount: account.id, changeKind: "live" });
    await s.writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS));
    const [row] = await rows<{ bulk: boolean }>(s, "select bulk from knowledge.messages");
    expect(row?.bulk).toBe(true);
  });

  it("fetches a batch again after a long wait for the lock, so a message deleted meanwhile is not stored", async () => {
    const s = await stack();
    const box = mailbox([from("6a", ADA, 400), from("6b", ADA, 410)]);
    const writer = createWriter({
      url: s.db.urls.writer,
      keys: s.db.keys,
      log: s.log,
      journal: journalPath(s.db.keyFile),
    });
    let refused = 0;
    const held: Writer = {
      ...writer,
      withSyncLock: async (work) => {
        if (refused >= 5) return writer.withSyncLock(work);
        refused += 1;
        // Deleted at the source after the first fetch, while the lock is held elsewhere.
        if (box.fetched.length > 0 && box.fetched.includes("6a")) box.remove("6a");
        return "already_running";
      },
    };
    try {
      const [run] = await runOf(s, box.source, { writer: held });
      expect(run).toMatchObject({ outcome: "ok", tally: { stored: 1, gone: 1 } });
      expect(await count(s, "vault.evidence_items")).toBe(1);
    } finally {
      await writer.close();
    }
  });

  it("a window before the epoch is listed from the epoch", async () => {
    const s = await stack();
    const box = mailbox([]);
    await runOf(s, box.source, { days: 99_999 });
    expect(box.windows[0]?.after).toBe(0);
  });

  it("the window bounds what is listed", async () => {
    const s = await stack();
    const box = mailbox(MAIL);
    const [run] = await runOf(s, box.source, { days: 750 });
    expect(run?.tally.listed).toBe(1);
    expect(box.windows[0]?.after).toBe(Math.floor((NOW.getTime() - 750 * DAY) / 1000));
  });
});
