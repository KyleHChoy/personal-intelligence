import {
  CANARY_CLEARANCE,
  type CardId,
  type IdentityBasis,
  IdentityException,
  isCoded,
  type NewCard,
  type PersonalRef,
  PolicyMergeRefusal,
  type SweepSettledCounts,
  sortedLabel,
} from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import type pg from "pg";
import { PERSON_KINDS } from "../core/account-kinds.ts";
import type { AdminContext } from "../core/admin-context.ts";
import { AdminError } from "../core/admin-error.ts";
import { type Query, stamp } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { allRulings, ownerFps } from "../core/identity-rulings.ts";
import { newId, requestIdOf } from "../core/ids.ts";
import type { Keys } from "../core/keys.ts";
import { SYNC_SESSION } from "../core/locks.ts";
import { raiseCard } from "../core/queue.ts";
import { open, type Sealed } from "../core/seal.ts";
import { CARD_STATE, IDENTITY_AUTHOR, notOwnerAddress } from "../core/statements.ts";
import { type DreamMergeCounts, settleDreamMerges } from "./dream-merges.ts";
import { eligible, exceptionOf, groupsOf, type IdentityRuling, namesakesRuled } from "./groups.ts";
import { compareCandidates, localPartNames } from "./identity-bases.ts";
import { holdBackByCards, phonePairs, provableOf } from "./identity-cards.ts";
import { identityPair, type PairInput } from "./identity-pair.ts";
import { IDENTITY_POINTS, pairSubject, rankWithinTiers } from "./identity-points.ts";
import { agentsOn, type QuestionCounts, type Routed, recordsRead, settleQuestions } from "./identity-questions.ts";
import type { Provable } from "./same-person-facts.ts";
import { settleWrongMerges } from "./wrong-merges.ts";

// The sweep: `pi identity sweep`, an owner command as pi_admin, and the end of every `pi sync` as
// pi_writer, under the sync's own lock. It proposes and never decides: it reads candidates by rules
// alone, with no model, in one read transaction, then raises each card in a transaction of its own
// while the author has fewer than ten undecided cards.

// One pair's question, as the caller asks it through completeKeyedWithReplay: its subject, the
// slot as JSON, the refs and the compartments. `mayCall` false asks for a saved answer alone, so a
// replay is never stopped by the cap. The answer is the probability, or undefined for a
// rejection; `live` when the vendor was called. A throw is no answer: the pair waits.
export type IdentityDecideModel = {
  maxCalls: number;
  ask(
    pair: { subject: string; pair: string; refs: string[]; compartments: string[] },
    mayCall: boolean,
  ): Promise<{ p: number | undefined; live: boolean }>;
};

// No live call after this long from the first: the sweep holds the sync lock.
const CALL_WINDOW_MS = 120_000;
const RANK = IDENTITY_POINTS[0];

// Exported for the contact import's dry run.
export const CAP = 10;

type Person = { entity: string; fp: string; compartments: string[] };
// What the sweep needs of its caller: the admin's context, or the writer's.
type SweepContext = Pick<AdminContext, "transaction" | "keys" | "log">;
// A same-person pair's basis, the name fingerprint the name and local-part bases match on, and the
// exception that cards it, if any (exceptionOf, from this read).
type Candidate =
  | {
      kind: "same_person";
      rank: number;
      a: Person;
      b: Person;
      basis: IdentityBasis;
      nameFp: string | null;
      labels: string[];
      exception?: IdentityException;
      heldByCards?: true;
    }
  | { kind: "shared_address"; rank: number; a: Person };

const hex40 = (text: string): string => sha256(text).slice(0, 40);
const caseKeyOf = (candidate: Candidate): string =>
  candidate.kind === "same_person"
    ? `same:${hex40([candidate.a.fp, candidate.b.fp].sort().join(""))}`
    : `shared:${hex40(candidate.a.fp)}`;
const peopleOf = (candidate: Candidate): Person[] =>
  candidate.kind === "same_person" ? [candidate.a, candidate.b] : [candidate.a];
const orderKey = (candidate: Candidate): string =>
  candidate.kind === "same_person" ? [candidate.a.fp, candidate.b.fp].sort().join(" ") : candidate.a.fp;

