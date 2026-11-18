import type { EvidenceId, RawItem } from "@intelligence/contracts";
import type { PageFacts } from "@intelligence/personal-core/items";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { sealRow } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";

// A stored page's one row, in the item's transaction. Clear: ids, the keyed fingerprints of its URL
// and host, its fetch time and media type, and its request's subject. A new revision of a page
// keeps the row's id; the database refuses a row whose request does not run or whose account is not
// its request's (the trigger knowledge.pages_of_request).
export async function writePage(
  tx: Tx,
  account: { compartment: string },
  raw: RawItem,
  evidenceId: EvidenceId,
  page: PageFacts,
  previous: string | null,
): Promise<void> {
  const [earlier] =
    previous === null
      ? []
      : await tx.query<{ id: string }>("delete from knowledge.pages where evidence_id = $1 returning id", [previous]);
  const id = earlier?.id ?? newId("pag");
  const sealed = (column: string, value: string) =>
    sealRow(tx.keys, account.compartment, { table: "knowledge.pages", id, column }, value);
  await tx.query(
    `insert into knowledge.pages (id, evidence_id, request_id, url_fp, host_fp, fetched_at, media_type, about_entity_id, page_enc, names_enc, compartments)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      evidenceId,
      page.requestId,
      fingerprint(tx.keys, "url", page.url),
      fingerprint(tx.keys, "host", new URL(page.url).hostname),
      raw.observedAt,
      raw.mediaType,
      page.about,
      sealed("page_enc", JSON.stringify({ url: page.url, title: page.title })),
      sealed("names_enc", JSON.stringify(page.names)),
      [account.compartment],
    ],
  );
}
