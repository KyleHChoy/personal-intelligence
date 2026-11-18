import { EntityId, MessageId } from "@intelligence/contracts/personal";
import type { GmailMessage, PersonalSource } from "@intelligence/personal-core/items";
import { world } from "@intelligence/personal-core/testing";
import { fingerprint } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_OK,
  accountOf,
  accountStates,
  addressesIn,
  cleanUp,
  count,
  DAY,
  eventsLogged,
  first,
  gmailId,
  isJunk,
  isSent,
  isStored,
  keptBy,
  kindsOf,
  LONG,
  labelled,
  message,
  NELL,
  NOW,
  ok,
  personalOf,
  readerOf,
  rows,
  type Stack,
  sourcesOf,
  stack,
  stacks,
  sync,
  syncedLine,
  threeAtATime,
  withAdmin,
} from "../test-support/sync-db-fixtures.ts";
import { runSync } from "./sync.ts";

// runSync's junk and category rules: Spam, Promotions, Updates, Social, and sent mail.
// Shared setup is in sync-db-fixtures.ts.

// The machine is shared: a test that makes a database and syncs the world may take a while.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
afterEach(cleanUp);

describe("runSync", () => {
  it(
    "a message moved out of Spam to the inbox is stored and becomes a person's",
    async () => {
      const { s, all, gmail, id, held } = await labelled(["SPAM"]);
      expect(await sync(s, all)).toEqual(ALL_OK);
      // First seen in spam, it is junk: nothing of it is stored.
      expect(await held()).toEqual({ revisions: 0, messages: 0, interactions: 0, nell: [] });

      // The owner moves it to the inbox. History reports the label change, the message is read
      // again, and it is stored as a new message is: its first revision, and a person's.
      gmail.relabel(id, ["INBOX"]);
      const calls = gmail.calls;
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await held()).toEqual({ revisions: 1, messages: 1, interactions: 1, nell: ["person"] });
      // It read history, not the mailbox again: the profile, one page of changes, one empty page.
      expect(gmail.calls - calls).toBe(3);
    },
    LONG,
  );

  it(
    "a stored message marked spam is removed",
    async () => {
      const { s, all, gmail, id, to, held } = await labelled(["INBOX"]);
      // A second stored message, from a person only it names, which Gmail will move to Promotions.
      const ORLA = "orla.finn@example.org";
      const promoted = "19c0000000000002";
      gmail.add(message(promoted, `Orla Finn <${ORLA}>`, to, 31));
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await held()).toEqual({ revisions: 1, messages: 1, interactions: 1, nell: ["person"] });
      expect(await kindsOf(s, ORLA)).toEqual(["person"]);
      // The two messages' blobs, by the references their evidence rows hold now.
      const fps = [id, promoted].map((one) => fingerprint(s.db.keys, "source_id", gmailId(one)));
      const refs = (
        await rows<{ blob_ref: string }>(
          s,
          "select blob_ref from vault.evidence_items where source_item_fp = any($1)",
          [fps],
        )
      ).map((row) => row.blob_ref);
      const blobs = (): Promise<number> => count(s, "vault.evidence_blobs", "blob_ref = any($1)", [refs]);
      expect(await blobs()).toBe(2);
      const stored = await count(s, "vault.evidence_items");
      const mail = await accountOf(s, "personal", "google_mail");

      // The owner marks one spam, and Gmail moves the other to Promotions. Each is removed as a
      // message deleted at the source is: its evidence, its blob, the rows derived from it, and
      // the person only it named.
      gmail.relabel(id, ["SPAM"]);
      gmail.relabel(promoted, ["INBOX", "CATEGORY_PROMOTIONS"]);
      s.events.length = 0;
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await held()).toEqual({ revisions: 0, messages: 0, interactions: 0, nell: [] });
      expect(await isStored(s, gmailId(promoted))).toBe(false);
      expect(await kindsOf(s, ORLA)).toEqual([]);
      expect(await blobs()).toBe(0);
      // Nothing else went, nothing is counted as skipped, and one line says how many were left out.
      expect(await count(s, "vault.evidence_items")).toBe(stored - 2);
      expect((await accountStates(s))[0]).toMatchObject({ connector: "google_mail", outcome: "ok", skipped: 0 });
      expect(eventsLogged(s, "items_not_stored")).toEqual([
        { event: "items_not_stored", ids: { account: mail.id }, counts: { junk: 2, category: 0 } },
      ]);

      // Back in the inbox it is stored as a new message is, and marked spam again it is removed again.
      gmail.relabel(id, ["INBOX"]);
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await held()).toEqual({ revisions: 1, messages: 1, interactions: 1, nell: ["person"] });
      gmail.relabel(id, ["SPAM"]);
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await held()).toEqual({ revisions: 0, messages: 0, interactions: 0, nell: [] });
    },
    LONG,
  );

  it(
    "a sent message under Promotions is stored",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      expect(await sync(s, all)).toEqual(ALL_OK);
      // An address of the owner's that no other item names, on a message Gmail filed under
      // Promotions; and beside it a received message under the same label. History hands both over.
      const alias = "side.desk@quinn.test";
      expect(w.owner.addresses).not.toContain(alias);
      personal.gmail.add(
        message("19c0000000000001", `Side Desk <${alias}>`, NELL, 30, { labels: ["SENT", "CATEGORY_PROMOTIONS"] }),
      );
      personal.gmail.add(
        message("19c0000000000002", `Nell Ashdown <${NELL}>`, first(w.owner.addresses), 31, {
          labels: ["INBOX", "CATEGORY_PROMOTIONS"],
        }),
      );
      s.events.length = 0;
      expect(await sync(s, all)).toEqual(ALL_OK);

      // SENT wins: the sent message is stored, and its sender is an owner address. It is still
      // bulk, so nothing else is derived from it.
      expect(await isStored(s, gmailId("19c0000000000001"))).toBe(true);
      expect(await kindsOf(s, alias)).toEqual(["owner"]);
      expect(
        await count(
          s,
          "knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id",
          "e.source_item_fp = $1",
          [fingerprint(s.db.keys, "source_id", gmailId("19c0000000000001"))],
        ),
      ).toBe(1);
      expect(await kindsOf(s, NELL)).toEqual([]);
      // The control: the received message under the same label is junk, and it alone of the two.
      expect(await isStored(s, gmailId("19c0000000000002"))).toBe(false);
      const mail = await accountOf(s, "personal", "google_mail");
      expect(eventsLogged(s, "items_not_stored")).toEqual([
        { event: "items_not_stored", ids: { account: mail.id }, counts: { junk: 1, category: 0 } },
      ]);
    },
    LONG,
  );

  it(
    "a full listing that meets junk still reconciles",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      const box = personalOf(w);
      const doomed = first(box.deleteLater);
      const spam = first(box.messages.filter(isJunk)).id;
      const marked = w.handles.noMessageIdMessageId;
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await isStored(s, gmailId(doomed))).toBe(true);
      expect(await isStored(s, gmailId(marked))).toBe(true);
      expect(await isStored(s, gmailId(spam))).toBe(false);

      // A message is deleted at the source, a stored one is marked spam, and a new one arrives
      // under Promotions. With the cursor reset no history reports any of it: the listing does.
      personal.gmail.deletePermanently(doomed);
      personal.gmail.relabel(marked, ["SPAM"]);
      personal.gmail.add(
        message("19c0000000000001", `Nell Ashdown <${NELL}>`, first(w.owner.addresses), 30, {
          labels: ["INBOX", "CATEGORY_PROMOTIONS"],
        }),
      );
      s.events.length = 0;
      expect(await sync(s, all, { reset: ["gmail"] })).toEqual(ALL_OK);

      // Junk is no skipped item: the listing reconciled, and removed the deleted message. The
      // listing's query leaves junk out, so the stored message marked spam is among the stored
      // items no pass named, and is removed with it.
      const mail = await accountOf(s, "personal", "google_mail");
      expect(eventsLogged(s, "reconcile_skipped")).toEqual([]);
      expect(await isStored(s, gmailId(doomed))).toBe(false);
      expect(await count(s, "vault.listed_items")).toBe(0);
      expect(await Promise.all([spam, marked, "19c0000000000001"].map((one) => isStored(s, gmailId(one))))).toEqual([
        false,
        false,
        false,
      ]);
      expect(eventsLogged(s, "account_synced")[0]).toEqual(
        syncedLine(mail.id, { stored: 0, unreadable: 0, removed: 2, held: 0, records_removed: 0 }),
      );
      expect((await accountStates(s))[0]).toMatchObject({ connector: "google_mail", outcome: "ok", skipped: 0 });
      // The positive control: what the listing met that is no junk is still stored.
      expect(await count(s, "vault.evidence_items", "source_account_id = $1", [mail.id])).toBe(keptBy(box).length - 2);
    },
    LONG,
  );

  it(
    "Updates is stored whole",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      const to = first(w.owner.addresses);
      personal.gmail.add({
        ...message("19c0000000000001", "nell.ashdown@example.org", to, 30, { labels: ["INBOX", "CATEGORY_UPDATES"] }),
        text: "Your parcel is on its way.\r\n",
      });
      // The boundary's other side: the same message under Promotions.
      personal.gmail.add(
        message("19c0000000000004", "ivo.hale@example.org", to, 34, { labels: ["INBOX", "CATEGORY_PROMOTIONS"] }),
      );
      expect(await sync(s, all)).toEqual(ALL_OK);

      // Bulk and no junk: its evidence, its blob and its message row with its text are kept, and
      // no entity is derived from it.
      const fp = fingerprint(s.db.keys, "source_id", gmailId("19c0000000000001"));
      expect(await count(s, "vault.evidence_items", "source_item_fp = $1", [fp])).toBe(1);
      expect(
        await count(
          s,
          "vault.evidence_blobs b join vault.evidence_items e on e.blob_ref = b.blob_ref",
          "e.source_item_fp = $1",
          [fp],
        ),
      ).toBe(1);
      expect(
        await count(
          s,
          "knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id",
          "e.source_item_fp = $1 and m.bulk and m.body_enc is not null",
          [fp],
        ),
      ).toBe(1);
      expect(
        await count(
          s,
          "knowledge.interaction_log i join vault.evidence_items e on e.id = i.evidence_id",
          "e.source_item_fp = $1",
          [fp],
        ),
      ).toBe(0);
      expect(await kindsOf(s, "nell.ashdown@example.org")).toEqual([]);
      const read = await readerOf(s);
      const found = await read.reader.findMessages(read.token, { sender: "nell.ashdown@example.org" });
      expect(found.ok && found.value.messages.map((one) => one.category)).toEqual(["updates"]);
      const opened = await read.reader.readMessage(read.token, {
        id: MessageId.parse(found.ok ? found.value.messages[0]?.id : undefined),
      });
      // Its text as the parse leaves it: line ends as line feeds.
      expect(opened.ok && opened.value.text).toEqual({ untrusted: "Your parcel is on its way.\n" });
      expect(await isStored(s, gmailId("19c0000000000004"))).toBe(false);
      // Not counted as left out: the line counts the world's two conditional messages alone, and
      // the listing's query never handed the Promotions message over.
      expect(eventsLogged(s, "items_not_stored").at(-1)).toEqual({
        event: "items_not_stored",
        ids: { account: (await accountOf(s, "personal", "google_mail")).id },
        counts: { junk: 0, category: 2 },
      });
    },
    LONG,
  );

  it(
    "one from someone the owner has written to is stored and is that person's",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      const runnerUp = w.handles.runnerUpAddress;
      // Beside the world's Social message from the runner-up, one from the runner-up with a List-Id.
      const listed = {
        ...message("19c0000000000001", `Tobias Reed <${runnerUp}>`, first(w.owner.addresses), 50, {
          labels: ["INBOX", "CATEGORY_SOCIAL"],
        }),
      };
      personal.gmail.add({ ...listed, headers: [...listed.headers, { name: "List-Id", value: "<club.example.org>" }] });
      expect(await sync(s, all)).toEqual(ALL_OK);

      const derived = async (id: string) => {
        const fp = fingerprint(s.db.keys, "source_id", gmailId(id));
        return {
          messages: await count(
            s,
            "knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id",
            "e.source_item_fp = $1",
            [fp],
          ),
          interactions: await count(
            s,
            "knowledge.interaction_log i join vault.evidence_items e on e.id = i.evidence_id",
            "e.source_item_fp = $1",
            [fp],
          ),
        };
      };
      // The person's: in their timeline, and counted for them.
      expect(await derived(w.handles.socialKeptMessageId)).toEqual({ messages: 1, interactions: 1 });
      const read = await readerOf(s);
      const entity = await withAdmin(s, (admin) => admin.accounts.inspect(runnerUp));
      const timeline = await read.reader.getTimeline(read.token, {
        id: EntityId.parse(entity?.id),
        to: new Date(NOW.getTime() + 30 * DAY).toISOString(),
      });
      expect(timeline.ok && timeline.value.entries.length).toBe(12);
      // With a List-Id it is stored and bulk.
      expect(await derived("19c0000000000001")).toEqual({ messages: 1, interactions: 0 });
    },
    LONG,
  );

  it(
    "one in a thread the owner posted in is stored, and stays bulk",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      expect(await sync(s, sourcesOf(w).all)).toEqual(ALL_OK);
      const fp = fingerprint(s.db.keys, "source_id", gmailId(w.handles.forumsKeptMessageId));
      expect(
        await count(
          s,
          "knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id",
          "e.source_item_fp = $1 and m.bulk",
          [fp],
        ),
      ).toBe(1);
      expect(
        await count(
          s,
          "knowledge.interaction_log i join vault.evidence_items e on e.id = i.evidence_id",
          "e.source_item_fp = $1",
          [fp],
        ),
      ).toBe(0);
      // The control: the Forums message in another thread is left out.
      expect(await isStored(s, gmailId(w.handles.forumsLeftOutMessageId))).toBe(false);
    },
    LONG,
  );

  it(
    "the owner's own message under Social is stored",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      personal.gmail.add(
        message("19c0000000000001", `Avery Quinn <${first(w.owner.addresses)}>`, NELL, 30, {
          labels: ["SENT", "CATEGORY_SOCIAL"],
        }),
      );
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await isStored(s, gmailId("19c0000000000001"))).toBe(true);
      // The control: a stranger's Social message beside it is not.
      expect(await isStored(s, gmailId(w.handles.socialLeftOutMessageId))).toBe(false);
    },
    LONG,
  );

  it(
    "written to from another account does not count",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      // The work account's sent mail writes to the work-only person; a Social message from them
      // arrives in the personal account.
      const workOnly = w.handles.workOnlyAddress;
      expect(w.accounts[1]?.messages.some((one) => isSent(one) && addressesIn(one, ["to"]).includes(workOnly))).toBe(
        true,
      );
      personal.gmail.add(
        message("19c0000000000001", `Devon Marsh <${workOnly}>`, first(w.owner.addresses), 30, {
          labels: ["INBOX", "CATEGORY_SOCIAL"],
        }),
      );
      // Work syncs first here, so the order of labels is no reason either.
      expect(await sync(s, [all[1] as PersonalSource, all[0] as PersonalSource])).toEqual({
        ...ALL_OK,
        outcomes: [...ok("work"), ...ok("personal")],
      });
      expect(await isStored(s, gmailId("19c0000000000001"))).toBe(false);
    },
    LONG,
  );

  it(
    "a message under SENT and SPAM is not stored, makes no owner address and no one written to",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      const spoof = personalOf(w).messages.find((one) => one.id === w.handles.sentSpamMessageId) as GmailMessage;
      const recipient = addressesIn(spoof, ["to"])[0] ?? "";
      // The spoofed message's recipient sends a Social message, and history hands the spoof over too.
      expect(await sync(s, all)).toEqual(ALL_OK);
      const owners = await count(
        s,
        "knowledge.accounts a join knowledge.entities e on e.id = a.entity_id",
        "e.kind = 'owner'",
      );
      personal.gmail.add({
        ...spoof,
        id: "19c0000000000002",
        headers: spoof.headers.map((one) =>
          one.name === "Message-ID" ? { ...one, value: "<spoof-again@id.example.com>" } : one,
        ),
      });
      personal.gmail.add(
        message("19c0000000000003", `Lyle Marr <${recipient}>`, first(w.owner.addresses), 20, {
          labels: ["INBOX", "CATEGORY_SOCIAL"],
        }),
      );
      expect(await sync(s, all)).toEqual(ALL_OK);
      for (const id of [w.handles.sentSpamMessageId, "19c0000000000002", "19c0000000000003"])
        expect(await isStored(s, gmailId(id)), id).toBe(false);
      expect(
        await count(s, "vault.sent_recipients", "address_fp = $1", [fingerprint(s.db.keys, "address", recipient)]),
      ).toBe(0);
      expect(
        await count(s, "knowledge.accounts a join knowledge.entities e on e.id = a.entity_id", "e.kind = 'owner'"),
      ).toBe(owners);
      expect(await kindsOf(s, recipient)).toEqual([]);
    },
    LONG,
  );

  it(
    "when the owner replies in a thread, the thread's Social message that was left out is fetched and kept",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      expect(await sync(s, all)).toEqual(ALL_OK);
      // History: the Social message arrives and is left out.
      personal.gmail.add(
        message("19c0000000000001", `Nell Ashdown <${NELL}>`, first(w.owner.addresses), 20, {
          labels: ["INBOX", "CATEGORY_SOCIAL"],
        }),
      );
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await isStored(s, gmailId("19c0000000000001"))).toBe(false);
      // The owner's reply arrives on a later page: the connector hands the thread's Social message over with it.
      personal.gmail.add({
        ...message("19c0000000000002", `Avery Quinn <${first(w.owner.addresses)}>`, NELL, 10, { labels: ["SENT"] }),
        threadId: "19c0000000000001",
      });
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await isStored(s, gmailId("19c0000000000001"))).toBe(true);
      expect(await kindsOf(s, NELL)).toEqual(["person"]);
    },
    LONG,
  );

  it(
    "an earlier Social message from that sender in another thread stays left out until the next listing of the window",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      expect(await sync(s, all)).toEqual(ALL_OK);
      const stranger =
        addressesIn(personalOf(w).messages.find((one) => one.id === w.handles.socialLeftOutMessageId) as GmailMessage, [
          "from",
        ])[0] ?? "";
      // The owner writes to the stranger in a thread of its own, and the stranger's earlier
      // Social message in another thread is not handed over again.
      personal.gmail.add(
        message("19c0000000000001", `Avery Quinn <${first(w.owner.addresses)}>`, stranger, 10, { labels: ["SENT"] }),
      );
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await isStored(s, gmailId(w.handles.socialLeftOutMessageId))).toBe(false);
      // After a reset, the listing of the window meets it again, and it is the stranger's.
      expect(await sync(s, all, { reset: ["gmail"] })).toEqual(ALL_OK);
      expect(await isStored(s, gmailId(w.handles.socialLeftOutMessageId))).toBe(true);
      expect(await kindsOf(s, stranger)).toEqual(["person"]);
    },
    LONG,
  );

  it(
    "a first backfill decides against the whole window's sent mail, whatever the order of the mailbox",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w, { order: "shuffled", pageSize: 2 });
      // The owner wrote to Nell 80 days ago, among the oldest of the window; Nell's Social
      // message is among the newest.
      personal.gmail.add(
        message("19c0000000000001", `Avery Quinn <${first(w.owner.addresses)}>`, NELL, 80 * 24 + 5, {
          labels: ["SENT"],
        }),
      );
      personal.gmail.add(
        message("19c0000000000002", `Nell Ashdown <${NELL}>`, first(w.owner.addresses), 3, {
          labels: ["INBOX", "CATEGORY_SOCIAL"],
        }),
      );
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await isStored(s, gmailId("19c0000000000002"))).toBe(true);
    },
    LONG,
  );

  it(
    "a sent message and a Social message from its recipient on one history page keep the Social message",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      expect(await sync(s, all)).toEqual(ALL_OK);
      // The Social message comes first on the page; the sent one is decided before it.
      personal.gmail.add(
        message("19c0000000000001", `Nell Ashdown <${NELL}>`, first(w.owner.addresses), 6, {
          labels: ["INBOX", "CATEGORY_SOCIAL"],
        }),
      );
      personal.gmail.add(
        message("19c0000000000002", `Avery Quinn <${first(w.owner.addresses)}>`, NELL, 5, { labels: ["SENT"] }),
      );
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await isStored(s, gmailId("19c0000000000001"))).toBe(true);
      expect(await kindsOf(s, NELL)).toEqual(["person"]);
    },
    LONG,
  );

  it(
    "a stored message moved to Social is removed unless the rule keeps it, and one left out is not fetched again until a full listing",
    async () => {
      const { s, all, gmail, id, to, held } = await labelled(["INBOX"]);
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await held()).toEqual({ revisions: 1, messages: 1, interactions: 1, nell: ["person"] });
      // Moved to Social, from a sender never written to: removed with what it named.
      gmail.relabel(id, ["INBOX", "CATEGORY_SOCIAL"]);
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await held()).toEqual({ revisions: 0, messages: 0, interactions: 0, nell: [] });
      // A label change that derives nothing does not hand it over again.
      gmail.relabel(id, ["INBOX", "CATEGORY_SOCIAL", "STARRED"]);
      const fetched = gmail.fetched.length;
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(gmail.fetched.slice(fetched)).toEqual([]);
      // Once the owner has written to Nell, a full listing keeps it, as Nell's.
      gmail.add(message("19c0000000000009", `Avery Quinn <${to}>`, NELL, 2, { labels: ["SENT"] }));
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await held()).toEqual({ revisions: 0, messages: 0, interactions: 0, nell: ["person"] });
      expect(await sync(s, all, { reset: ["gmail"] })).toEqual(ALL_OK);
      expect((await held()).revisions).toBe(1);
      expect((await held()).messages).toBe(1);
    },
    LONG,
  );

  it(
    "killed at any point and rerun, the same messages are kept and left out",
    async () => {
      const w = world({ now: NOW });
      const social = w.handles.socialLeftOutMessageId;
      const stranger =
        addressesIn(personalOf(w).messages.find((one) => one.id === social) as GmailMessage, ["from"])[0] ?? "";
      const reply = {
        ...message("19c0000000000002", `Avery Quinn <${first(w.owner.addresses)}>`, stranger, 20, { labels: ["SENT"] }),
        threadId: social,
      };
      // A first sync of the world, then the owner's reply in the Social message's thread, with
      // the call numbered `killAt` failing and the sync it failed in run again.
      const run = async (s: Stack, killAt?: number): Promise<number> => {
        const { all, personal } = sourcesOf(w, { pageSize: 3 });
        let calls = 0;
        let fired = false;
        const counted = all.map(
          (source): PersonalSource => ({
            ...source,
            connector(id, account, options) {
              const made = source.connector(id, account, options);
              return {
                ...made,
                async listChanges(...given) {
                  calls += 1;
                  if (calls === killAt) {
                    fired = true;
                    throw Object.assign(new Error("unavailable"), { code: "unavailable" });
                  }
                  return made.listChanges(...given);
                },
              };
            },
          }),
        );
        for (const before of [() => {}, () => personal.gmail.add(reply)]) {
          before();
          await runSync({ writer: s.writer, sources: counted, log: s.log, now: NOW });
          if (fired) {
            fired = false;
            expect(
              await runSync({ writer: s.writer, sources: counted, log: s.log, now: NOW }),
              `killed at ${killAt}`,
            ).toEqual(ALL_OK);
          }
        }
        return calls;
      };
      const stored = (s: Stack) =>
        rows(s, "select source_item_fp, revision_tag_fp from vault.evidence_items order by 1, 2");
      const whole = await stack();
      const total = await run(whole);
      const expected = await stored(whole);
      expect(await isStored(whole, gmailId(social))).toBe(true);
      expect(await isStored(whole, gmailId(w.handles.forumsLeftOutMessageId))).toBe(false);
      await threeAtATime(
        Array.from({ length: 12 }, (_, at) => Math.max(1, Math.round(((at + 1) * total) / 13))),
        async (point) => {
          const s = await stack(whole.db.keyFile);
          await run(s, point);
          expect(await stored(s), `killed at call ${point}`).toEqual(expected);
          stacks.splice(stacks.indexOf(s), 1);
          await s.writer.close();
          await s.db.drop();
        },
      );
    },
    LONG,
  );
});
