import { Claim } from "@intelligence/contracts";
import {
  BELIEF_TYPES,
  type BeliefClaim,
  ClaimRecord,
  FactGrouping,
  GroupingMode,
  isSystemNotice,
} from "@intelligence/contracts/personal";
import type { BeliefInputs } from "@intelligence/personal-beliefs";
import { THE_OWNER } from "@intelligence/personal-core";
import { type Query, stamp } from "../core/db.ts";
import { claimKey } from "../core/fingerprint.ts";
import { asItemSays } from "../core/item-origin.ts";
import type { Keys } from "../core/keys.ts";
import { LINK_TYPES, TITLE_LINK_TYPE, titleLinkKeyOf } from "../core/link-types.ts";
import { open, type Sealed } from "../core/seal.ts";
import { OWNER_ENTITY } from "../core/statements.ts";
import { agentConfirmedKeys, answeredEvidence, confirmedKeys, namedOnly, relayedKeys } from "./pipeline-read.ts";
import { checkOf, relationOf, settlementOf, switchOf } from "./relations-read.ts";

// The claims the belief build counts, grouped by fact key, from the rows the store read: the
// pipeline's beliefClaims (all of them, as pi_pipeline) and the reader's policy.belief_inputs (the
// keys asked, within the caller's clearance, as of a time) share this one rule. Every hold
// beliefClaims applied after its query is here, unchanged.

// One claim row as the query gave it. `agent_output`: its item is an agent app's moment and the
// claim no project link; `linked`: its item's capture names a calendar event.
type BeliefClaimRow = {
  id: string;
  evidence_id: string;
  fact_key_fp: string;
  legacy: string[];
  carried: string[];
  compartments: string[];
  content_enc: Sealed;
  agent_output: boolean;
  linked: boolean;
  // Its item is an agent record, and one a typed write made.
  agent_item: boolean;
  typed: boolean;
};

// What the rule asks of the store besides the rows: the records the owner answered, the records
// whose release is in force, the items of agent closes that were reopened, and the owner's entity.
type BeliefClaimSources = {
  query: Query;
  keys: Keys;
  answered: (evidenceIds: string[]) => Promise<Set<string>>;
  inForce: () => Promise<Set<string>>;
  reopened: () => Promise<Set<string>>;
  owner: string | undefined;
  // A computed belief's clearance, for the forgery bound (namedOnly's `within`); none for the
  // stored build, which reads every account.
  within?: readonly string[];
};

// Any other claim it does not hold.
export function holdsTitleLink(
  record: ClaimRecord,
  factKeyFp: string,
  keys: Keys,
  confirmed: ReadonlySet<string>,
): boolean {
  return record.claim.content.type === TITLE_LINK_TYPE && !confirmed.has(titleLinkKeyOf(keys, factKeyFp));
}

