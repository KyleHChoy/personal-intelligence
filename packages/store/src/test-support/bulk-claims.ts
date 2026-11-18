import type { Claim } from "@intelligence/contracts";
import type { ClaimRecord } from "@intelligence/contracts/personal";
import { gmailItemId } from "@intelligence/personal-core";
import { fingerprint } from "../core/fingerprint.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { queryAs } from "./database.ts";
import { knownBy } from "./known-by.ts";
import { batchOf, claimRecord } from "./pipeline-fixtures.ts";
import { recordingLogger } from "./recording.ts";
import type { TestStore } from "./store.ts";
import { storeSeeder, WORLD, WORLD_NOW } from "./world.ts";

// Many claims at once, for the reads whose bounds are tested on a large audience: committed
// through the Pipeline as the extraction would, so the beliefs computed at read count them.

// `count` claims as the extraction would commit them, each its own fact key (`make`'s `key`), so
// the beliefs computed at read are `count` more, each claim one second after the last, the first
// at `at`. They are spread over new messages of the personal mailbox, a thousand claims to each,
// sent at `at` and the minutes before it. The fact key fingerprints, the first oldest, and the
// messages' evidence ids.
const BULK_ITEM = 1000;
export type Bulk = { facts: string[]; items: string[] };
let bulk = 0;
export async function bulkClaims(
  store: TestStore,
  count: number,
  at: Date,
  make: (n: number, at: { evidenceId: string; key: string; validFrom: string }) => ClaimRecord,
): Promise<Bulk> {
  bulk += 1;
  const tag = `bulk-${bulk}`;
  const seed = storeSeeder(store.writer, WORLD_NOW);
  const account = await store.writer.ensureSourceAccount("personal", "google_mail", "own", WORLD.ownerPersonal);
  const facts: string[] = [];
  const items: string[] = [];
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  try {
    for (let start = 0, item = 0; start < count; start += BULK_ITEM, item += 1) {
      const sent = new Date(at.getTime() - (item + 1) * 60_000);
      await seed.mail(account, {
        id: `${tag}-${item}`,
        // The owner's note to themself: no one is written to, so no contact or tie moves.
        from: { address: WORLD.ownerPersonal },
        to: [{ address: WORLD.ownerPersonal }],
        at: sent,
        subject: `canary-${tag}-${item}`,
        sent: true,
      });
      // By its own source item: two bulks at one time send their messages at the same times.
      const [message] = await queryAs<{ evidence_id: string }>(
        store.db.urls.admin,
        "select m.evidence_id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_account_id = $1 and e.source_item_fp = $2",
        [account.id, fingerprint(store.db.keys, "source_id", gmailItemId(`${tag}-${item}`))],
      );
      if (message === undefined) throw new Error(`no message for ${tag}-${item}`);
      items.push(message.evidence_id);
      const claims = Array.from({ length: Math.min(BULK_ITEM, count - start) }, (_, k) => {
        const n = start + k;
        const key = `${tag}-${n}`;
        facts.push(fingerprint(store.db.keys, "fact", key));
        return make(n, {
          evidenceId: message.evidence_id,
          key,
          validFrom: new Date(at.getTime() + n * 1000).toISOString(),
        });
      });
      const outcome = await pipeline.commit(batchOf(message.evidence_id as never, claims));
      if (outcome !== "committed") throw new Error(`the commit of ${tag}-${item} answered ${outcome}`);
    }
  } finally {
    await pipeline.close();
  }
  // Known by the world's date, as a reader pinned to it computes its beliefs.
  await knownBy(store.db, store.now);
  return { facts, items };
}

// `count` commitments, `subject`'s to `counterparty`, undated unless `due` names a day (bulkClaims).
export const bulkCommitments = (
  store: TestStore,
  options: {
    owner: string;
    subject: string;
    counterparty: string;
    count: number;
    at: Date;
    due?: (n: number) => string | undefined;
  },
): Promise<Bulk> =>
  bulkClaims(store, options.count, options.at, (n, { evidenceId, key, validFrom }) => {
    const due = options.due?.(n);
    const base = claimRecord(evidenceId, "own", options.subject, {
      n: n + 1,
      factKey: key,
      validFrom,
      entities: [options.subject, options.counterparty].filter((id) => id !== options.owner),
    });
    return {
      ...base,
      claim: {
        ...base.claim,
        content: {
          ...base.claim.content,
          fields: { counterparty: options.counterparty, what: `canary-${key}`, ...(due === undefined ? {} : { due }) },
        },
      } as Claim,
      subjectKind: options.subject === options.owner ? "owner" : "person",
      fieldKinds: { counterparty: "entity", what: "text", due: "date" },
    } as ClaimRecord;
  });
