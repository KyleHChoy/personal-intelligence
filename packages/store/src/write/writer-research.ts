import { createHash } from "node:crypto";
import {
  CARD_OPTIONS,
  type CardId,
  type FillBody,
  isCoded,
  type PersonalLogger,
  type PersonalRef,
  parseFillBody,
} from "@intelligence/contracts/personal";
import { foldDomain, isProfileKey, namedKey } from "@intelligence/personal-core";
import { addressKind, isFullName } from "@intelligence/personal-core/items";
import { makesPerson, markOf } from "../core/account-kinds.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { raiseCard } from "../core/queue.ts";
import { domainFp, fillDomain, fillIdentity, identityFp } from "../core/research.ts";
import { open, type Sealed, sealUnder } from "../core/seal.ts";
import { IDENTITY_AUTHOR } from "../core/statements.ts";
import type { Tx } from "../core/tx.ts";
import { derivedId } from "../core/work-refs.ts";
import { anySuppressed, identityPort, localNameFps } from "../identity/identity-port.ts";
import { bindName, type NameRules } from "../identity/name-binding.ts";
import { namedScope, namedTodayCap, oneWord } from "./named-binding.ts";
import { DUE_WITH_CALL_MATES } from "./participant-binding.ts";

export type ResearchCounts = {
  fills: number;
  accounts: number;
  domains: number;
  joined: number;
  orgJoined: number;
  carded: number;
  refused: number;
  named: number;
  removed: number;
  failed: number;
};

const RELEASE_LABEL = ["own"];

// The fills in force: taken in, with a body, not flagged, their evidence present; oldest first.
const FILLS = `
  select w.id, w.client_name, w.fill_node, e.fill_identity_fp, e.fill_domain_fp, w.evidence_id, w.compartments, w.body_enc, e.source_item_fp
  from ledger.agent_writes w join vault.evidence_items e on e.id = w.evidence_id
  where w.kind = 'fill' and w.body_enc is not null and w.flagged_at is null and e.payload_state = 'present'
    -- The standing release's label, exactly: own and agent compartments, own included.
    and 'own' = any (w.compartments) and not exists (select 1 from unnest(w.compartments) c where c <> 'own' and not starts_with(c, 'agent:'))
  order by w.created_at, w.id`;
type FillRow = {
  id: string;
  client_name: string;
  fill_node: string;
  fill_identity_fp: string | null;
  fill_domain_fp: string | null;
  evidence_id: string;
  compartments: string[];
  body_enc: Sealed;
  source_item_fp: string;
};

// A fill's tag, which every row it writes carries in its id: so the rows of fills no longer in
// force are found by their ids alone.
export const fillTag = (fill: string): string =>
  createHash("sha256").update(`research fill\n${fill}`, "utf8").digest("hex").slice(0, 16);
// The rows a fill writes, by table and the prefix of their ids. A name row's id must begin `onn_`,
// so its research prefix is `onn_rso`.
export const FILL_ROWS = [
  ["knowledge.accounts", "rsa"],
  ["knowledge.domains", "rsd"],
  ["knowledge.org_names", "onn_rso"],
] as const;
const rowId = (prefix: (typeof FILL_ROWS)[number][1], fill: string, part: string): string =>
  `${prefix}_${fillTag(fill)}_${createHash("sha256").update(part, "utf8").digest("hex").slice(0, 32)}`;
// The request ids of a fill's join and of its card, by the fill and the identifier's fingerprint,
// so `pia research landed` finds them again and a replay answers the join that committed.
const requestOf = (what: string, fill: string, fp: string): string => derivedId(`${what}:${fill}:${fp}`, 43);
export const researchMergeRequest = (fill: string, fp: string): string => requestOf("research merge", fill, fp);
export const researchCardRequest = (fill: string, fp: string): string => requestOf("research card", fill, fp);

// The people who hold an identifier under any label, as the identity port reads them
// (identity-port.ts), and whether each holds it under the label (`within`). The owner under any
// label refuses it; a holder under another label alone means no account and no join.
const HOLDERS = `
  select a.entity_id, min(e.kind) as kind, bool_or(a.compartments <@ $2::text[]) as within
  from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id
  where a.value_fp = $1 and e.kind in ('person', 'owner') group by a.entity_id order by 1`;
