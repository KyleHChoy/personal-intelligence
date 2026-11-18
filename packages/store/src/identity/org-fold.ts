import { organizationOfDomain } from "@intelligence/personal-core";
import { byText } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { open, type Sealed } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";

// The refold. An organization is minted and matched by its registrable
// domain, so organizations minted earlier from subdomains are joined by the re-derive, the store's
// one way to rebuild who is who: every organization is derived again, keeping, for each registrable
// domain, one id of those its domains had. No claim is edited: the re-derive deletes what was
// extracted and the next `pi extract` replays its saved calls, as after an owner address. It reads
// the database and the key file, and nothing else.

// What a refold does, in ids and counts: the organizations with a domain row now, those a re-derive
// keeps, each group of two or more by the id it keeps, the organizations whose every domain is a
// provider's now and so are derived as none, and the domain rows whose domain is not their
// organization domain. Nothing to fold is `moved` 0 and `dropped` empty.
export type RefoldPlan = {
  organizations: number;
  after: number;
  joined: { keep: string; fold: string[] }[];
  dropped: string[];
  moved: number;
};

type DomainRow = { id: string; entity_id: string; compartments: string[]; domain_enc: Sealed };

// The plan; the id each organization domain keeps, by the domain's fingerprint, as
// identity-port.ts's KeptIds wants it; and every organization with a domain row now, which the
// re-derive checks for ones gone. An organization keeps the id of one whose domain is the
// registrable domain itself, the lowest such id, and else the lowest id of the group.
export async function refoldPlan(
  tx: Tx,
): Promise<{ plan: RefoldPlan; kept: Map<string, string>; organizations: string[] }> {
  const rows = await tx.query<DomainRow>(
    "select d.id, d.entity_id, d.compartments, d.domain_enc from knowledge.domains d order by d.id",
  );
  const groups = new Map<string, { exact: Set<string>; all: Set<string> }>();
  const entities = new Set<string>();
  const folded = new Set<string>();
  let moved = 0;
  for (const row of rows) {
    entities.add(row.entity_id);
    const domain = open(tx.keys, row, "knowledge.domains.domain_enc", "throw");
    const organization = organizationOfDomain(domain);
    if (organization !== domain) moved += 1;
    if (organization === null) continue;
    folded.add(row.entity_id);
    const group = groups.get(organization) ?? { exact: new Set<string>(), all: new Set<string>() };
    group.all.add(row.entity_id);
    if (organization === domain) group.exact.add(row.entity_id);
    groups.set(organization, group);
  }
  const kept = new Map<string, string>();
  const joined: RefoldPlan["joined"] = [];
  for (const [organization, group] of groups) {
    const keep = [...(group.exact.size > 0 ? group.exact : group.all)].sort(byText)[0] as string;
    kept.set(fingerprint(tx.keys, "domain", organization), keep);
    if (group.all.size > 1) joined.push({ keep, fold: [...group.all].filter((one) => one !== keep).sort(byText) });
  }
  return {
    plan: {
      organizations: entities.size,
      after: new Set(kept.values()).size,
      joined: joined.sort((a, b) => byText(a.keep, b.keep)),
      dropped: [...entities].filter((one) => !folded.has(one)).sort(byText),
      moved,
    },
    kept,
    organizations: [...entities].sort(byText),
  };
}
