import { mentionOrganization } from "@intelligence/personal-core";
import { fingerprint } from "../core/fingerprint.ts";
import type { Tx } from "../core/tx.ts";

// What opening an item reads of a mention or a URL, apart from the item itself.

// `where` reads the domain row as `a`.
export async function domainHolder(
  tx: Tx,
  where: string,
  compartments: string[],
  value: string,
): Promise<string | undefined> {
  const domain = mentionOrganization(value);
  if (domain === null) return undefined;
  const [row] = await tx.query<{ entity_id: string }>(
    `select a.entity_id from knowledge.domains a join knowledge.entities e on e.id = a.entity_id
     where a.domain_fp = $1 and ${where} and e.kind = 'organization' order by a.id collate "C" limit 1`,
    [fingerprint(tx.keys, "domain", domain), compartments],
  );
  return row?.entity_id;
}

const GOOGLE_DOC = /^\/document\/(?:u\/\d{1,3}\/)?d\/([A-Za-z0-9_-]{10,100})(?:\/|$)/;

export function googleDocId(url: string | null): string | null {
  const parsed = url === null ? null : URL.parse(url);
  if (parsed === null || parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "docs.google.com")
    return null;
  return GOOGLE_DOC.exec(parsed.pathname)?.[1] ?? null;
}