const TIED = `
  select (
    exists (
      select 1 from knowledge.interaction_log i left join knowledge.messages m on m.evidence_id = i.evidence_id and not m.held
      where i.entity_id = $1 and i.compartments <@ $2::text[] and (m.id is not null or i.channel = 'mail_headers')
      having bool_or(i.direction = 'outbound') and bool_or(i.direction = 'inbound' and i.entity_role = 'sender'))
    or exists (
      select 1 from knowledge.event_participants p join knowledge.event_details d on d.event_id = p.event_id
      where p.entity_id = $1 and p.compartments <@ $2::text[] and not d.cancelled and coalesce(d.owner_response, 'accepted') in ('accepted', 'tentative'))
    or exists (select 1 from knowledge.contact_addresses k where k.entity_id = $1 and k.compartments <@ $2::text[])) as yes`;
// The names both are known by under the label, each once. The node is the holder by alias only by a
// full name: a first name alone is too common to say two records are one person, and asks the
// owner.
const SAME_ALIAS = `
  select distinct on (x.value_fp) x.id, x.value_enc, x.compartments
  from knowledge.aliases x join knowledge.aliases y on y.value_fp = x.value_fp
  where x.entity_id = $1 and y.entity_id = $2 and x.compartments <@ $3::text[] and y.compartments <@ $3::text[]
  order by x.value_fp, x.id`;
const NODE_FP =
  "select min(value_fp) as fp from knowledge.accounts where entity_id = $1 and compartments <@ $2::text[]";
// The owner's rulings on the two sides ($1 the node's fingerprints, $2 the holder's): a same in force
// between them, and any ruling that sets either apart (the owner's earlier no).
const RULED = `
  select
    coalesce(bool_or(r.verdict = 'same' and r.lifted_at is null and ((r.a_fp = any($1) and r.b_fp = any($2)) or (r.a_fp = any($2) and r.b_fp = any($1)))), false) as joined,
    coalesce(bool_or(((r.verdict = 'different' and r.lifted_at is null and not r.by_agent) or (r.verdict = 'same' and r.lifted_at is not null and not r.lifted_by_deletion) or (r.verdict = 'shared' and r.lifted_at is null))
                     and (r.a_fp = any($1 || $2) or r.b_fp = any($1 || $2))), false) as apart
  from knowledge.identity_rulings r`;

type Outcome = "account" | "domain" | "joined" | "org_joined" | "carded" | "refused" | "none";

async function landIdentity(tx: Tx, fill: FillRow, identity: string, now: Date, log: PersonalLogger): Promise<Outcome> {
  const node = fill.fill_node;
  const fp = identityFp(tx.keys, identity);
  if (await anySuppressed(tx.query, [fp])) return "refused";
  const holders = await tx.query<{ entity_id: string; kind: string; within: boolean }>(HOLDERS, [fp, RELEASE_LABEL]);
  if (holders.some((one) => one.kind === "owner")) return "refused";
  if (holders.some((one) => one.entity_id === node && one.within)) return "none";
  // Held under another label by anyone, the node included: never written under `own`, never joined.
  if (holders.some((one) => !one.within)) return "refused";
  const holder = holders.find((one) => one.entity_id !== node)?.entity_id;
  if (holder === undefined) {
    // A role or bulk address makes no person, so it is no person's identifier.
    const kind = isProfileKey(identity) ? "email" : addressKind(identity, await markOf(tx.query, fp));
    if (!makesPerson(kind)) return "refused";
    const id = rowId("rsa", fill.id, fp);
    await tx.query(
      `insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments, local_name_fps)
       values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing`,
      [
        id,
        node,
        kind,
        fp,
        // As the identity port keys it (identity-port.ts addAccount).
        fingerprint(
          tx.keys,
          "domain",
          isProfileKey(identity) ? identity : foldDomain(identity.slice(identity.indexOf("@") + 1)),
        ),
        sealUnder(tx.keys, RELEASE_LABEL, { table: "knowledge.accounts", id, column: "value_enc" }, identity),
        RELEASE_LABEL,
        localNameFps(tx, identity),
      ],
    );
    return "account";
  }
  // The owner's earlier word on either side, before any card: one of them joined already, or set apart
  // from anyone (a different, a same the owner lifted, a shared address) refuses with no card. Their
  // addresses under the label alone (invariant 6).
  const fps = await tx.query<{ entity_id: string; value_fp: string }>(
    "select distinct entity_id, value_fp from knowledge.accounts where entity_id = any($1::text[]) and compartments <@ $2::text[]",
    [[node, holder], RELEASE_LABEL],
  );
  const nodeFps = fps.filter((one) => one.entity_id === node).map((one) => one.value_fp);
  const holderFps = fps.filter((one) => one.entity_id === holder).map((one) => one.value_fp);
  const [ruled] = await tx.query<{ joined: boolean; apart: boolean }>(RULED, [nodeFps, holderFps]);
  if (ruled?.joined === true) return "none";
  if (ruled?.apart === true) return "refused";
  const tied = (await tx.query<{ yes: boolean }>(TIED, [holder, RELEASE_LABEL]))[0]?.yes === true;
  // Asked only of a tied holder: for anyone else the answer changes nothing, and no name is opened.
  const alias =
    tied &&
    (
      await tx.query<{ id: string; value_enc: Sealed; compartments: string[] }>(SAME_ALIAS, [
        node,
        holder,
        RELEASE_LABEL,
      ])
    ).some((row) => isFullName(open(tx.keys, row, "knowledge.aliases.value_enc", "throw")));
  if (tied && !alias) {
    const nodeFp = (await tx.query<{ fp: string | null }>(NODE_FP, [node, RELEASE_LABEL]))[0]?.fp ?? fp;
    const caseKey = `same:${createHash("sha256").update([nodeFp, fp].sort().join(""), "utf8").digest("hex").slice(0, 40)}`;
    const card = {
      id: newId("crd") as CardId,
      requestId: researchCardRequest(fill.id, fp),
      kind: "same_person",
      author: IDENTITY_AUTHOR,
      options: [...CARD_OPTIONS.same_person],
      target: null,
      refs: [node, holder].map((id) => ({ kind: "entity", id }) as PersonalRef),
      compartments: RELEASE_LABEL,
      expiresAt: null,
      expiresAfterDays: null,
      caseKey,
      run: null,
      body: null,
      bodyFrom: null,
    };
    await raiseCard(tx.query, card, { now, keys: tx.keys, log });
    return "carded";
  }
  const requestId = researchMergeRequest(fill.id, fp);
  const [merged] = await tx.query<{ code: string }>(
    "select code from ledger.policy_merge($1, $2, 'research_identifier', $3, $4)",
    [node, holder, fp, requestId],
  );
  if (merged?.code === "merged") return "joined";
  log.info({ event: "research_join_refused", code: merged?.code ?? "basis_absent" });
  return "refused";
}

