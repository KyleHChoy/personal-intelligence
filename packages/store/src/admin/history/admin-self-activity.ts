import {
  ACTIVITY_FACT_TYPES,
  ClaimRecord,
  dayIn,
  type FactId,
  type FactKeyFp,
  type OwnerActivity,
  type OwnerActivityEntry,
  type OwnerPageArgs,
} from "@intelligence/contracts/personal";
import { maskCredentials } from "@intelligence/personal-core";
import type { AdminContext } from "../../core/admin-context.ts";
import { ownerAudience } from "../../core/audience.ts";
import { stamp } from "../../core/db.ts";
import { open, type Sealed } from "../../core/seal.ts";
import { PROJECT_NAMES } from "../../core/statements.ts";
import { RELEASE_IN_FORCE } from "../../core/visibility.ts";
import { ownerZoneOf } from "../../core/zone.ts";
import { cursorOf, fitsPlace, ownerPage, ownerWho, ownerWithheld } from "../admin-owner.ts";

// What the owner did, from their `activity.*` claims, a month a page, newest first. Code makes these
// claims about the owner alone, so the type says whose they are. As pi_admin, within the owner's
// audience ($2), with the reader's filters stated: a release in force, no claim naming a withheld
// ($3) or gone entity. These types build no belief and take no ruling; one goes when its capture
// item goes. Nothing here writes, and nothing is logged.

const ACTIVITY = `
  select c.id, c.type, date_trunc('milliseconds', c.valid_from) as at, c.valid_to, c.fact_key_fp, c.content_enc, c.compartments
  from knowledge.claims c
  where c.type = any ($1::text[]) and c.compartments <@ $2::text[] and ${RELEASE_IN_FORCE}
    and not exists (
      select 1 from knowledge.claim_entities n
      where n.claim_id = c.id and (n.entity_id = any ($3::text[]) or not exists (select 1 from knowledge.entities e where e.id = n.entity_id)))
    and date_trunc('milliseconds', c.valid_from) <= to_timestamp($4::float8 / 1000)
    and ($5::float8 is null or (date_trunc('milliseconds', c.valid_from), c.id collate "C") < (to_timestamp($5::float8 / 1000), $6::text collate "C"))
  order by 3 desc, c.id collate "C" desc
  limit $7`;

type Row = {
  id: string;
  type: OwnerActivityEntry["type"];
  at: Date;
  valid_to: Date | null;
  fact_key_fp: string;
  content_enc: Sealed;
  compartments: string[];
};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

// A row's sentence from its claim's theme. Only a topic, a project, a repository, a document or a
// person is a title; a block known by its category alone is said as time on its host, so reading
// mail never reads as research.
export function activityTitle(
  type: OwnerActivityEntry["type"],
  fields: Readonly<Record<string, unknown>>,
  names: ReadonlyMap<string, string>,
): string {
  const named = (name: string): string | null => {
    const id = text(fields[name]);
    return id === null ? null : (names.get(id) ?? null);
  };
  const project = named("project");
  switch (type) {
    case "activity.worked_on":
      return `Worked on ${project ?? text(fields.repository) ?? text(fields.document) ?? "a project"}`;
    case "activity.messaged":
      return `Messaged ${named("counterparty") ?? "someone"}`;
    case "activity.met":
      return `Met ${named("counterparty") ?? "someone"}`;
    case "activity.researched": {
      const theme = project ?? text(fields.topic);
      if (theme !== null) return `Researched ${theme}`;
      const category = text(fields.category);
      const head =
        category === null || category === "other" ? "Browsing" : category.charAt(0).toUpperCase() + category.slice(1);
      return `${head} on ${text(fields.host) ?? "the web"}`;
    }
  }
}

export async function ownerActivity(context: AdminContext, args: OwnerPageArgs): Promise<OwnerActivity> {
  const page = ownerPage(args, fitsPlace);
  return context.transaction(async (query) => {
    const audience = await ownerAudience(query);
    const now = context.now();
    const rows = await query<Row>(ACTIVITY, [
      [...ACTIVITY_FACT_TYPES],
      audience,
      [...(await ownerWithheld(query))],
      now.getTime(),
      page.after?.[0] ?? null,
      page.after?.[1] ?? null,
      page.limit + 1,
    ]);
    const zone = await ownerZoneOf(query);
    const monthOf = (at: Date): string => dayIn(at, zone).slice(0, 7);
    const month = monthOf(rows[0]?.at ?? now);
    const kept = rows.filter((row) => monthOf(row.at) === month).slice(0, page.limit);
    const opens = (compartments: readonly string[]): boolean =>
      compartments.every((one) => context.keys.compartments.has(one));
    // A row the key file cannot open, or whose record no longer parses, says nothing here, and never
    // costs the month its other rows.
    const records = new Map(
      kept.flatMap((row) => {
        if (!opens(row.compartments)) return [];
        const record = ClaimRecord.safeParse(
          JSON.parse(open(context.keys, row, "knowledge.claims.content_enc", "throw")),
        );
        return record.success ? [[row.id, record.data] as const] : [];
      }),
    );
    const ids = (name: string): string[] =>
      [...records.values()].flatMap((record) => {
        const id = record.claim.content.fields[name];
        return record.fieldKinds[name] === "entity" && typeof id === "string" ? [id] : [];
      });
    const names = new Map<string, string>();
    for (const [id, who] of await ownerWho({ query, keys: context.keys }, ids("counterparty"))) {
      const name = who.name?.untrusted ?? who.address?.untrusted;
      if (name !== undefined) names.set(id, name);
    }
    const projects = ids("project");
    for (const row of projects.length === 0
      ? []
      : await query<{ id: string; name_enc: Sealed; compartments: string[] }>(PROJECT_NAMES, [projects, audience]))
      if (opens(row.compartments)) names.set(row.id, open(context.keys, row, "knowledge.projects.name_enc", "throw"));
    const last = kept.at(-1);
    return {
      month,
      entries: kept.flatMap((row) => {
        const record = records.get(row.id);
        return record === undefined
          ? []
          : [
              {
                fact: row.id as FactId,
                type: row.type,
                at: stamp(row.at),
                until: row.valid_to === null ? null : stamp(row.valid_to),
                factKey: row.fact_key_fp as FactKeyFp,
                title: { untrusted: maskCredentials(activityTitle(row.type, record.claim.content.fields, names)).text },
              },
            ];
      }),
      next: rows.length > kept.length && last !== undefined ? cursorOf([last.at.getTime(), last.id]) : null,
    };
  });
}