// Every person with an address, by its one address fingerprint (the least, for a person a re-derive
// has not yet tidied), and the compartments of its account rows. Owner addresses are left out, and
// so are role and bulk accounts and every account the owner's ignore list covers, by its address or
// its domain, or by an address a domain ignore was narrowed to: no card is raised about them. Nor
// about a person of the standing check's: their accounts are left out here.
async function people(query: Query): Promise<Map<string, Person>> {
  const rows = await query<{ entity_id: string; value_fp: string; compartments: string[] }>(
    `select a.entity_id, min(a.value_fp) as value_fp, array_agg(distinct c order by c) as compartments
     from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id and e.kind = 'person'
     cross join unnest(a.compartments) as c
     where a.kind = any($1) and not (a.compartments && $2::text[])
       and ${notOwnerAddress("a.value_fp", "w")}
       and not exists (select 1 from knowledge.ignore_rulings r where r.lifted_at is null
                         and ((r.subject = 'address' and a.value_fp = any (r.value_fps))
                           or (r.subject = 'domain' and (a.domain_fp = any (r.value_fps) or a.value_fp = any (r.address_fps)))))
     group by a.entity_id`,
    [[...PERSON_KINDS], [...CANARY_CLEARANCE]],
  );
  return new Map(
    rows.map((row) => [row.entity_id, { entity: row.entity_id, fp: row.value_fp, compartments: row.compartments }]),
  );
}

const words = (name: string): number =>
  name
    .trim()
    .split(/\s+/u)
    .filter((one) => one !== "").length;

// The time of the newest evidence about each person: its latest interaction, or the latest change
// of a stored contact that lists it.
async function latestOf(query: Query): Promise<Map<string, number>> {
  const rows = await query<{ entity_id: string; at: Date }>(
    `select entity_id, max(at) as at from (
       select entity_id, occurred_at as at from knowledge.interaction_log
       union all
       select a.entity_id, c.updated_at from knowledge.contact_addresses a join knowledge.contacts c on c.id = a.contact_id
     ) as seen group by entity_id`,
  );
  return new Map(rows.map((row) => [row.entity_id, new Date(row.at).getTime()]));
}

// What reading a basis needs: the statements, the keys, every person by entity, the rulings and
// the people a stored contact lists.
type Scope = Readonly<{
  query: Query;
  keys: Keys;
  everyone: ReadonlyMap<string, Person>;
  rulings: IdentityRuling[];
  groups: ReturnType<typeof groupsOf>;
  onContact: ReadonlySet<string>;
}>;
type AliasLabels = Map<string, { entity: string; compartments: string[] }[]>;

// The rows of a list by a key, each key's values in the order read.
function groupedBy<Row, Value>(
  rows: readonly Row[],
  keyOf: (row: Row) => string,
  itemOf: (row: Row) => Value,
): Map<string, Value[]> {
  const out = new Map<string, Value[]>();
  for (const row of rows) {
    const held = out.get(keyOf(row));
    if (held === undefined) out.set(keyOf(row), [itemOf(row)]);
    else held.push(itemOf(row));
  }
  return out;
}

const entityIds = async (query: Query, text: string): Promise<Set<string>> =>
  new Set((await query<{ entity_id: string }>(text)).map((row) => row.entity_id));

// The two people of a pair, when both have an address, the addresses differ and the rulings admit them.
function admitted(scope: Scope, x: string, y: string): [Person, Person] | null {
  const a = scope.everyone.get(x);
  const b = scope.everyone.get(y);
  if (a === undefined || b === undefined || a.fp === b.fp || !eligible(scope.groups, scope.rulings, a.fp, b.fp))
    return null;
  return [a, b];
}

// A pair met by name ranks above strangers when a stored contact lists either of them.
const nameRank = ({ onContact }: Scope, a: Person, b: Person): number =>
  onContact.has(a.entity) || onContact.has(b.entity) ? 2 : 3;

const labelsOf = (aliasLabels: AliasLabels, fp: string, entities: string[]): string[] =>
  (aliasLabels.get(fp) ?? []).filter((one) => entities.includes(one.entity)).flatMap((one) => one.compartments);

// Two people on one stored contact, ranked first when the owner dealt with both directly.
async function contactPairs(scope: Scope, direct: ReadonlySet<string>): Promise<Candidate[]> {
  const pairs = await scope.query<{ a: string; b: string }>(
    `select distinct x.entity_id as a, y.entity_id as b from knowledge.contact_addresses x
     join knowledge.contact_addresses y on y.contact_id = x.contact_id and x.entity_id < y.entity_id`,
  );
  return pairs.flatMap((pair): Candidate[] => {
    const both = admitted(scope, pair.a, pair.b);
    if (both === null) return [];
    const [a, b] = both;
    const rank = direct.has(a.entity) && direct.has(b.entity) ? 0 : 1;
    return [{ kind: "same_person", rank, a, b, basis: "contact", nameFp: null, labels: [] }];
  });
}