const DOMAIN_HOLDER = `
  select d.entity_id from knowledge.domains d join knowledge.entities e on e.id = d.entity_id and e.kind = 'organization'
  where d.domain_fp = $1 and d.compartments <@ $2::text[] order by d.id collate "C" limit 1`;
const NODE_NAMES = `
  select o.id, o.name_fp, o.name_enc, o.evidence_id, o.compartments from knowledge.org_names o
  where o.entity_id = $1 and o.compartments @> $2::text[] and o.compartments <@ $2::text[] and o.id not like 'onn\\_rso\\_%'
  order by o.id`;

async function landDomain(tx: Tx, fill: FillRow, domain: string): Promise<Outcome> {
  const node = fill.fill_node;
  const fp = domainFp(tx.keys, domain);
  if (await anySuppressed(tx.query, [fp])) return "refused";
  const holder = (await tx.query<{ entity_id: string }>(DOMAIN_HOLDER, [fp, RELEASE_LABEL]))[0]?.entity_id;
  if (holder === node) return "none";
  if (holder === undefined) {
    const id = rowId("rsd", fill.id, fp);
    await tx.query(
      "insert into knowledge.domains (id, domain_fp, entity_id, domain_enc, compartments) values ($1, $2, $3, $4, $5) on conflict do nothing",
      [
        id,
        fp,
        node,
        sealUnder(tx.keys, RELEASE_LABEL, { table: "knowledge.domains", id, column: "domain_enc" }, domain),
        RELEASE_LABEL,
      ],
    );
    return "domain";
  }
  // The named organization's name rows become the holder's: reads, paths and later bindings of the
  // name resolve to the domain's organization. The rows research wrote carry the fill's tag.
  const rows = await tx.query<{
    id: string;
    name_fp: string;
    name_enc: Sealed;
    evidence_id: string;
    compartments: string[];
  }>(NODE_NAMES, [node, RELEASE_LABEL]);
  for (const row of rows) {
    const name = open(tx.keys, row, "knowledge.org_names.name_enc", "throw");
    await tx.query("delete from knowledge.org_names where id = $1", [row.id]);
    const id = rowId("onn_rso", fill.id, row.id);
    await tx.query(
      "insert into knowledge.org_names (id, entity_id, name_fp, name_enc, evidence_id, compartments) values ($1, $2, $3, $4, $5, $6) on conflict do nothing",
      [
        id,
        holder,
        row.name_fp,
        sealUnder(tx.keys, row.compartments, { table: "knowledge.org_names", id, column: "name_enc" }, name),
        row.evidence_id,
        row.compartments,
      ],
    );
  }
  return rows.length > 0 ? "org_joined" : "none";
}

