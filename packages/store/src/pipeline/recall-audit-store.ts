import type { RecallCase, RecallRow } from "@intelligence/contracts/personal";
import { ClaimRecord, isSystemNotice, type RecallFilter } from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { composeOpenItems, normalizedLine, type PlanInput } from "@intelligence/personal-core/views";
import { byText } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { type NightOptions, type NightStore, nightStore } from "../core/night-store.ts";
import { open, type Sealed } from "../core/seal.ts";
import { factsSubject } from "../core/stored-forms.ts";
import { zoneOfSetting } from "../core/work-time-read.ts";
import { ownerDayOf } from "../core/zone.ts";
import { claimPassage } from "./claim-passage.ts";
import { restricted } from "./code-relations.ts";

// The recall audit's store, run as pi_pipeline by `pi dream` under the extract lock when the owner has
// turned it on. It finds what the closed filters dropped: a plan's line no open item was made of, by
// composeOpenItems' own reading of the plans; a commitment the bar refused, which keeps no words, so its
// whole message is read and the question is whether anyone promised anything, and only where that
// message holds no commitment at all. Under a clearance, and never a restricted label, so each row
// takes its item's label. A filter's rate is of what was sampled; `population` says of how many. It
// writes one append-only row a check and nothing else. Ids, keys, counts and codes in its log lines.

// How far back a plan's lines are read, as open items read them (read-open-items.ts), and the most read.
const PLAN_DAYS = 90;
const PLAN_ROWS = 500;
// A long message is read in parts, as many as a case may number, each short enough to be sent whole.
const MESSAGE_PART_CHARS = 1_500;
const MESSAGE_PARTS = 6;
const CAUSE = "check_target";
const BAR_FILTER: Readonly<Record<string, RecallFilter>> = {
  not_a_promise: "bar_not_a_promise",
  wrong_direction: "bar_wrong_direction",
};

type RecallCaseRow = RecallCase;
type RecallRowIn = RecallRow;
export type RecallStore = NightStore & {
  cases(
    clearance: readonly string[],
    judge: string,
    now: Date,
    size: number,
    sample: <T>(strata: ReadonlyMap<string, readonly T[]>, total: number) => T[],
  ): Promise<{ cases: RecallCaseRow[]; strata: number; passedOver: number }>;
  save(rows: readonly RecallRowIn[], judge: string): Promise<number>;
  // What this prompt spent today, UTC: the audit's own small budget, within the night's.
  spentToday(promptId: string): Promise<number>;
};

type Candidate = { filter: RecallFilter; targetKey: string; build(population: number): Promise<RecallCaseRow> };
type PlanRow = {
  id: string;
  fact_key_fp: string;
  evidence_id: string;
  valid_from: Date;
  content_enc: Sealed;
  compartments: string[];
  direction: string | null;
  thread_fp: string | null;
  bulk: boolean | null;
  sender_fp: string | null;
  auth: string | null;
};
const PLANS = `
  select c.id, c.fact_key_fp, c.evidence_id, c.valid_from, c.content_enc, c.compartments,
    m.direction, m.thread_fp, m.bulk, m.sender_fp, m.auth
  from knowledge.claims c
  join knowledge.messages m on m.evidence_id = c.evidence_id and not m.held and not m.restricting and m.auth <> 'fail'
  where c.type = 'plan' and not c.released and c.valid_from >= $1 and c.compartments <@ $2::text[]
  order by c.valid_from desc, c.id
  limit ${PLAN_ROWS}`;
const REFUSED = `
  select u.id, u.evidence_id, u.compartments, u.facts_enc, m.id as message_id, m.sent_at, m.subject_enc, m.body_enc, m.compartments as message_compartments
  from vault.unmapped_claims u
  join knowledge.messages m on m.evidence_id = u.evidence_id and not m.held and not m.restricting
  where u.compartments <@ $1::text[] and m.compartments <@ $1::text[]
    and not exists (select 1 from knowledge.claims c where c.evidence_id = u.evidence_id and c.type = 'commitment')
  order by m.sent_at desc, u.id`;