// Every alias's label by name fingerprint and person, for a pair's labels and the namesake count
// (fingerprints and ids only).
const aliasLabelsOf = async (query: Query): Promise<AliasLabels> =>
  groupedBy(
    await query<{ entity_id: string; value_fp: string; compartments: string[] }>(
      "select entity_id, value_fp, compartments from knowledge.aliases",
    ),
    (row) => row.value_fp,
    (row) => ({ entity: row.entity_id, compartments: row.compartments }),
  );

// Two people with an alias of one name of two words or more. Neither need be established: a
// stranger who shares a full name is proposed too, and the cap bounds them. Every name a pair shares
// is looked at, once each: one of a single word, or one that does not open, does not hide another
// that qualifies.
type NamedRow = {
  a: string;
  b: string;
  alias_id: string;
  value_fp: string;
  value_enc: Sealed;
  compartments: string[];
};
async function namePairs(scope: Scope, aliasLabels: AliasLabels): Promise<Candidate[]> {
  const named = await scope.query<NamedRow>(
    `select distinct on (x.entity_id, y.entity_id, x.value_fp) x.entity_id as a, y.entity_id as b, x.id as alias_id, x.value_fp, x.value_enc, x.compartments
     from knowledge.aliases x join knowledge.aliases y on y.value_fp = x.value_fp and x.entity_id < y.entity_id
     order by x.entity_id, y.entity_id, x.value_fp, x.id`,
  );
  return named.flatMap((pair): Candidate[] => {
    const both = admitted(scope, pair.a, pair.b);
    if (both === null) return [];
    const [a, b] = both;
    const name = open(
      scope.keys,
      { id: pair.alias_id, compartments: pair.compartments, value_enc: pair.value_enc },
      "knowledge.aliases.value_enc",
      "null",
    );
    if (name === null || words(name) < 2) return [];
    const labels = labelsOf(aliasLabels, pair.value_fp, [a.entity, b.entity]);
    return [{ kind: "same_person", rank: nameRank(scope, a, b), a, b, basis: "name", nameFp: pair.value_fp, labels }];
  });
}

// A person whose address's local part spells a full name another person has as an alias:
// `first.last@`, `first_last@` or `firstlast@`. The name is compared by its keyed fingerprint; only
// the address is opened, and one that does not open is passed over.
async function localPartPairs(scope: Scope, aliasLabels: AliasLabels): Promise<Candidate[]> {
  const aliasHolders = new Map([...aliasLabels].map(([fp, held]) => [fp, [...new Set(held.map((one) => one.entity))]]));
  const addresses = await scope.query<{ entity_id: string; id: string; value_enc: Sealed; compartments: string[] }>(
    `select distinct on (a.entity_id) a.entity_id, a.id, a.value_enc, a.compartments from knowledge.accounts a
     where a.entity_id = any ($1::text[]) and a.value_fp = any ($2::text[]) order by a.entity_id, a.value_fp, a.id`,
    [[...scope.everyone.keys()], [...scope.everyone.values()].map((one) => one.fp)],
  );
  const found: Candidate[] = [];
  for (const row of addresses) {
    if (!scope.everyone.has(row.entity_id)) continue;
    const address = open(scope.keys, row, "knowledge.accounts.value_enc", "null");
    if (address === null) continue;
    for (const name of localPartNames(address)) {
      const nameFp = fingerprint(scope.keys, "name", name);
      for (const holder of aliasHolders.get(nameFp) ?? []) {
        const both = admitted(scope, row.entity_id, holder);
        if (both === null) continue;
        const [a, b] = both;
        const labels = labelsOf(aliasLabels, nameFp, [b.entity]);
        found.push({ kind: "same_person", rank: nameRank(scope, a, b), a, b, basis: "local_part", nameFp, labels });
      }
    }
  }
  return found;
}

// Two saved contacts holding one phone under one name, one listing each person. A father and son, or
// two front desks, can share both, so it is evidence for a question and never a merge, read only
// while agents are asked. It comes after the other bases, so a name's or an address's own holds are
// never displaced.
const phoneCandidates = async (scope: Scope): Promise<Candidate[]> =>
  (await phonePairs(scope.query)).flatMap((pair): Candidate[] => {
    const both = admitted(scope, pair.a, pair.b);
    if (both === null) return [];
    const [a, b] = both;
    return [{ kind: "same_person", rank: 3, a, b, basis: "phone", nameFp: null, labels: pair.labels }];
  });