async function beliefGroupsOf(
  rows: readonly BeliefClaimRow[],
  sources: BeliefClaimSources,
): Promise<{ factKeyFp: string; claims: BeliefClaim[] }[]> {
  const { query, keys, owner } = sources;
  const direct = { query, keys };
  const records = rows.map((row) => ({
    row,
    record: asItemSays(ClaimRecord.parse(JSON.parse(open(keys, row, "knowledge.claims.content_enc", "throw"))), row),
  }));
  // A claim's keys: by its own fact key, and by its version 1 key, which a card the owner answered
  // before the go names. Either confirms the claim of its own record or item.
  const keysOf = (row: { evidence_id: string; fact_key_fp: string; legacy: string[] }): string[] =>
    [row.fact_key_fp, ...row.legacy].map((fp) => claimKey(direct.keys, row.evidence_id, fp));
  // A question of the owner's about themselves may have been confirmed on its about_you card, keyed as
  // an agent record's claim is.
  const asked = (record: ClaimRecord): boolean =>
    record.origin === "source" && record.subjectKind === "owner" && record.claim.statementKind === "question";
  const confirmed = await confirmedKeys(
    query,
    records
      .filter((one) => one.record.origin === "agent_record" || asked(one.record))
      .flatMap((one) => keysOf(one.row)),
  );
  const isConfirmed = (row: BeliefClaimRow): boolean => keysOf(row).some((key) => confirmed.has(key));
  // The owner's confirm relayed by an agent, asked only of what the owner has not confirmed
  // themselves: their word relayed, at a tier of its own, never theirs, and with no release.
  const byRelay = await relayedKeys(
    query,
    records
      .filter((one) => (one.record.origin === "agent_record" || asked(one.record)) && !isConfirmed(one.row))
      .flatMap((one) => keysOf(one.row)),
  );
  const isRelayed = (row: BeliefClaimRow): boolean => !isConfirmed(row) && keysOf(row).some((key) => byRelay.has(key));
  // What a second agent confirmed on the card and the owner has not answered or reopened, asked only
  // of what the owner has not confirmed. Below every source.
  const byAgent = await agentConfirmedKeys(
    query,
    records
      .filter((one) => one.record.origin === "agent_record" && !isConfirmed(one.row))
      .flatMap((one) => keysOf(one.row)),
  );
  const isAgentConfirmed = (row: BeliefClaimRow): boolean =>
    !isConfirmed(row) && keysOf(row).some((key) => byAgent.has(key));
  const titleKeys = [
    ...new Set(
      records
        .filter((one) => one.record.claim.content.type === TITLE_LINK_TYPE)
        .map((one) => titleLinkKeyOf(keys, one.row.fact_key_fp)),
    ),
  ];
  const confirmedTitles = await confirmedKeys(query, titleKeys);
  // Or its record answers, in the owner's words, a question the system asked.
  const answered = await sources.answered(
    records.filter((one) => one.record.origin === "agent_record").map((one) => one.row.evidence_id),
  );
  // A released claim counts as the owner's release made it, and the record's own claims it was made
  // from no longer do. Every audience that reads a record's claim reads its released claim too
  // (`own` is within the record's label), so one fact shows once. Only while its release is in
  // force (policy.released_records: unlifted, its decision untainted and unsuperseded, no veto or
  // retire on its record's keys), so a release that ends drops its claim at the next rebuild,
  // whatever the claim row says (invariants 10 and 11).
  const inForce = await sources.inForce();
  const released = new Set(
    records
      .filter((one) => one.record.released !== undefined && inForce.has(one.row.evidence_id))
      .map((one) => one.row.evidence_id),
  );
  // The forgery bound: what a meeting heard that names a person the participant step made from a
  // name alone (its subject or a counterparty) builds no belief until the meeting is linked to a
  // calendar event the box holds (the drain's link, `event_id`, as facts.linked). The claims stay
  // stored. The owner confirming a card about that person would vouch too; the pipeline cannot
  // read the identity cards, so that waits for the owner's grant and fails closed. A chat moment's
  // claim the same, since the sync's step makes people from a chat's names too; a moment is never
  // linked to an event, so such a person's beliefs from chats wait for another vouch and fail
  // closed until then.
  const heard = (record: ClaimRecord): boolean =>
    (record.lane === "meeting" || record.lane === "moment") &&
    !(owner !== undefined && record.claim.assertedBy === owner);
  // Every person the claim names: its subject and the entities of its fields (a counterparty).
  const namedIn = (record: ClaimRecord): string[] => [
    ...(typeof record.claim.content.subject === "string" ? [record.claim.content.subject] : []),
    ...record.entities,
  ];
  const unvouched = await namedOnly(
    query,
    keys,
    [...new Set(records.filter((one) => heard(one.record) && !one.row.linked).flatMap((one) => namedIn(one.record)))],
    sources.within,
  );
  // An agent's close that the owner or its agent reopened counts in no belief; the claim stays
  // stored.
  const reopened = await sources.reopened();
  const groups = new Map<string, BeliefClaim[]>();
  for (const { row, record } of records) {
    if (record.released !== undefined && !inForce.has(row.evidence_id)) continue;
    if (record.origin === "agent_close" && reopened.has(row.evidence_id)) continue;
    if (record.origin === "agent_research" && RESEARCHED_EDGES.has(record.claim.content.type)) continue;
    if (
      record.origin === "agent_record" &&
      record.released === undefined &&
      (released.has(row.evidence_id) ||
        (!isConfirmed(row) && !answered.has(row.evidence_id) && !isAgentConfirmed(row) && !isRelayed(row)))
    )
      continue;
    if (holdsTitleLink(record, row.fact_key_fp, keys, confirmedTitles)) continue;
    const ownerSaid = owner !== undefined && record.claim.assertedBy === owner;
    if (row.agent_output && !ownerSaid) continue;
    if (heard(record) && !row.linked && namedIn(record).some((entity) => unvouched.has(entity))) continue;
    const ownerConfirmed = asked(record) && isConfirmed(row);
    groups.set(row.fact_key_fp, [
      ...(groups.get(row.fact_key_fp) ?? []),
      {
        claim: Claim.parse(record.claim),
        origin: record.origin,
        subjectKind: record.subjectKind,
        ownerSaid,
        ...(row.agent_output && ownerSaid ? { ownLine: true as const } : {}),
        ...(ownerConfirmed ? { ownerConfirmed } : {}),
        ...(isAgentConfirmed(row) && !answered.has(row.evidence_id) ? { agentConfirmed: true as const } : {}),
        ...(isRelayed(row) ? { relayed: true as const } : {}),
        ...(row.carried.length > 0 ? { carried: row.carried } : {}),
        ...(record.lane === "meeting" ? { meeting: true as const } : {}),
        ...(isSystemNotice(record) ? { notice: true as const } : {}),
        // A released claim the owner's standing release made, at the granted-release tier.
        ...(record.released?.grant === true ? { granted: true as const } : {}),
        // The claim keys the relations that name it use.
        keys: keysOf(row),
      },
    ]);
  }
  return [...groups].map(([factKeyFp, claims]) => ({
    factKeyFp,
    claims: claims.some((one) => one.origin !== "agent_research")
      ? claims.filter((one) => one.origin !== "agent_research")
      : claims,
  }));
}

