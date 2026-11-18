import type { DataKey } from "@intelligence/contracts";
import { RESTRICTED_LOCKED, UNLOCK_WINDOW_MS } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { connect, OWNER, type Who } from "../test-support/cast.ts";
import { insertClient } from "../test-support/clients.ts";
import { readAs } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { ingestMail, mail } from "../test-support/items.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { withStore } from "../test-support/store.ts";
import { createWriter } from "../write/writer.ts";
import type { Keys } from "./keys.ts";
import { createRestrictedUnlock, unwrap, withUnlock, wrapKeys } from "./restricted-lock.ts";
import { open, type Sealed } from "./seal.ts";

// The passkey lock over a real database: a restricted message reaches pi_reader only for a client
// cleared for its category, and then only sealed; it opens only while an unlock holds the key, and
// is locked again when the window ends. While locked, sync's writer stores nothing of an item the
// screen restricts.

const TIMEOUT = 120_000;
const HEALTH = "restricted:health";
const ME: Who = { address: OWNER.personal, name: OWNER.name };
const CLINIC: Who = { address: "rhea.moss@clinic-example.test", name: "Rhea Moss" };
const SUBJECT = "Your lab results b6-lock";

const received = (id: string) =>
  mail({
    id,
    threadId: `thread-${id}`,
    at: "2026-09-02T09:00:00Z",
    from: CLINIC,
    to: [ME],
    subject: SUBJECT,
    labels: ["INBOX"],
    text: "Your lab results are ready.",
    restricted: ["health"],
  });

// The keys a process has once the restricted file is wrapped: the general file's, and health locked.
const locked = (keys: Keys): Keys => ({
  compartments: new Map([...keys.compartments].filter(([name]) => !name.startsWith("restricted:"))),
  fingerprintKey: keys.fingerprintKey,
  locked: new Set([HEALTH]),
});

describe("restricted rows under the passkey lock", { timeout: TIMEOUT }, () => {
  it("pi_reader sees no restricted plaintext: a client not cleared sees no row, a cleared one only a sealed one that opens only while unlocked", () =>
    withStore(
      async ({ db, writer }) => {
        const accounts = await connect(writer);
        expect(await ingestMail(writer, accounts.personalMail, received("gm-b6-lock"))).toBe("stored");

        // The health key as the wrapped file holds it, opened by its recovery secret.
        const health = db.keys.compartments.get(HEALTH) as DataKey;
        const { file, recovery } = wrapKeys(new Map([[HEALTH, health]]));
        const clock = { now: new Date("2026-11-16T12:00:00Z") };
        const unlock = createRestrictedUnlock(() => clock.now);
        const keys = withUnlock(locked(db.keys), unlock);

        const own = await insertClient(db, "b6-own", ["own"]);
        const cleared = await insertClient(db, "b6-cleared", ["own", HEALTH]);
        const restrictedRows = (token: string) =>
          readAs(db, token, (query) =>
            query<{ id: string; compartments: string[]; subject_enc: Sealed }>(
              "select id, compartments, subject_enc from knowledge.messages where $1 = any (compartments)",
              [HEALTH],
            ),
          );
        expect(await restrictedRows(own.token)).toEqual([]);
        const [row, ...more] = await restrictedRows(cleared.token);
        expect(more).toEqual([]);
        if (row === undefined) throw new Error("the cleared client sees no restricted row");
        expect(JSON.stringify(row)).not.toContain("lab results");

        // Locked: the row does not open.
        expect(() => open(keys, row, "knowledge.messages.subject_enc", "throw")).toThrow(
          expect.objectContaining({ code: RESTRICTED_LOCKED }),
        );
        // Unlocked: it does.
        unlock.unlock(unwrap(file, { recovery: Buffer.from(recovery, "base64url") }).keys);
        expect(open(keys, row, "knowledge.messages.subject_enc", "throw")).toBe(SUBJECT);
        // The window ends: locked again.
        clock.now = new Date(clock.now.getTime() + UNLOCK_WINDOW_MS);
        expect(() => open(keys, row, "knowledge.messages.subject_enc", "throw")).toThrow(
          expect.objectContaining({ code: RESTRICTED_LOCKED }),
        );
      },
      { restricted: ["health"] },
    ));

  it("sync's writer, with the restricted key locked, refuses an item the screen restricts as restricted_locked and stores nothing of it", () =>
    withStore(
      async ({ db, writer }) => {
        const accounts = await connect(writer);
        await queryAs(db.urls.admin, "insert into policy.restricted_categories (category) values ('health')");
        const { log } = recordingLogger();
        const lockedWriter = createWriter({ url: db.urls.writer, keys: locked(db.keys), log });
        try {
          // The on categories still match the file: health is there, locked.
          expect(await lockedWriter.restrictedOn()).toEqual(["health"]);
          await expect(ingestMail(lockedWriter, accounts.personalMail, received("gm-b6-skip"))).rejects.toEqual(
            expect.objectContaining({ code: RESTRICTED_LOCKED }),
          );
        } finally {
          await lockedWriter.close();
        }
        const stored = await queryAs<{ n: number }>(
          db.urls.admin,
          "select count(*)::int as n from knowledge.messages where $1 = any (compartments)",
          [HEALTH],
        );
        expect(stored).toEqual([{ n: 0 }]);
        // The positive control: the writer that holds the key stores it.
        expect(await ingestMail(writer, accounts.personalMail, received("gm-b6-skip"))).toBe("stored");
      },
      { restricted: ["health"] },
    ));

  it("the owner's reclassification finds stored mail the term screen restricts, writes nothing on a dry run, and with apply asks for each item and keeps it from every client", () =>
    withStore(
      async ({ db, writer }) => {
        const accounts = await connect(writer);
        // Stored before health was on: under own alone, with a health term in its subject.
        const before = mail({
          id: "gm-b6-old",
          threadId: "thread-gm-b6-old",
          at: "2026-09-01T09:00:00Z",
          from: CLINIC,
          to: [ME],
          subject: "Your lab results are in",
          labels: ["INBOX"],
          text: "See the portal.",
        });
        const plain = mail({
          ...before,
          id: "gm-b6-plain",
          threadId: "thread-gm-b6-plain",
          subject: "Lunch on Friday",
        });
        expect(await ingestMail(writer, accounts.personalMail, before)).toBe("stored");
        expect(await ingestMail(writer, accounts.personalMail, plain)).toBe("stored");
        await queryAs(db.urls.admin, "insert into policy.restricted_categories (category) values ('health')");
        const own = await insertClient(db, "b6-reclassify", ["own"]);
        const visible = () =>
          readAs(db, own.token, (query) => query<{ id: string }>("select id from knowledge.messages"));
        expect(await visible()).toHaveLength(2);

        const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: recordingLogger().log });
        try {
          expect(await admin.restricted.reclassify(false)).toEqual([{ category: "health", items: 1 }]);
          const requests = () =>
            queryAs<{ category: string; requested_by: string }>(
              db.urls.admin,
              "select category, requested_by from vault.restriction_requests",
            );
          expect(await requests()).toEqual([]);
          expect(await visible()).toHaveLength(2);

          expect(await admin.restricted.reclassify(true)).toEqual([{ category: "health", items: 1 }]);
          expect(await requests()).toEqual([{ category: "health", requested_by: "screen" }]);
          // The matched message is kept from the own client; the other is not.
          expect(await visible()).toHaveLength(1);
          // A second run asks nothing again.
          await admin.restricted.reclassify(true);
          expect(await requests()).toHaveLength(1);
        } finally {
          await admin.close();
        }
      },
      { restricted: ["health"] },
    ));
});