// An address two stored contacts of one account list under names that share no fingerprint, unless
// a ruling in force already says what it is. Nothing is opened.
async function sharedAddresses(scope: Scope): Promise<Candidate[]> {
  const shared = await scope.query<{ fp: string }>(
    `select distinct one.fp from knowledge.contacts x
     join knowledge.contacts y on y.account_id = x.account_id and x.id < y.id
     cross join unnest(x.address_fps) as one (fp)
     where one.fp = any (y.address_fps) and cardinality(x.name_fps) > 0 and cardinality(y.name_fps) > 0 and not (x.name_fps && y.name_fps)`,
  );
  const byFp = new Map([...scope.everyone.values()].map((one) => [one.fp, one]));
  const ruled = new Set(
    scope.rulings.flatMap((one) =>
      one.liftedAt === null &&
      (one.verdict === "shared" ||
        one.verdict === "single" ||
        one.verdict === "role" ||
        one.verdict === "person" ||
        one.verdict === "same")
        ? [one.aFp, ...(one.bFp === null ? [] : [one.bFp])]
        : [],
    ),
  );
  return shared.flatMap(({ fp }): Candidate[] => {
    const a = byFp.get(fp);
    return a === undefined || ruled.has(fp) ? [] : [{ kind: "shared_address", rank: 4, a }];
  });
}

// Each same-person pair's exception, from this read. Who is established (a stored contact lists
// one of its addresses, a Mac contact as any other, or the owner wrote to one) and whether the owner
// set two holders of the name apart are read only from rows within the pair's labels (invariant 6).
async function markExceptions(scope: Scope, list: Candidate[], aliasLabels: AliasLabels): Promise<void> {
  const accountFps = groupedBy(
    await scope.query<{ entity_id: string; value_fp: string; compartments: string[]; local_name_fps: string[] | null }>(
      "select entity_id, value_fp, compartments, local_name_fps from knowledge.accounts",
    ),
    (row) => row.entity_id,
    (row) => ({ fp: row.value_fp, compartments: row.compartments, names: row.local_name_fps }),
  );
  const listed = groupedBy(
    await scope.query<{ entity_id: string; compartments: string[] }>(
      "select distinct entity_id, compartments from knowledge.contact_addresses",
    ),
    (row) => row.entity_id,
    (row) => row.compartments,
  );
  const sent = groupedBy(
    await scope.query<{ address_fp: string; compartments: string[] }>(
      "select distinct address_fp, compartments from vault.sent_recipients",
    ),
    (row) => row.address_fp,
    (row) => row.compartments,
  );
  const within = (compartments: readonly string[], labels: ReadonlySet<string>): boolean =>
    compartments.every((one) => labels.has(one));
  const established = (entity: string, labels: ReadonlySet<string>): boolean =>
    (listed.get(entity) ?? []).some((compartments) => within(compartments, labels)) ||
    (accountFps.get(entity) ?? []).some((account) =>
      (sent.get(account.fp) ?? []).some((compartments) => within(compartments, labels)),
    );
  for (const candidate of list) {
    if (candidate.kind !== "same_person") continue;
    if (candidate.basis === "local_part") {
      // The first person's account rows whose local part spells the name, as the function reads
      // them: by local_name_fps (the opened address's rows where the backfill has not run yet).
      const name = candidate.nameFp ?? "";
      const rows = (accountFps.get(candidate.a.entity) ?? []).filter((account) =>
        account.names === null ? account.fp === candidate.a.fp : account.names.includes(name),
      );
      candidate.labels = [...rows.flatMap((account) => account.compartments), ...candidate.labels];
    }
    const labels = new Set(candidate.labels);
    const holders = new Set(
      (aliasLabels.get(candidate.nameFp ?? "") ?? [])
        .filter((one) => within(one.compartments, labels))
        .map((one) => one.entity),
    );
    const namesakes =
      candidate.basis === "name" &&
      namesakesRuled(
        scope.rulings,
        [...holders].map((entity) =>
          (accountFps.get(entity) ?? [])
            .filter((account) => within(account.compartments, labels))
            .map((account) => account.fp),
        ),
      );
    const exception = exceptionOf(
      scope.groups,
      scope.rulings,
      candidate.a.fp,
      candidate.b.fp,
      candidate.basis,
      namesakes,
      candidate.basis === "contact" ||
        (established(candidate.a.entity, labels) && established(candidate.b.entity, labels)),
    );
    if (exception !== undefined) candidate.exception = exception;
  }
}

