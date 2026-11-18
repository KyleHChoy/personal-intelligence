import { OWNER_TIE_TYPE, type Tier } from "@intelligence/contracts/personal";
import { warmthRules } from "@intelligence/personal-core/views";
import { fingerprint } from "../core/fingerprint.ts";
import { testId } from "./clients.ts";
import { type Query, session } from "./connections.ts";
import { sealRow, type TestDatabase } from "./database.ts";
import { claimRecord } from "./pipeline-fixtures.ts";
import { seeder } from "./seeder.ts";

// The warmth lines a test wants the reads to rank, seeded as what the ranking reads: each person's
// days under one label (projections.warmth_days, as the day build writes them, as pi_pipeline), the
// label's build row, and, where the line is the owner's word, a tier ruling or a released owner_tie
// closeness. The ranking runs at read (identity/warmth-days.ts rankWarmth), so a line is what these
// inputs give, never a stored row:
// - `warmth` is one meeting of that weight today, so the line's warmth is exactly it;
// - an inferred `inner`, `close` or `regular` is 2, 1 or no days of the person's mail a month before
//   the last contact, with one of the owner's: with that contact, the tier floors' days of contact;
// - `known`, `outer`, `tierSource: "owner"` or `dormant` is a tier ruling on the person's addresses;
// - `dormant` is also the owner's released closeness `dormant`, the ruled tier kept;
// - `one-way` is the owner's mail alone, no meeting: no two-way contact and no warmth.
// Synthetic ids only.

export type LineSeed = {
  entity: string;
  tier: Tier;
  warmth: number;
  dormant?: boolean;
  tierSource?: "owner" | "inferred";
  // A two-way chat, or two-way mail, on this day, the last contact: the meeting falls on it too.
  chatAt?: Date;
  emailAt?: Date;
};

const DAY_MS = 86_400_000;
const dayOf = (at: Date): string => at.toISOString().slice(0, 10);
const AGO = [30, 29, 28];
// The person's days of mail a month ago that, with today's meeting, meet each tier's floor now; the
// tier a month ago is never better, so the hysteresis keeps today's.
const FLOOR_DAYS: Partial<Record<Tier, number>> = { inner: 2, close: 1, regular: 0 };

type DayRow = Record<string, string | number | null>;
const day = (entity: string, at: Date, fields: DayRow): DayRow => ({
  entity_id: entity,
  day: dayOf(at),
  out_w: 0,
  in_w: 0,
  meet_w: 0,
  email_out: 0,
  email_in: 0,
  chat_out: 0,
  chat_in: 0,
  meet_n: 0,
  started: 0,
  runs: 0,
  answered: 0,
  answer_hours: 0,
  mutual: 0,
  theirs: 0,
  first_out_at: null,
  last_out_at: null,
  first_in_at: null,
  last_in_at: null,
  first_meet_at: null,
  last_meet_at: null,
  ...fields,
});

function daysOf(row: LineSeed, today: Date): DayRow[] {
  // The floor's days fall a month before the last contact, so none of them is later than it.
  const base = row.chatAt ?? row.emailAt ?? today;
  const ago = (days: number): Date => new Date(base.getTime() - days * DAY_MS);
  const iso = (at: Date): string => at.toISOString();
  const out = [
    day(row.entity, ago(AGO[0] as number), { email_out: 1, first_out_at: iso(ago(30)), last_out_at: iso(ago(30)) }),
  ];
  if (row.tier === "one-way") return out;
  // The owner's word alone, and no contact: no day at all.
  if (ruled(row) && row.warmth === 0 && (row.chatAt ?? row.emailAt) === undefined) return [];
  const floor = ruled(row) ? 1 : (FLOOR_DAYS[row.tier] ?? 1);
  for (const [i, days] of AGO.slice(0, floor).entries()) {
    const at = ago(days);
    const one = day(row.entity, at, { email_in: 1, first_in_at: iso(at), last_in_at: iso(at) });
    if (i === 0) Object.assign(out[0] as DayRow, { email_in: 1, first_in_at: iso(at), last_in_at: iso(at) });
    else out.push(one);
  }
  // The meeting falls on the chat's day, its weight grown by the days since, so today's warmth is `warmth`
  // and the last two-way contact the chat's.
  const at = row.chatAt ?? row.emailAt ?? today;
  const days = Math.round((Date.parse(dayOf(today)) - Date.parse(dayOf(at))) / DAY_MS);
  const grown = row.warmth * 2 ** (days / warmthRules().activeHalfLifeDays);
  const contact =
    (row.chatAt ?? row.emailAt) === undefined
      ? {}
      : {
          ...(row.chatAt === undefined ? { email_out: 1, email_in: 1 } : { chat_out: 1, chat_in: 1 }),
          first_out_at: iso(at),
          last_out_at: iso(at),
          first_in_at: iso(at),
          last_in_at: iso(at),
        };
  (row.chatAt ?? row.emailAt) === undefined
    ? {}
    : {
        chat_out: 1,
        chat_in: 1,
        first_out_at: iso(at),
        last_out_at: iso(at),
        first_in_at: iso(at),
        last_in_at: iso(at),
      };
  if (row.warmth > 0 || (row.chatAt ?? row.emailAt) !== undefined)
    out.push(
      day(row.entity, at, {
        meet_w: grown,
        meet_n: row.warmth > 0 ? 1 : 0,
        first_meet_at: row.warmth > 0 ? iso(at) : null,
        last_meet_at: row.warmth > 0 ? iso(at) : null,
        ...contact,
      }),
    );
  return out;
}