// The message's first parts, or none for one with no words to read. Past them it is not read.
const partsOf = (text: string): string[] => {
  const points = Array.from(text);
  const parts: string[] = [];
  for (let at = 0; at < points.length && parts.length < MESSAGE_PARTS; at += MESSAGE_PART_CHARS)
    parts.push(points.slice(at, at + MESSAGE_PART_CHARS).join(""));
  return parts;
};

export function createRecallStore(options: NightOptions): RecallStore {
  const { keys } = options;
  const { db, shared } = nightStore(options);
  const subjectOf = (targetKey: string, evidenceId: string): string => {
    const read = fingerprint(keys, CAUSE, evidenceId);
    const [a, b] = [targetKey, read].sort(byText) as [string, string];
    return factsSubject(a, b);
  };

  // Each dated line of a plan a closed filter dropped, read as open items read it. Events and closes
  // play no part in those filters, and the owner's own Drop is no filter's.
  async function planCandidates(audience: readonly string[], now: Date): Promise<Candidate[]> {
    const rows = await db.query<PlanRow>(PLANS, [new Date(now.getTime() - PLAN_DAYS * DAY_MS).toISOString(), audience]);
    const [setting] = await db.query<{ time_zone: string | null }>("select time_zone from policy.owner_settings");
    const zone = zoneOfSetting(setting?.time_zone ?? null);
    const byKey = new Map<string, { row: PlanRow; record: ClaimRecord; what: string }>();
    const plans: PlanInput[] = rows.flatMap((row) => {
      const text = open(keys, row, "knowledge.claims.content_enc", "null");
      const parsed = text === null ? null : ClaimRecord.safeParse(JSON.parse(text));
      if (parsed === null || parsed?.success !== true || parsed.data.subjectKind !== "owner") return [];
      const { what, when } = parsed.data.claim.content.fields as { what?: unknown; when?: unknown };
      if (typeof what !== "string") return [];
      // One fact's one line is one item however often it is said, as the read keys it; rows come newest first.
      const key = `${row.fact_key_fp}\n${normalizedLine(what)}`;
      if (!byKey.has(key)) byKey.set(key, { row, record: parsed.data, what });
      return [
        {
          key,
          match: key,
          at: row.valid_from.getTime(),
          what,
          when,
          ownMail: row.direction === "outbound",
          ...(row.bulk === true || isSystemNotice(parsed.data) ? { bulk: true } : {}),
          ...(row.sender_fp === null ? {} : { sender: row.sender_fp }),
          ...(row.auth === "pass" ? { authed: true } : {}),
          ...(row.thread_fp === null ? {} : { thread: row.thread_fp }),
          refs: {},
        },
      ];
    });
    const owner = { id: "owner", kind: "owner", name: null, address: null } as never;
    const { dropped } = composeOpenItems(
      { owner, commitments: [], nextSteps: [], plans, events: [], closes: [] },
      now,
      zone,
    );
    return dropped.flatMap(({ key, filter }) => {
      const found = byKey.get(key);
      if (found === undefined) return [];
      const { row, record, what } = found;
      const targetKey = fingerprint(keys, CAUSE, `recall\n${filter}\n${row.id}`);
      return [
        {
          filter,
          targetKey,
          build: async (population: number) => ({
            filter,
            targetKey,
            evidenceId: row.evidence_id,
            question: "owed" as const,
            line: what,
            passages: [
              { text: await claimPassage(db.query, keys, record, row.evidence_id), at: record.claim.validFrom },
            ],
            population,
            subject: subjectOf(targetKey, row.evidence_id),
            compartments: [...row.compartments].sort(byText),
          }),
        },
      ];
    });
  }

  // What the bar refused keeps no words, so it is an item that holds no commitment and a refusal: at
  // most one case an item a filter, whose whole message is read.
  async function barCandidates(audience: readonly string[]): Promise<Candidate[]> {
    const rows = await db.query<{
      id: string;
      evidence_id: string;
      compartments: string[];
      facts_enc: Sealed;
      message_id: string;
      sent_at: Date;
      subject_enc: Sealed;
      body_enc: Sealed;
      message_compartments: string[];
    }>(REFUSED, [audience]);
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      const facts = open(keys, row, "vault.unmapped_claims.facts_enc", "null");
      if (facts === null) return [];
      const { proposedType, reason } = JSON.parse(facts) as { proposedType?: string; reason?: string };
      const filter = proposedType === "commitment" && reason !== undefined ? BAR_FILTER[reason] : undefined;
      if (filter === undefined || seen.has(`${filter}\n${row.evidence_id}`)) return [];
      seen.add(`${filter}\n${row.evidence_id}`);
      const targetKey = fingerprint(keys, CAUSE, `recall\n${filter}\n${row.evidence_id}`);
      return [
        {
          filter,
          targetKey,
          build: async (population: number) => {
            const message = { ...row, id: row.message_id, compartments: row.message_compartments };
            const text = [
              open(keys, message, "knowledge.messages.subject_enc", "null"),
              open(keys, message, "knowledge.messages.body_enc", "null"),
            ]
              .filter((one) => one !== null)
              .join("\n");
            return {
              filter,
              targetKey,
              evidenceId: row.evidence_id,
              question: "promise" as const,
              line: null,
              passages: partsOf(text).map((part) => ({ text: part, at: row.sent_at.toISOString() })),
              population,
              subject: subjectOf(targetKey, row.evidence_id),
              compartments: [...new Set([...row.compartments, ...row.message_compartments])].sort(byText),
            };
          },
        },
      ];
    });
  }

  return {
    ...shared,
    async cases(clearance, judge, now, size, sample) {
      const audience = [...new Set(clearance)].filter((one) => !restricted([one])).sort(byText);
      const done = new Set(
        (
          await db.query<{ target_key: string }>(
            "select distinct target_key from ledger.recall_checks where judge = $1",
            [judge],
          )
        ).map((row) => row.target_key),
      );
      const everything = [...(await planCandidates(audience, now)), ...(await barCandidates(audience))];
      const population = new Map<RecallFilter, number>();
      for (const one of everything) population.set(one.filter, (population.get(one.filter) ?? 0) + 1);
      const strata = new Map<string, Candidate[]>();
      for (const candidate of everything)
        if (!done.has(candidate.targetKey))
          strata.set(candidate.filter, [...(strata.get(candidate.filter) ?? []), candidate]);
      const cases: RecallCaseRow[] = [];
      let passedOver = 0;
      for (const candidate of sample(strata, size)) {
        const built = await candidate.build(population.get(candidate.filter) ?? 0);
        if (restricted(built.compartments)) passedOver += 1;
        else cases.push(built);
      }
      return { cases, strata: strata.size, passedOver };
    },

    async save(rows, judge) {
      let saved = 0;
      for (const row of rows) {
        if (restricted(row.compartments)) continue;
        await db.query(
          `insert into ledger.recall_checks (filter, target_key, evidence_id, judge, verdict, code, cited, population, compartments)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[])`,
          [
            row.filter,
            row.targetKey,
            row.evidenceId,
            judge,
            row.verdict,
            row.code,
            row.cited,
            row.population,
            [...row.compartments].sort(byText),
          ],
        );
        saved += 1;
      }
      return saved;
    },

    async spentToday(promptId) {
      const [row] = await db.query<{ spent: string | null }>(
        "select sum(cost_microusd)::text as spent from vault.model_usage where lane = 'dream' and prompt_id = $1 and day = $2::date",
        [promptId, await ownerDayOf(db.query)],
      );
      return Number(row?.spent ?? 0);
    },
  };
}