// The pairs rendered in this one read, when the ranking is asked for and its rung is not
// suspended. A pair whose address no longer opens is left out, and keeps its place.
async function renderedPairs(
  scope: Scope,
  list: readonly Candidate[],
  withPairs: boolean,
): Promise<{ pairs: Map<string, PairInput>; suspended: boolean }> {
  const pairs = new Map<string, PairInput>();
  const [suspension] = withPairs
    ? await scope.query<{ id: string }>(
        "select id from policy.rung_suspensions where point = $1 and version = $2 and lifted_at is null",
        [RANK?.id, RANK?.version],
      )
    : [];
  if (withPairs && suspension === undefined) {
    for (const candidate of list) {
      if (candidate.kind !== "same_person") continue;
      const input = await identityPair(scope.query, scope.keys, candidate.a, candidate.b);
      if (input !== null) pairs.set(pairSubject(candidate.a.fp, candidate.b.fp), input);
    }
  }
  return { pairs, suspended: suspension !== undefined };
}

// It opens only the alias of a name two people share, to count its words, and each person's one
// address, to read the name its local part spells.
async function candidatesOf(
  admin: SweepContext,
  query: Query,
  withPairs: boolean,
  withPhones: boolean,
): Promise<{ list: Candidate[]; rulings: IdentityRuling[]; pairs: Map<string, PairInput>; suspended: boolean }> {
  const everyone = await people(query);
  const rulings = await allRulings(query);
  const groups = groupsOf(rulings, await ownerFps(query));
  const latest = await latestOf(query);
  const direct = await entityIds(query, "select distinct entity_id from knowledge.interaction_log");
  const onContact = await entityIds(query, "select distinct entity_id from knowledge.contact_addresses");
  const scope: Scope = { query, keys: admin.keys, everyone, rulings, groups, onContact };
  const fromContacts = await contactPairs(scope, direct);
  const aliasLabels = await aliasLabelsOf(query);
  const found = [
    ...fromContacts,
    ...(await namePairs(scope, aliasLabels)),
    ...(await localPartPairs(scope, aliasLabels)),
    ...(withPhones ? await phoneCandidates(scope) : []),
    ...(await sharedAddresses(scope)),
  ];
  const list = [...groupedBy(found, caseKeyOf, (one) => one).values()].flatMap((held) => held.slice(0, 1));
  await markExceptions(scope, list, aliasLabels);
  // Both known and one full name is the owner's standing rule, but saved cards can say otherwise.
  await holdBackByCards(admin, query, list);
  const newest = (candidate: Candidate): number | null => {
    const times = peopleOf(candidate).flatMap((one) => latest.get(one.entity) ?? []);
    return times.length === 0 ? null : Math.max(...times);
  };
  list.sort((one, other) =>
    compareCandidates(
      { rank: one.rank, latest: newest(one), key: orderKey(one) },
      { rank: other.rank, latest: newest(other), key: orderKey(other) },
    ),
  );
  return { list, rulings, ...(await renderedPairs(scope, list, withPairs)) };
}

const subjectOf = (candidate: Candidate): string =>
  candidate.kind === "same_person" ? pairSubject(candidate.a.fp, candidate.b.fp) : "";

// One question per rendered pair, in the order given, live calls up to the cap and within the
// window; then each tier in the decide model's order. A pair with no answer keeps the sweep's order.
async function ranked(
  admin: SweepContext,
  list: Candidate[],
  pairs: Map<string, PairInput>,
  decideModel: IdentityDecideModel,
  clock: () => number,
): Promise<Candidate[]> {
  const answers = new Map<string, number>();
  let live = 0;
  let first: number | undefined;
  for (const candidate of list) {
    const subject = subjectOf(candidate);
    const input = pairs.get(subject);
    if (input === undefined) continue;
    const mayCall = live < decideModel.maxCalls && (first === undefined || clock() - first <= CALL_WINDOW_MS);
    if (mayCall) first ??= clock();
    try {
      const answer = await decideModel.ask(
        { subject, pair: JSON.stringify(input.slot), refs: input.refs, compartments: input.compartments },
        mayCall,
      );
      if (answer.live) live += 1;
      if (answer.p !== undefined) answers.set(subject, answer.p);
    } catch (error) {
      const code = isCoded(error) ? error.code : undefined;
      admin.log.warn({
        event: "identity_rank_failed",
        ...(typeof code === "string" && /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(code) && code.length <= 64
          ? { code }
          : {}),
      });
    }
  }
  return rankWithinTiers(list, {
    tierOf: (candidate) => candidate.rank,
    subjectOf,
    probability: (subject) => answers.get(subject),
  });
}