// The types a fill's relation is built as: edges the paths loader walks, never beliefs.
const RESEARCHED_EDGES: ReadonlySet<string> = new Set(["relationship", "connection"]);

// The pipeline's beliefClaims (pi_pipeline): every claim of a type that builds a belief, opened
// under its whole label, grouped by its stored fact key, with its origin. A claim of origin
// agent_record is kept only when the owner confirmed its claim key: policy.confirmed_claims is
// asked in pages of 1 000, and a key it does not answer is not confirmed. That leaves out a claim
// from mail the system sent too: it has that origin and no card. A claim a `reject` in force holds
// for, by its item and its fact key, is left out here, before any belief is built, so it is in no
// belief's support: of every kind. The carry lists joins, splits and the owner's relations too, for
// the computed belief; of the carry this build applies its vetoes and retires alone. Only its
// project link (LINK_TYPES), which code made from the item's own app and host and the owner's
// anchor, counts as any item's does. And a claim code credited to the owner, one of the owner's own
// prompt lines: its speaker is the owner's entity, which only code sets; an agent's line is
// credited to nobody.
export async function beliefClaimsOf(
  query: Query,
  keys: Keys,
): Promise<{ factKeyFp: string; claims: BeliefClaim[] }[]> {
  const rows = await query<BeliefClaimRow>(
    `with items as (select * from policy.carried_ruling_items() where ruling_kind in ('veto', 'retire')),
     typed as (
       select c.*, array_remove(array_remove(array[c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp], null), c.fact_key_fp) as legacy
       from knowledge.claims c where c.type = any ($1::text[]))
     select c.id, c.evidence_id, c.fact_key_fp, c.legacy, c.compartments, c.content_enc,
       exists (select 1 from knowledge.captures k where k.evidence_id = c.evidence_id and k.agent_app) and not (c.type = any ($2::text[])) as agent_output,
       exists (select 1 from knowledge.captures k where k.evidence_id = c.evidence_id and k.event_id is not null) as linked,
       e.source_kind = 'agent_record' as agent_item, e.typed,
       array(select distinct i.ruling_id from items i
             where i.fact_key_fp = any (c.legacy) and i.source_account_id = e.source_account_id and i.source_item_fp = e.source_item_fp
             order by i.ruling_id) as carried
     from typed c join vault.evidence_items e on e.id = c.evidence_id
     where not exists (
         select 1 from policy.rejected_claims() r
         where r.source_account_id = e.source_account_id and r.source_item_fp = e.source_item_fp
           and (r.fact_key_fp = c.fact_key_fp or r.fact_key_fp = any (c.legacy)))
     order by c.fact_key_fp, c.id collate "C"`,
    [[...BELIEF_TYPES], [...LINK_TYPES]],
  );
  const [owner] = await query<{ id: string }>(OWNER_ENTITY);
  return beliefGroupsOf(rows, {
    query,
    keys,
    answered: (evidenceIds) => answeredEvidence(query, evidenceIds),
    inForce: async () =>
      new Set(
        (await query<{ evidence_id: string }>("select evidence_id from policy.released_records()")).map(
          (row) => row.evidence_id,
        ),
      ),
    reopened: async () =>
      new Set(
        (
          await query<{ evidence_id: string }>(
            "select w.evidence_id from ledger.commitment_reopens r join ledger.agent_writes w on w.id = r.close_id where w.evidence_id is not null",
          )
        ).map((one) => one.evidence_id),
      ),
    owner: owner?.id,
  });
}