const INSERT = `
  insert into projections.warmth_days (entity_id, day, compartments, out_w, in_w, meet_w, email_out, email_in, chat_out, chat_in,
    meet_n, started, runs, answered, answer_hours, mutual, theirs, first_out_at, last_out_at, first_in_at, last_in_at, first_meet_at, last_meet_at)
  select r.entity_id, r.day, $1::text[], r.out_w, r.in_w, r.meet_w, r.email_out, r.email_in, r.chat_out, r.chat_in,
    r.meet_n, r.started, r.runs, r.answered, r.answer_hours, r.mutual, r.theirs, r.first_out_at, r.last_out_at, r.first_in_at, r.last_in_at,
    r.first_meet_at, r.last_meet_at
  from jsonb_to_recordset($2::jsonb) as r (entity_id text, day date, out_w float8, in_w float8, meet_w float8, email_out int, email_in int,
    chat_out int, chat_in int, meet_n int, started int, runs int, answered int, answer_hours float8, mutual int, theirs int,
    first_out_at timestamptz, last_out_at timestamptz, first_in_at timestamptz, last_in_at timestamptz, first_meet_at timestamptz,
    last_meet_at timestamptz)`;

// Whether a line is the owner's ruled tier: asked for, a tier no floor gives, or dormant (whose tier the
// ruling keeps, as a closeness alone would make it `outer`).
const ruled = (row: LineSeed): boolean =>
  row.tier !== "one-way" && (row.tierSource === "owner" || row.dormant === true || FLOOR_DAYS[row.tier] === undefined);

// An owner decision for a ruling, as the seeder writes one.
async function decision(query: Query, label: string[]): Promise<string> {
  const id = testId("rul");
  await query(
    `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments)
     values ($1, $2, 'release', 0, '{}', '{}', now(), $3)`,
    [id, testId("req"), label],
  );
  return id;
}

// `label`'s days replaced by the lines given (added to them with `append`), its build row written (`removed` marks it as a removal
// leaves it), every earlier tier ruling on these people lifted, and the owner's word written where a
// line takes it. `today` is the clock the reads rank by: the reader's or the admin's, the system's
// by default.
export async function seedLines(
  db: TestDatabase,
  label: string[],
  rows: LineSeed[],
  options: { removed?: boolean; today?: Date; append?: boolean } = {},
): Promise<void> {
  const today = options.today ?? new Date();
  const sorted = [...label].sort();
  await session(db.urls.pipeline, async (query) => {
    if (options.append !== true)
      await query("delete from projections.warmth_days where compartments = $1::text[]", [sorted]);
    const days = rows.flatMap((row) => daysOf(row, today));
    if (days.length > 0) await query(INSERT, [sorted, JSON.stringify(days)]);
    await query(
      `insert into projections.warmth_day_builds (compartments, built_at, rule_version, time_zone, days, removed_at)
       values ($1::text[], now(), $2, 'UTC', $3, null)
       on conflict (compartments) do update set built_at = now(), rule_version = excluded.rule_version, days = excluded.days, removed_at = null`,
      [sorted, warmthRules().version, days.length],
    );
  });
  await session(db.urls.admin, async (query) => {
    if (options.removed === true)
      await query("update projections.warmth_day_builds set removed_at = now() where compartments = $1::text[]", [
        sorted,
      ]);
    const people = rows.map((row) => row.entity);
    const fps = async (entity: string): Promise<string[]> =>
      (
        await query<{ value_fp: string }>(
          "select a.value_fp from knowledge.accounts a where a.entity_id = $1 order by a.id",
          [entity],
        )
      ).map((one) => one.value_fp);
    const lift = await decision(query, sorted);
    for (const entity of people) {
      const held = await fps(entity);
      if (held.length > 0)
        await query(
          "update knowledge.tier_rulings set lifted_at = now(), lift_ruling_id = $2 where lifted_at is null and value_fps && $1::text[]",
          [held, lift],
        );
    }
    for (const row of rows) {
      if (!ruled(row)) continue;
      const held = await fps(row.entity);
      if (held.length === 0) throw new Error("a ruled line needs an address of the person");
      await query(
        "insert into knowledge.tier_rulings (ruling_id, tier, value_fps, created_at, compartments) values ($1, $2, $3, now(), $4)",
        [await decision(query, sorted), row.tier, held, sorted],
      );
    }
  });
  for (const row of rows) if (row.dormant === true) await seedCloseness(db, row.entity, "dormant");
}