const cardOf = (candidate: Candidate, now: Date): NewCard => {
  const refs = peopleOf(candidate).map((one) => ({ kind: "entity", id: one.entity }) as PersonalRef);
  const compartments = sortedLabel(peopleOf(candidate).flatMap((one) => one.compartments));
  const caseKey = caseKeyOf(candidate);
  return {
    id: newId("crd") as CardId,
    requestId: requestIdOf(`${caseKey}:${stamp(now)}`),
    kind: candidate.kind,
    author: IDENTITY_AUTHOR,
    options: candidate.kind === "same_person" ? ["same", "different"] : ["shared", "one_person"],
    target: null,
    refs,
    compartments,
    expiresAt: null,
    expiresAfterDays: null,
    caseKey,
    run: null,
    body: null,
    bodyFrom: null,
  };
};

class Rollback extends Error {}

// Whether the candidate is still admitted, under every ruling in force now.
async function stillEligible(query: Query, candidate: Candidate): Promise<boolean> {
  const rulings = await allRulings(query);
  const groups = groupsOf(rulings, await ownerFps(query));
  if (candidate.kind === "same_person") return eligible(groups, rulings, candidate.a.fp, candidate.b.fp);
  return !rulings.some(
    (one) =>
      one.liftedAt === null &&
      (one.aFp === candidate.a.fp || one.bFp === candidate.a.fp) &&
      one.verdict !== "different",
  );
}

type SweepOptions = { now: Date; decideModel?: IdentityDecideModel; clock?: () => number };
// `settled`: the merges and why pairs were carded or refused, once a merge was asked of
// ledger.policy_merge with the owner's switch on; absent while it is off.
export type SweepCounts = {
  candidates: number;
  raised: number;
  skipped: number;
  settled?: SweepSettledCounts;
  questions?: QuestionCounts;
  dream?: DreamMergeCounts;
};

const zeroSettled = (): SweepSettledCounts => ({
  merged: 0,
  carded: Object.fromEntries(IdentityException.options.map((code) => [code, 0])) as SweepSettledCounts["carded"],
  refused: Object.fromEntries(PolicyMergeRefusal.options.map((code) => [code, 0])) as SweepSettledCounts["refused"],
});

// ledger.policy_merge's code, thrown out of its transaction so the transaction rolls back.
class Answered extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

// One same_person pair asked of ledger.policy_merge, its request id hashed from `request`: the
// code the function answered.
async function policyMerge(
  query: Query,
  candidate: Extract<Candidate, { kind: "same_person" }>,
  request: string,
): Promise<string | undefined> {
  const [row] = await query<{ code: string }>("select code from ledger.policy_merge($1, $2, $3, $4, $5)", [
    candidate.a.entity,
    candidate.b.entity,
    candidate.basis,
    candidate.nameFp,
    requestIdOf(request),
  ]);
  return row?.code;
}

// One merge through ledger.policy_merge, in a transaction whose one lock call is the function's
// own. Its request id is the pair's case key and the sweep's time, so a replay answers the merge
// that committed. A refusal rolls the transaction back and is returned as its code.
async function merge(
  admin: SweepContext,
  candidate: Extract<Candidate, { kind: "same_person" }>,
  now: Date,
): Promise<"merged" | PolicyMergeRefusal> {
  try {
    return await admin.transaction(async (query) => {
      const answer = await policyMerge(query, candidate, `merge:${caseKeyOf(candidate)}:${stamp(now)}`);
      if (answer === "merged") return "merged" as const;
      const code = PolicyMergeRefusal.safeParse(answer);
      throw new Answered(code.success ? code.data : "basis_absent");
    });
  } catch (error) {
    if (error instanceof Answered) return error.code as PolicyMergeRefusal;
    throw error;
  }
}