// policy.belief_inputs' rows.
type InputBase = {
  id: string | null;
  evidence_id: string | null;
  fact_key_fp: string | null;
  other_fp: string | null;
  legacy: string[] | null;
  carried: string[] | null;
  word: string | null;
  at: Date | null;
  compartments: string[];
  body: unknown;
  flags: string[];
};
// Each part fills the columns its branch of the function selects: a ruling's time, a sealed body.
type InputRow =
  | (InputBase & { part: "settings" })
  | (InputBase & { part: "claim"; body: Sealed })
  | (InputBase & { part: "veto"; at: Date })
  | (InputBase & { part: "retire"; at: Date })
  | (InputBase & { part: "settlement"; at: Date })
  | (InputBase & { part: "belief_check"; at: Date })
  | (InputBase & { part: "reclassify"; at: Date; word: "domain" | "kind"; body: Sealed })
  | (InputBase & { part: "fact_ruling"; at: Date; word: "join" | "split" })
  | (InputBase & { part: "grouping"; body: { rung: number; calls: string[] } })
  | (InputBase & { part: "relation"; at: Date; body: { judge?: unknown } | null })
  | (InputBase & { part: "relation_switch"; at: Date; body: { judge?: unknown; on?: unknown; by?: unknown } | null });
type PartRow<P extends InputRow["part"]> = Extract<InputRow, { part: P }>;

const BELIEF_TYPE_SET: ReadonlySet<string> = new Set(BELIEF_TYPES);

// What `beliefAt` takes for the fact keys asked, as of `asOf`, read by pi_reader under the token
// the transaction already set, in the caller's transaction (one read-only
// repeatable-read snapshot for the whole answer). `keys` holds the keys of the caller's
// compartments alone. Every row is within the caller's clearance, and so are the accounts the
// forgery bound reads, failing closed: a person a hidden account would vouch for is named only (a
// claim the stored build counts may be left out).
export async function readBeliefInputs(
  query: Query,
  keys: Keys,
  factKeyFps: readonly string[],
  asOf: string,
): Promise<BeliefInputs> {
  const rows = await query<InputRow>("select * from policy.belief_inputs($1::text[], $2::timestamptz)", [
    [...factKeyFps],
    asOf,
  ]);
  const [client] = await query<{ compartments: string[] }>("select policy.client_clearance() as compartments");
  return inputsOf(rows, query, keys, client?.compartments ?? []);
}

// The computed read under one clearance: the reader's own statements,
// policy.belief_inputs_under, for one audience, as pi_pipeline, so what it compares is what a
// reader of that clearance would be given.
export async function readBeliefInputsUnder(
  query: Query,
  keys: Keys,
  clearance: readonly string[],
  factKeyFps: readonly string[],
  asOf: string,
): Promise<BeliefInputs> {
  const rows = await query<InputRow>(
    "select * from policy.belief_inputs_under($1::text[], $2::text[], $3::timestamptz)",
    [[...clearance], [...factKeyFps], asOf],
  );
  return inputsOf(rows, query, keys, clearance);
}

