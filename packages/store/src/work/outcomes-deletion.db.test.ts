import type { SourceAccountId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { one } from "../test-support/connections.ts";
import {
  accountOf,
  addressFp,
  assessmentOf,
  assessOutcomes,
  DAY,
  daysAfter,
  links,
  matchOutcomes,
  reply,
  send,
} from "../test-support/learning-fixtures.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { type WorkWorld, withWorkWorld } from "../test-support/work-fixtures.ts";
import { createWriter } from "../write/writer.ts";
import type { SourceAccountRow } from "../write/writer-types.ts";

// Made-up values only.

const base = (daysBack: number): Date => new Date(Math.floor(Date.now() / 1000) * 1000 - daysBack * DAY);

// A send answered in its thread, linked and assessed `met`, its reply stored under a source id
// the test names, as a sync would have stored it.
async function answeredSend(world: WorkWorld, thread: string) {
  const drafter = await world.agent();
  const account = await accountOf(world);
  const recipient = addressFp(world, `${thread}@send-example.test`);
  const at = base(10);
  const sent = await send(world, { drafter, account, recipients: [recipient], thread, begunAt: at, state: "sent" });
  const answer = await reply(world, account, { thread, from: recipient, at: daysAfter(at, 1) });
  const sourceItemId = `out-reply-${thread}`;
  await world.admin("update vault.evidence_items set source_item_fp = $2 where id = $1", [
    answer.evidence,
    fingerprint(world.db.keys, "source_id", sourceItemId),
  ]);
  expect(await matchOutcomes(world, daysAfter(at, 2))).toBe(1);
  expect(await assessOutcomes(world, daysAfter(at, 2))).toBe(1);
  return { sent, answer, account, sourceItemId };
}

describe("a source deletion of a reply, through sync", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a source deletion of the reply taints its link and assessment", () =>
    withWorkWorld(async (world) => {
      const deleted = await answeredSend(world, "deleted-at-source");
      const kept = await answeredSend(world, "kept-at-source");
      expect((await assessmentOf(world, deleted.sent.id))?.result).toBe("met");
      const keptLink = (await links(world)).find((link) => link.ref_id === kept.answer.id);

      const writer = createWriter({ url: world.db.urls.writer, keys: world.db.keys, log: world.log });
      try {
        const account = { id: deleted.account, compartment: "own" } as SourceAccountRow;
        await writer.applyDeletion(account, {
          sourceAccount: deleted.account as SourceAccountId,
          sourceItemId: deleted.sourceItemId,
          deletedAt: new Date().toISOString(),
        });
      } finally {
        await writer.close();
      }

      // The message is gone, and its link keeps only the message id it was about.
      expect(
        one(
          await world.admin<{ n: number }>("select count(*)::int as n from knowledge.messages where id = $1", [
            deleted.answer.id,
          ]),
        ).n,
      ).toBe(0);
      const link = (await links(world)).find((row) => row.ref_id === deleted.answer.id);
      expect(link).toMatchObject({ evidence_id: null, ref_kind: "message", ref_id: deleted.answer.id });
      expect(link?.tainted_at).not.toBeNull();
      expect((await assessmentOf(world, deleted.sent.id))?.tainted_at).not.toBeNull();
      // The control: the other send's link and assessment are whole.
      expect((await links(world)).find((row) => row.ref_id === kept.answer.id)).toEqual(keptLink);
      expect((await assessmentOf(world, kept.sent.id))?.tainted_at).toBeNull();
      // A tick after it links and assesses nothing again: the deleted reply is no result.
      expect(await matchOutcomes(world, new Date())).toBe(0);
      expect(await assessOutcomes(world, new Date())).toBe(0);
    }));
});