// `pi identity sweep --dry-run`, as pi_admin: what a sweep would merge and card, by basis and
// exception, writing nothing, whatever the switch says. Each pair no exception holds is asked of
// ledger.policy_merge itself, with the switch set on, in a transaction that is always rolled back:
// so the function's own refusals show too (a shared or role account, an account the local-names
// backfill has not reached, a ruling on a person's other address), and nothing is written.
type DryRun = {
  candidates: number;
  merge: Record<IdentityBasis, number>;
  card: Record<IdentityException | "shared_address", number>;
  refused: Record<Exclude<PolicyMergeRefusal, "merges_off">, number>;
  // While the owner's agents switch is on: what would go to agents instead of a card.
  toAgents: number;
  // Of the pairs code does not settle, how many hold something an agent can read and how many nothing beyond a
  // name. Read `pia identity sweep --dry-run`.
  records: { toRead: number; nothingToRead: number };
  // Of the pairs code does not settle, those with a value from each side that agrees and nothing against it.
  provable: Provable;
  // Pairs saved cards hold back from a merge, a move among them: apart from `card.common_name`, namesakes.
  heldByCards: number;
  pairs: {
    a: string;
    b: string | null;
    basis: IdentityBasis | null;
    outcome: "merge" | IdentityException | "shared_address" | PolicyMergeRefusal;
  }[];
};
export async function dryRunIdentity(admin: SweepContext): Promise<DryRun> {
  const toAgents = await admin.transaction(agentsOn);
  const read = await admin.transaction((query) => candidatesOf(admin, query, false, toAgents));
  const out: DryRun = {
    candidates: read.list.length,
    merge: { contact: 0, phone: 0, name: 0, local_part: 0 },
    card: { ruled_different: 0, lifted_before: 0, common_name: 0, unestablished: 0, shared_address: 0 },
    refused: {
      basis_absent: 0,
      not_established: 0,
      excepted: 0,
      suppressed: 0,
      owner_address: 0,
      not_a_person: 0,
      already_settled: 0,
    },
    toAgents: 0,
    records: { toRead: 0, nothingToRead: 0 },
    heldByCards: 0,
    provable: { pairs: 0, by: { shared_address: 0, same_link: 0, same_company: 0, address_matches_company: 0 } },
    pairs: [],
  };
  const holds = await admin.transaction(recordsRead);
  const unsettled: { a: string; b: string; label: string[] }[] = [];
  for (const candidate of read.list) {
    if (candidate.kind === "shared_address") {
      out.card.shared_address += 1;
      out.pairs.push({ a: candidate.a.entity, b: null, basis: null, outcome: "shared_address" });
      continue;
    }
    if (candidate.exception !== undefined || candidate.basis === "phone") {
      const label = [...new Set([...candidate.a.compartments, ...candidate.b.compartments, ...candidate.labels])];
      if (holds(candidate.a.entity, candidate.b.entity, label)) out.records.toRead += 1;
      else out.records.nothingToRead += 1;
      unsettled.push({ a: candidate.a.entity, b: candidate.b.entity, label });
    }
    if (candidate.basis === "phone") {
      out.toAgents += 1;
      out.pairs.push({
        a: candidate.a.entity,
        b: candidate.b.entity,
        basis: candidate.basis,
        outcome: "unestablished",
      });
      continue;
    }
    if (candidate.exception !== undefined) {
      if (toAgents) out.toAgents += 1;
      if (candidate.heldByCards) out.heldByCards += 1;
      else out.card[candidate.exception] += 1;
      out.pairs.push({
        a: candidate.a.entity,
        b: candidate.b.entity,
        basis: candidate.basis,
        outcome: candidate.exception,
      });
      continue;
    }
    let code: string;
    try {
      await admin.transaction(async (query) => {
        await query("update policy.work_settings set identity_merges = 'on'");
        const answer = await policyMerge(query, candidate, `dry:${caseKeyOf(candidate)}:${Date.now()}`);
        throw new Answered(answer ?? "basis_absent");
      });
      code = "basis_absent";
    } catch (error) {
      if (!(error instanceof Answered)) throw error;
      code = error.code;
    }
    const refusal = PolicyMergeRefusal.safeParse(code);
    if (code === "merged" || !refusal.success || refusal.data === "merges_off") out.merge[candidate.basis] += 1;
    else out.refused[refusal.data] += 1;
    out.pairs.push({
      a: candidate.a.entity,
      b: candidate.b.entity,
      basis: candidate.basis,
      outcome: code === "merged" || !refusal.success ? "merge" : refusal.data,
    });
  }
  out.provable = await provableOf(admin, unsettled);
  return out;
}