async function inputsOf(
  rows: readonly InputRow[],
  query: Query,
  keys: Keys,
  within: readonly string[],
): Promise<BeliefInputs> {
  const of = <P extends InputRow["part"]>(part: P): PartRow<P>[] =>
    rows.filter((row): row is PartRow<P> => row.part === part);
  const settings = of("settings")[0];
  const claimRows = of("claim").filter((row) => BELIEF_TYPE_SET.has(row.word ?? ""));
  const flagged = (flag: string): Set<string> =>
    new Set(claimRows.filter((row) => row.flags.includes(flag)).map((row) => row.evidence_id ?? ""));
  const groups = await beliefGroupsOf(
    claimRows.map((row) => ({
      id: row.id ?? "",
      evidence_id: row.evidence_id ?? "",
      fact_key_fp: row.fact_key_fp ?? "",
      legacy: row.legacy ?? [],
      carried: row.carried ?? [],
      compartments: row.compartments,
      content_enc: row.body,
      agent_output: row.flags.includes("agent_app") && !LINK_TYPES.includes(row.word ?? ""),
      linked: row.flags.includes("linked"),
      agent_item: row.flags.includes("agent_item"),
      typed: row.flags.includes("typed"),
    })),
    {
      query,
      keys,
      answered: async () => flagged("answered"),
      inForce: async () => flagged("released"),
      reopened: async () => flagged("reopened"),
      owner: settings?.id ?? undefined,
      within,
    },
  );
  const ruling = (row: PartRow<"retire" | "reclassify">) => ({
    id: row.id ?? "",
    factKeyFp: row.fact_key_fp ?? "",
    at: stamp(row.at),
    compartments: row.compartments,
  });
  return {
    groups,
    decisions: of("veto").map((row) => ({
      id: row.id ?? "",
      kind: "veto" as const,
      targetKind: "belief" as const,
      targetId: row.fact_key_fp ?? "",
      decidedBy: THE_OWNER,
      decidedAt: stamp(row.at),
      label: { compartments: row.compartments, readers: [THE_OWNER] },
    })),
    retirements: of("retire").map(ruling),
    reclassifications: of("reclassify").map((row) => ({
      ...ruling(row),
      verdict: row.word,
      value: open(
        keys,
        { id: row.id ?? "", compartments: row.compartments, value_enc: row.body },
        "knowledge.belief_rulings.value_enc",
        "throw",
      ),
    })),
    goAt: settings?.at == null ? null : stamp(settings.at),
    factRulings: of("fact_ruling").map((row) => ({
      id: row.id ?? "",
      verdict: row.word,
      a: row.fact_key_fp ?? "",
      b: row.other_fp ?? "",
      at: stamp(row.at),
      compartments: row.compartments,
    })),
    groupings: of("grouping").map((row) => {
      const body = row.body;
      return FactGrouping.parse({
        audience: [...(row.legacy ?? [])].sort(),
        keys: [row.fact_key_fp, row.other_fp],
        band: row.word,
        rung: body.rung,
        state: "accepted",
        calls: body.calls,
      });
    }),
    groupingMode: GroupingMode.parse(settings?.word ?? "shadow"),
    // The relations between two claims returned, and the switch rows.
    relations: of("relation").map((row) =>
      relationOf({
        id: row.id ?? "",
        from_claim_key: row.fact_key_fp ?? "",
        to_claim_key: row.other_fp ?? "",
        kind: row.word ?? "",
        judged_by: String(row.body?.judge ?? ""),
        judged_at: row.at,
        compartments: row.compartments,
      }),
    ),
    switches: of("relation_switch").map((row) => {
      const body = row.body;
      return switchOf({
        kind: row.word ?? "",
        judge: String(body?.judge ?? ""),
        switched_on: body?.on === true,
        decided_by: String(body?.by ?? "system"),
        decided_at: row.at,
      });
    }),
    // The agents' settlements in force and the model checks of beliefs.
    settlements: of("settlement").map((row) =>
      settlementOf({
        id: row.id ?? "",
        a_key: row.fact_key_fp ?? "",
        b_key: row.other_fp ?? "",
        holds_key: row.word ?? "",
        created_at: row.at,
        compartments: row.compartments,
      }),
    ),
    beliefChecks: of("belief_check").map((row) =>
      checkOf({
        claim_keys: row.legacy ?? [],
        verdict: row.word ?? "",
        created_at: row.at,
        compartments: row.compartments,
      }),
    ),
  };
}