// True when it bound one, so the fill is built again with the person in its edge.
async function bindNames(tx: Tx, fill: FillRow, body: FillBody, now: Date): Promise<number> {
  const names = [
    ...new Set(
      (body.fill.relations ?? []).flatMap((one) => (one.other.name === undefined ? [] : [one.other.name.trim()])),
    ),
  ].filter((name) => !oneWord(name));
  if (names.length === 0) return 0;
  const port = identityPort(tx);
  const item = {
    evidenceId: fill.evidence_id,
    sourceItemFp: fill.source_item_fp,
    revisions: [fill.evidence_id],
    label: RELEASE_LABEL,
  };
  const cap = namedTodayCap(tx, RELEASE_LABEL);
  const counts = { bound: 0, ambiguous: 0, created: 0, skipped: 0, capped: 0 };
  let bound = 0;
  for (const name of names) {
    const nameFp = fingerprint(tx.keys, "name", name);
    const [live] = await tx.query<{ id: string }>(
      "select id from knowledge.mention_bindings where evidence_id = $1 and mention_fp = $2 and (lifted_at is null or origin = 'owner') limit 1",
      [fill.evidence_id, nameFp],
    );
    if (live !== undefined) continue;
    const rules: NameRules = {
      scope: namedScope(nameFp, RELEASE_LABEL, null),
      requestId: `research:${fill.evidence_id}`.slice(0, 64),
      key: namedKey,
      eventId: null,
      cap,
    };
    if (await bindName(tx, port, item, name, rules, now, counts)) bound += 1;
  }
  await port.write(RELEASE_LABEL);
  if (bound > 0) await tx.query(DUE_WITH_CALL_MATES, [fill.evidence_id]);
  return bound;
}

// The rows research wrote that no fill in force wrote: their tags are not the tags in force.
async function removeLifted(tx: Tx, tags: string[]): Promise<number> {
  let removed = 0;
  for (const [table, prefix] of FILL_ROWS) {
    // The tag is the 16 characters after the prefix and its underscore.
    const gone = await tx.query<{ id: string }>(
      `delete from ${table} where starts_with(id, $2) and not (substr(id, length($2) + 1, 16) = any($1::text[])) returning id`,
      [tags, `${prefix}_`],
    );
    removed += gone.length;
  }
  return removed;
}

export async function landResearch(
  writer: { direct: Tx; transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> },
  now: Date,
  log: PersonalLogger,
): Promise<ResearchCounts> {
  const counts: ResearchCounts = {
    fills: 0,
    accounts: 0,
    domains: 0,
    joined: 0,
    orgJoined: 0,
    carded: 0,
    refused: 0,
    named: 0,
    removed: 0,
    failed: 0,
  };
  const fills = await writer.direct.query<FillRow>(FILLS);
  const tags: string[] = [];
  for (const fill of fills) {
    tags.push(fillTag(fill.id));
    try {
      await writer.transaction(async (tx) => {
        const body = parseFillBody(open(tx.keys, fill, "ledger.agent_writes.body_enc", "throw"));
        // A body whose node is not the row's names nothing (the row's is the task's).
        if (body === null || body.node !== fill.fill_node) return;
        counts.fills += 1;
        const [node] = await tx.query<{ kind: string }>("select kind from knowledge.entities where id = $1", [
          fill.fill_node,
        ]);
        counts.named += await bindNames(tx, fill, body, now);
        const outcomes: Outcome[] = [];
        const identity = fillIdentity(body.fill);
        if (node?.kind === "person" && identity !== null && fill.fill_identity_fp === identityFp(tx.keys, identity))
          outcomes.push(await landIdentity(tx, fill, identity, now, log));
        const domain = fillDomain(body.fill);
        if (node?.kind === "organization" && domain !== null && fill.fill_domain_fp === domainFp(tx.keys, domain))
          outcomes.push(await landDomain(tx, fill, domain));
        for (const outcome of outcomes) {
          if (outcome === "account") counts.accounts += 1;
          else if (outcome === "domain") counts.domains += 1;
          else if (outcome === "joined") counts.joined += 1;
          else if (outcome === "org_joined") counts.orgJoined += 1;
          else if (outcome === "carded") counts.carded += 1;
          else if (outcome === "refused") counts.refused += 1;
        }
      });
    } catch (error) {
      if (isCoded(error, "unavailable")) throw error;
      counts.failed += 1;
    }
  }
  counts.removed = await writer.transaction((tx) => removeLifted(tx, tags));
  if (Object.values(counts).some((count) => count > 0)) log.info({ event: "research_landed", counts });
  return counts;
}