// `pi identity sweep`: the sweep under the sync lock, taken on a connection of its own.
export async function proposeIdentity(admin: AdminContext, pool: pg.Pool, options: SweepOptions): Promise<SweepCounts> {
  const session = await pool.connect();
  try {
    const [lock] = (await session.query<{ held: boolean }>(SYNC_SESSION.try)).rows;
    if (lock?.held !== true) throw new AdminError("sync_running");
    try {
      return { ...(await sweepIdentity(admin, options)), dream: await settleDreamMerges(admin) };
    } finally {
      await session.query(SYNC_SESSION.give);
    }
  } finally {
    session.release();
  }
}

// The sweep itself. Its caller holds the sync lock: `proposeIdentity`, or the writer inside
// `withSyncLock` at the end of `pi sync`.
export async function sweepIdentity(admin: SweepContext, options: SweepOptions): Promise<SweepCounts> {
  // The owner's switch: pairs code could not settle go to agents instead of a card each, so no call
  // is made to order cards that will not be raised.
  const toAgents = await admin.transaction(agentsOn);
  const rank = toAgents ? undefined : options.decideModel;
  const read = await admin.transaction((query) => candidatesOf(admin, query, rank !== undefined, toAgents));
  const list =
    rank === undefined || read.suspended
      ? read.list
      : await ranked(admin, read.list, read.pairs, rank, options.clock ?? Date.now);
  const routed: Routed[] = [];
  let raised = 0;
  let skipped = 0;
  const settled = zeroSettled();
  let asked = false;
  // Once ten cards are open no more is raised in this sweep, and the count is not asked again.
  let full = false;
  for (const candidate of list) {
    // A pair no exception holds is merged through ledger.policy_merge; a refusal, or an exception,
    // cards it as before.
    if (candidate.kind === "same_person") {
      if (candidate.basis === "phone") {
        // Evidence for agents, never a merge.
      } else if (candidate.exception === undefined) {
        const outcome = await merge(admin, candidate, options.now);
        if (outcome !== "merges_off") asked = true;
        if (outcome === "merged") {
          settled.merged += 1;
          continue;
        }
        settled.refused[outcome] += 1;
      } else {
        settled.carded[candidate.exception] += 1;
      }
    }
    if (toAgents && candidate.kind === "same_person") {
      routed.push({
        caseKey: caseKeyOf(candidate),
        a: candidate.a,
        b: candidate.b,
        basis: candidate.basis,
        exception: candidate.exception ?? null,
        labels: candidate.labels,
      });
      continue;
    }
    // The cap of ten undecided cards stops only carding: merges go on.
    if (full) continue;
    const undecided = await admin.transaction(
      async (query) =>
        (
          await query<{ n: number }>(
            `select count(*)::int as n from ledger.cards c where c.created_by = $1 and ${CARD_STATE} in ('pending', 'deferred')`,
            [IDENTITY_AUTHOR],
          )
        )[0]?.n ?? 0,
    );
    if (undecided >= CAP) {
      full = true;
      continue;
    }
    const card = cardOf(candidate, options.now);
    try {
      const made = await admin.transaction(async (query) => {
        const got = await raiseCard(query, card, { now: options.now, keys: admin.keys, log: admin.log });
        if (got.id !== card.id) return false;
        if (!(await stillEligible(query, candidate))) throw new Rollback();
        return true;
      });
      if (made) raised += 1;
    } catch (error) {
      if (error instanceof Rollback) continue;
      if (isCoded(error, "not_found")) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  const questions = toAgents ? await settleQuestions(admin, routed, options.now) : undefined;
  if (questions !== undefined) admin.log.info({ event: "identity_questions", counts: questions });
  if (toAgents) await settleWrongMerges(admin); // WM6, WM9: the splits two agents agreed on, under the same switch
  // A sweep with no candidate is no event: the sync's sweep runs at most every ten minutes.
  if (list.length > 0) {
    const carded = Object.fromEntries(Object.entries(settled.carded).map(([code, n]) => [`carded_${code}`, n]));
    const refused = Object.fromEntries(Object.entries(settled.refused).map(([code, n]) => [`refused_${code}`, n]));
    admin.log.info({
      event: "identity_sweep",
      counts: { candidates: list.length, raised, skipped, merged: settled.merged, ...carded, ...refused },
    });
  }
  return {
    candidates: list.length,
    raised,
    skipped,
    ...(asked ? { settled } : {}),
    ...(questions === undefined ? {} : { questions }),
  };
}