// Each compartment of the labels made the owner's audience's (pipeline-read.ts ownerAudienceOf): a
// claim of a type that builds a belief under it, by the world's own seeder, whose ids it numbers.
export async function seedAudience(
  claim: (compartment: string) => Promise<unknown>,
  labels: readonly (readonly string[])[],
): Promise<void> {
  for (const compartment of new Set(labels.flat())) await claim(compartment);
}

// The owner's released closeness for a person, under `own` (a released claim's label), as
// admin-people.db.test.ts writes one.
export async function seedCloseness(db: TestDatabase, person: string, closeness: "inner" | "dormant"): Promise<void> {
  const own = ["own"];
  const evidence = await session(db.urls.admin, async (query) => {
    await seeder(db, query).into("knowledge.claim_releases")(own);
    const [release] = await query<{ evidence_id: string }>(
      "select evidence_id from knowledge.claim_releases order by created_at desc, ruling_id desc limit 1",
    );
    return release?.evidence_id ?? "";
  });
  await session(db.urls.pipeline, async (query) => {
    const base = claimRecord(evidence, own, person, {
      n: 900,
      type: OWNER_TIE_TYPE,
      factKey: `tie ${person}`,
      entities: [person],
      origin: "agent_record",
    });
    const record = {
      ...base,
      claim: {
        ...base.claim,
        content: { type: OWNER_TIE_TYPE, subject: person, fields: { relation: "friend", closeness } },
      },
      subjectKind: "person",
      fieldKinds: { relation: "enum", closeness: "enum" },
    };
    const id = fingerprint(db.keys, "claim", testId("tie"));
    await query(
      `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, compartments, released, content_enc)
       values ($1, $2, $3, now(), $4, 1, array['m-owner'], array['own'], true, $5)`,
      [
        id,
        evidence,
        OWNER_TIE_TYPE,
        fingerprint(db.keys, "fact", `tie ${person}`),
        sealRow(db.keys, "own", { table: "knowledge.claims", id, column: "content_enc" }, JSON.stringify(record)),
      ],
    );
    await query(
      "insert into knowledge.claim_entities (claim_id, entity_id, compartments) values ($1, $2, array['own'])",
      [id, person],
    );
  });
}

// Every line seeded before gone: every label's days (each build row left built, with none), every
// tier ruling lifted, and every released owner_tie claim with its entity rows.
export async function resetLines(db: TestDatabase): Promise<void> {
  await session(db.urls.pipeline, async (query) => {
    await query("delete from projections.warmth_days");
    await query("update projections.warmth_day_builds set built_at = now(), days = 0, removed_at = null");
  });
  await session(db.urls.admin, async (query) => {
    const lift = await decision(query, ["own"]);
    await query("update knowledge.tier_rulings set lifted_at = now(), lift_ruling_id = $1 where lifted_at is null", [
      lift,
    ]);
  });
  await session(db.urls.pipeline, async (query) => {
    await query(
      "delete from knowledge.claim_entities where claim_id in (select c.id from knowledge.claims c where c.type = $1 and c.released)",
      [OWNER_TIE_TYPE],
    );
    await query("delete from knowledge.claims where type = $1 and released", [OWNER_TIE_TYPE]);
  });
}
