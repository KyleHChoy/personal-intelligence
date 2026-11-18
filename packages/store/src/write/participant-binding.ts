import {
  type CaptureMention,
  isCoded,
  type MeetingCaptureFacts,
  type MomentCaptureFacts,
} from "@intelligence/contracts/personal";
import { meetingKey, normalizeAddress, phoneKey, strictAddress } from "@intelligence/personal-core";
import { attendeeAddresses, meetingOwner } from "@intelligence/personal-core/items";
import { type Query, stamp } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { TRY_EXTRACT } from "../core/locks.ts";
import type { ClientGroups } from "../core/read-ctx.ts";
import { open, type Sealed } from "../core/seal.ts";
import { sql } from "../core/sql.ts";
import { OWNER_ACCOUNT_FPS } from "../core/statements.ts";
import { eachInOwnTransaction, type Tx } from "../core/tx.ts";
import { holders, SOURCE_MOMENT } from "../core/vocabulary.ts";
import { anySuppressed, identityPort } from "../identity/identity-port.ts";
import { ADDRESS, askAddress, bindName } from "../identity/name-binding.ts";
import { audienceGroups } from "../identity/warmth-build.ts";
import type { DrainContext } from "../lens/capture-drain.ts";
import { deriveChatLines, type LineMemo, type LineMoment } from "../lens/chat-lines.ts";
import { fillPhoneFps } from "./writer-contacts.ts";

// `phonesFilled`, the contacts whose phone_fps the catch-up filled. The chat lines the step wrote and removed,
// the source moments reached whose facts hold no lines, the owner's lines refused outside the owner's word, and
// the handles that were the owner's own. `heldDue`, the source moments set due again because a handle filed for
// one of them now resolves by its phone key, with their saved calls' other moments, so their held claims
// replay.
export type ParticipantCounts = {
  bound: number;
  ambiguous: number;
  created: number;
  skipped: number;
  capped: number;
  failed: number;
  handlesBound: number;
  handlesRemoved: number;
  phonesFilled: number;
  linesWritten: number;
  linesRemoved: number;
  noLines: number;
  notOwnerWord: number;
  ownerHandle: number;
  heldDue: number;
};

// The forgery bound: the people the step makes by a name alone, counted by the device whose meeting
// made them and the UTC day they were made, and shown in `pi status` (LensDeviceView.peopleMade).
// Past this many a device a day, a name with nobody to bind waits, bound to no one, for a later
// sync: a soft cap, so a forged transcript cannot make people without limit, and a real day of
// meetings loses nobody.
export const MEETING_PEOPLE_PER_DAY = 20;

// The people made since a time (a UTC timestamp), each with the source account of the meeting its
// first alias cites: the step writes a name alias only for a person it made or found by its key,
// and no other writer gives an alias a capture's evidence (writer-derived.ts writes them for mail,
// events and contacts). Read from the people made since then, so it stays small. `since` is SQL.
const madeSince = (since: string): string => `
  select e.id as entity_id, e.created_at,
    (select c.source_account_id from knowledge.aliases s join knowledge.captures c on c.evidence_id = s.evidence_id and c.kind in ('meeting', 'moment')
     where s.entity_id = e.id order by s.id collate "C" limit 1) as source_account_id
  from knowledge.entities e
  where e.kind = 'person' and e.created_at >= ${since}`;

// The people made by name since `from` (a UTC date), by device label and UTC day.
export const peopleMadeByName = (query: Query, from: string): Promise<{ label: string; day: string; n: number }[]> =>
  query<{ label: string; day: string; n: number }>(
    `select a.label, (m.created_at at time zone 'utc')::date::text as day, count(*)::int as n
     from (${madeSince("$1::timestamptz")}) m join vault.source_accounts a on a.id = m.source_account_id
     group by 1, 2 order by 2`,
    [`${from}T00:00:00Z`],
  );

// The participants a meeting's facts name with a name and no address: each speaker not marked the owner and not sealed to an
// event participant whose mention has none, and whom the meeting's own lists give no email by its name: one email is the
// person the lane links by it, two are namesakes no binding chooses between; and each owner-typed attendee with none, by the
// same rule. And every strict address of a speaker, an attendee or the calendar's people. Never the owner, decided first
// (`meetingOwner`, `own` testing a normalized address as one of the owner's): a mention of one of the owner's addresses, or
// with no address of a name the meeting knows the owner by, is no participant, whoever else holds the name, so it is never
// bound, made or counted to the cap.
export function participantsOf(
  facts: MeetingCaptureFacts,
  own: (address: string) => boolean,
): { names: string[]; addresses: string[] } {
  const attendees = facts.attendees ?? [];
  const isOwner = meetingOwner(facts, own);
  const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
  // A name the meeting's lists give an address is that person's; one they give two is namesakes',
  // which no binding chooses between, so it waits.
  const listed = (name: string): boolean => attendeeAddresses(facts, name).length > 0;
  const names: string[] = [];
  const add = (name: string | undefined): void => {
    const trimmed = name?.trim();
    if (trimmed !== undefined && trimmed !== "" && !names.some((one) => same(one, trimmed))) names.push(trimmed);
  };
  for (const speaker of facts.speakers) {
    if (speaker.owner || facts.linked?.speakers[speaker.label] !== undefined || isOwner(speaker.mention)) continue;
    const mention = speaker.mention;
    if (mention?.address === undefined && mention?.name !== undefined && !listed(mention.name)) add(mention.name);
  }
  for (const attendee of attendees)
    if (attendee.address === undefined && !isOwner(attendee) && (attendee.name === undefined || !listed(attendee.name)))
      add(attendee.name);
  const mentions: (CaptureMention | null | undefined)[] = [
    ...facts.speakers.filter((one) => !one.owner).map((one) => one.mention),
    ...attendees,
    facts.calendar?.organizer,
    ...(facts.calendar?.attendees ?? []),
  ];
  const addresses = [
    ...new Set(
      mentions
        .flatMap((one) =>
          one?.address !== undefined && strictAddress(one.address) && !isOwner(one)
            ? [normalizeAddress(one.address)]
            : [],
        )
        .filter((one): one is string => one !== null),
    ),
  ];
  return { names, addresses };
}

// What a chat moment's sealed facts name, as `participantsOf` reads a meeting's:
// each participant with a name and no address, and each strict address, never the owner's
// (decided first, by the meeting rule over the moment's participants: one of the owner's addresses, or a
// name a mention with the owner's address gives). A handle names nobody. Any other moment names none.
export function momentParticipantsOf(
  facts: MomentCaptureFacts,
  own: (address: string) => boolean,
): { names: string[]; addresses: string[] } {
  if (facts.entity !== "chat") return { names: [], addresses: [] };
  return participantsOf(
    {
      kind: "meeting",
      title: null,
      consent: false,
      mode: "room",
      calendar: null,
      speakers: [],
      linked: null,
      attendees: facts.participants,
    },
    own,
  );
}

type Meeting = {
  id: string;
  evidence_id: string;
  event_id: string | null;
  compartments: string[];
  facts_enc: Sealed;
  source_item_fp: string;
  source_account_id: string;
};

// The names the owner's entity is known by, which make no participant (an owner-typed attendee of
// the owner's own name), beside the names the owner's meeting knows them by (participantsOf): their own
// display names, from mail they sent; only an alias whose compartments are within the meeting's label counts, as a
// namesake's alias is read (CANDIDATES), so evidence the meeting's label does not cover never
// decides how its name resolves (invariant 6).
// Of these names, those that are the owner's.
const OWNER_NAMES =
  "select distinct a.value_fp from knowledge.aliases a join knowledge.entities e on e.id = a.entity_id and e.kind = 'owner' where a.value_fp = any($1::text[]) and a.compartments <@ $2::text[]";

// What a meeting has to settle, read with no transaction: its names with no live binding that are
// not the owner's own, and its addresses no person holds. Most meetings have none,
// and are passed over, so a meeting naming the owner is not settled again at every sync.
async function pending(
  writer: DrainContext,
  meeting: Meeting,
  ownerFps: ReadonlySet<string>,
): Promise<{ names: string[]; addresses: string[] }> {
  const facts = JSON.parse(open(writer.direct.keys, meeting, "knowledge.captures.facts_enc", "throw")) as
    | MeetingCaptureFacts
    | MomentCaptureFacts;
  const own = (address: string): boolean => ownerFps.has(fingerprint(writer.direct.keys, "address", address));
  const all = facts.kind === "moment" ? momentParticipantsOf(facts, own) : participantsOf(facts, own);
  const fps = all.names.map((name) => fingerprint(writer.direct.keys, "name", name));
  const live = new Set(
    (
      await writer.direct.query<{ mention_fp: string }>(
        "select mention_fp from knowledge.mention_bindings where evidence_id = $1 and mention_fp = any($2::text[]) and lifted_at is null",
        [meeting.evidence_id, fps],
      )
    ).map((row) => row.mention_fp),
  );
  const unbound = fps.filter((fp) => !live.has(fp));
  const his = new Set(
    unbound.length === 0
      ? []
      : (await writer.direct.query<{ value_fp: string }>(OWNER_NAMES, [unbound, meeting.compartments])).map(
          (row) => row.value_fp,
        ),
  );
  const held = new Set(
    (
      await writer.direct.query<{ value_fp: string }>(
        "select value_fp from knowledge.accounts where value_fp = any($1::text[])",
        [all.addresses.map((one) => fingerprint(writer.direct.keys, "address", one))],
      )
    ).map((row) => row.value_fp),
  );
  return {
    names: all.names.filter((_, n) => !live.has(fps[n] as string) && !his.has(fps[n] as string)),
    addresses: all.addresses.filter((one) => !held.has(fingerprint(writer.direct.keys, "address", one))),
  };
}

async function settleMeeting(
  tx: Tx,
  meeting: Meeting,
  work: { names: string[]; addresses: string[] },
  now: Date,
  counts: ParticipantCounts,
): Promise<void> {
  // The pipeline's extract lock, tried in the transaction, as the owner's bind takes it, so no run
  // commits the meeting by the old answer after the binding; while a run holds it the meeting waits
  // for the next sync.
  const [lock] = await tx.query<{ held: boolean }>(TRY_EXTRACT);
  if (lock?.held !== true) {
    counts.skipped += 1;
    return;
  }
  const { names, addresses } = work;
  const label = meeting.compartments;
  const port = identityPort(tx);
  const requestId = `participants:${meeting.evidence_id}`;
  const ask = (value: string) => askAddress(port, value, now, requestId);
  // An address no person holds: a new person, by the writer's port, as any new address makes one.
  let bound = false;
  // The device's people made by name today (UTC, the database's clock, which stamps a person's
  // created_at), read once for the meeting and counted on as it makes them. By the device's
  // label, so its meetings' and its moments' source accounts share one cap.
  let madeToday: number | undefined;
  const today = async (): Promise<number> => {
    const [row] = await tx.query<{ n: number }>(
      `select count(*)::int as n from (${madeSince("date_trunc('day', now() at time zone 'utc') at time zone 'utc'")}) m
       join vault.source_accounts a on a.id = m.source_account_id
       where a.label = (select label from vault.source_accounts where id = $1)`,
      [meeting.source_account_id],
    );
    return row?.n ?? 0;
  };
  // The forgery bound, by the device's people for the day.
  const cap = {
    full: async (): Promise<boolean> => (madeToday ??= await today()) >= MEETING_PEOPLE_PER_DAY,
    made: (): void => {
      if (madeToday !== undefined) madeToday += 1;
    },
  };
  for (const address of addresses) {
    const answer = await ask(address);
    if (answer.outcome === "created") {
      counts.created += 1;
      // The meeting's claims already made name nobody there; it is asked again.
      bound = true;
    }
  }
  // Every revision of the meeting, for the owner's lifts.
  const revisions = await revisionsOf(tx, meeting.source_account_id, meeting.source_item_fp);
  const item = { evidenceId: meeting.evidence_id, sourceItemFp: meeting.source_item_fp, revisions, label };
  for (const name of names) {
    const nameFp = fingerprint(tx.keys, "name", name);
    const [live] = await tx.query<{ id: string }>(
      "select id from knowledge.mention_bindings where evidence_id = $1 and mention_fp = $2 and lifted_at is null",
      [meeting.evidence_id, nameFp],
    );
    if (live !== undefined) {
      counts.skipped += 1;
      continue;
    }
    if ((await tx.query(OWNER_NAMES, [[nameFp], label])).length > 0) {
      counts.skipped += 1;
      continue;
    }
    // The label is in the key, so one name under two labels is two people.
    const scope = `meeting participant\n${nameFp}\n${[...label].sort().join(",")}`;
    if (
      await bindName(
        tx,
        port,
        item,
        name,
        { scope, requestId, key: meetingKey, eventId: meeting.event_id, cap },
        now,
        counts,
      )
    )
      bound = true;
  }
  await port.write(label);
  // Made due again, its saved calls kept, so the next run replays it by the new bindings.
  if (bound)
    await tx.query("update vault.pipeline_items set extractor_generation = 0 where evidence_id = $1", [
      meeting.evidence_id,
    ]);
}

// A screen moment's handles, and any other moment's, name nobody. The evidence ids of every stored
// revision of one source item.
export async function revisionsOf(tx: Tx, accountId: string, itemFp: string): Promise<string[]> {
  const rows = await tx.query<{ id: string }>(
    "select id from vault.evidence_items where source_account_id = $1 and source_item_fp = $2",
    [accountId, itemFp],
  );
  return rows.map((row) => row.id);
}

export function momentPhonesOf(facts: MomentCaptureFacts): string[] {
  if (facts.entity !== "chat" || facts.source === undefined) return [];
  return [
    ...new Set(
      facts.participants.flatMap((one) =>
        one.handle !== undefined && one.address === undefined && phoneKey(one.handle) !== null ? [one.handle] : [],
      ),
    ),
  ];
}

// Not when a person holds its phone key there (rule 2: the identity port resolves it then), nor when the
// owner's erasure suppressed the handle or its key. Otherwise the contacts under the label whose phones
// hold it, in two tiers: saved and imported contacts, and Mac contacts only when none of the first holds
// it. Within the tier that decides, every contact has an address, every address of each resolved, and all
// of them together name one and the same person (by one address or several), no owner's; that person's
// address as the owner's bind chooses it (ADDRESS). A phone on contacts of two people, or on a contact
// that has an address no one holds, binds nobody, and so does one on more than PHONE_CONTACTS_MOST: a
// phone never joins two people, and raises no card that they are one. People the owner ruled the same, one
// identity group under the label, are one person here: the owner joined them and the phone does not, so a
// person whose addresses are several records of a group binds, as the warmth build and every read count
// them. So an iCloud and a CardDAV copy of one person bind, and a Mac contact never changes a binding a
// Google contact gives.
const PHONE_HELD = sql`select count(distinct a.entity_id)::int as n from ${holders("$1", "$2::text[]")}`;
// `mac`, a contact of a device's Mac contacts; `resolved`, the contact's addresses with a row naming
// whom they resolved to; `entities`, everyone those rows name, and `people`, those of them who are
// people. One more than PHONE_CONTACTS_MOST is read, to tell more apart.
const PHONE_CONTACTS_MOST = 20;
const PHONE_CONTACT = `
  select c.id, a.connector = 'lens_contacts' as mac, cardinality(c.address_fps)::int as addresses,
    (select count(distinct k.value_fp)::int from knowledge.contact_addresses k where k.contact_id = c.id and k.value_fp = any(c.address_fps)) as resolved,
    coalesce((select array_agg(distinct k.entity_id) from knowledge.contact_addresses k where k.contact_id = c.id), '{}') as entities,
    coalesce((select array_agg(distinct k.entity_id) from knowledge.contact_addresses k join knowledge.entities e on e.id = k.entity_id and e.kind = 'person' where k.contact_id = c.id), '{}') as people
  from knowledge.contacts c join vault.source_accounts a on a.id = c.account_id
  where c.phone_fps @> array[$1]::text[] and c.compartments <@ $2::text[] order by c.id limit ${PHONE_CONTACTS_MOST + 1}`;
type PhoneContact = {
  id: string;
  mac: boolean;
  addresses: number;
  resolved: number;
  entities: string[];
  people: string[];
};
async function phoneTarget(
  query: Query,
  keys: Tx["keys"],
  phone: string,
  label: string[],
  groupsMemo: Map<string, Promise<ClientGroups>>,
): Promise<string | null> {
  const key = phoneKey(phone);
  if (key === null) return null;
  const keyFp = fingerprint(keys, "address", key);
  if (((await query<{ n: number }>(PHONE_HELD, [keyFp, label]))[0]?.n ?? 0) > 0) return null;
  if (await anySuppressed(query, [keyFp, fingerprint(keys, "name", phone)])) return null;
  const contacts = await query<PhoneContact>(PHONE_CONTACT, [fingerprint(keys, "phone", phone), label]);
  if (contacts.length > PHONE_CONTACTS_MOST) return null;
  const saved = contacts.filter((one) => !one.mac);
  const tier = saved.length > 0 ? saved : contacts;
  if (tier.length === 0 || tier.some((one) => one.addresses < 1 || one.resolved !== one.addresses)) return null;
  const entities = new Set(tier.flatMap((one) => one.entities));
  const people = new Set(tier.flatMap((one) => one.people));
  // An entity that is no person is the owner's or an organization's, which binds nobody.
  if (people.size === 0 || entities.size !== people.size) return null;
  if (people.size > 1) {
    const memo = [...label].sort().join(",");
    const held = groupsMemo.get(memo) ?? audienceGroups(query, label);
    groupsMemo.set(memo, held);
    const groups = await held;
    if (new Set([...people].map((one) => groups.idOf(one))).size !== 1) return null;
  }
  for (const person of [...people].sort()) {
    const fp = (await query<{ fp: string | null }>(ADDRESS, [person, label]))[0]?.fp ?? null;
    if (fp !== null) return fp;
  }
  return null;
}

type SourceMoment = LineMoment & { facts_enc: Sealed; source_item_fp: string; source_account_id: string };
type LiveBinding = { id: string; evidence_id: string; mention_fp: string; address_fp: string; origin: string };

// The owner's binding outranks it and is left as it is; one the owner lifted (on any revision of the
// moment) is never made again; a target is read once a sync for a handle and a label. A moment changed is
// set due again, its saved calls kept, so the next run replays it by the new bindings. Each moment
// changed in a transaction of its own. In the same loop, from the same opened facts and after its
// bindings are settled, each moment's chat lines (deriveChatLines); then every source moment beyond the
// limit whose lines_fp is null (a new revision, one the captures hook changed, one the catch-up
// resealed), at most `limit` more. A moment whose claims about a handle are held (the handle filed for
// it, no binding of it in force, none the owner lifted) is set due again, its saved calls kept, once
// exactly one person holds the handle's phone key under the moment's label (rule 2: a phone-only contact
// keyed since, a Google or a Mac one) and none suppressed it, and that person was made after the moment's
// last commit, so its saved call replays and resolves them: set due once, whatever the replay finds. Rule
// 3's bindings set it due as any binding does. Either way the other moments of its saved calls are set
// due with it (DUE_WITH_CALL_MATES), so the group they were asked in forms again and its call replays.
export const DUE_WITH_CALL_MATES = `
  update vault.pipeline_items set extractor_generation = 0
  where extractor_generation <> 0 and evidence_id in (
    select $1::text
    union select o.evidence_id from vault.model_call_members m join vault.model_call_members o on o.call_id = m.call_id where m.evidence_id = $1)
  returning evidence_id`;
const PHONE_KEYED = sql`select count(distinct a.entity_id)::int as n, max(e.created_at) as made from ${holders("$1", "$2::text[]")}`;
const SOURCE_MOMENTS = sql`
  select c.id, c.evidence_id, c.compartments, c.facts_enc, c.ended_at, c.thread_fp, c.lines_fp, e.source_item_fp, e.source_account_id
  from knowledge.captures c join vault.evidence_items e on e.id = c.evidence_id
  where ${SOURCE_MOMENT} and e.payload_state = 'present'`;
// A moment's facts, opened under its label.
const momentFacts = (direct: Tx, moment: SourceMoment): MomentCaptureFacts =>
  JSON.parse(open(direct.keys, moment, "knowledge.captures.facts_enc", "throw")) as MomentCaptureFacts;

// What the moments' handles are bound to now: the bindings in force, by moment and mention; the
// handles the owner lifted, by source item and mention; and when each filed mention's moment last
// committed, by moment and mention.
async function bindingsOf(direct: Tx, moments: readonly SourceMoment[]) {
  const live = new Map(
    (
      await direct.query<LiveBinding>(
        "select id, evidence_id, mention_fp, address_fp, origin from knowledge.mention_bindings where evidence_id = any($1) and lifted_at is null",
        [moments.map((one) => one.evidence_id)],
      )
    ).map((one) => [`${one.evidence_id} ${one.mention_fp}`, one]),
  );
  const lifted = new Set(
    (
      await direct.query<{ source_item_fp: string; mention_fp: string }>(
        `select e.source_item_fp, b.mention_fp from knowledge.mention_bindings b join vault.evidence_items e on e.id = b.evidence_id
         where b.lifted_at is not null and e.source_item_fp = any($1)`,
        [[...new Set(moments.map((one) => one.source_item_fp))]],
      )
    ).map((row) => `${row.source_item_fp} ${row.mention_fp}`),
  );
  const filed = new Map(
    (
      await direct.query<{ evidence_id: string; name_fp: string; updated_at: Date }>(
        "select u.evidence_id, u.name_fp, p.updated_at from vault.unresolved_mentions u join vault.pipeline_items p on p.evidence_id = u.evidence_id where u.evidence_id = any($1)",
        [moments.map((one) => one.evidence_id)],
      )
    ).map((row) => [`${row.evidence_id} ${row.name_fp}`, row.updated_at.getTime()]),
  );
  return { live, lifted, filed };
}

type PhoneChange = { phone: string; mentionFp: string; current: LiveBinding | undefined; target: string | null };

// A moment's handle changes, under the extract lock, in one transaction. Read again under the lock,
// so a binding or a lift the owner made since the reads above is never undone or doubled: a change
// whose binding moved is left for the next sync.
async function applyPhoneChanges(
  writer: DrainContext,
  moment: SourceMoment,
  changes: readonly PhoneChange[],
  now: Date,
  counts: ParticipantCounts,
): Promise<void> {
  await writer.transaction(async (tx) => {
    const [lock] = await tx.query<{ held: boolean }>(TRY_EXTRACT);
    if (lock?.held !== true) {
      counts.skipped += 1;
      return;
    }
    const now_ = await tx.query<LiveBinding>(
      "select id, evidence_id, mention_fp, address_fp, origin from knowledge.mention_bindings where evidence_id = $1 and lifted_at is null",
      [moment.evidence_id],
    );
    const liftedNow = await tx.query<{ mention_fp: string }>(
      "select b.mention_fp from knowledge.mention_bindings b join vault.evidence_items e on e.id = b.evidence_id where b.lifted_at is not null and e.source_item_fp = $1",
      [moment.source_item_fp],
    );
    let changed = false;
    for (const change of changes) {
      const still = now_.find((one) => one.mention_fp === change.mentionFp);
      if (
        still?.id !== change.current?.id ||
        (change.target !== null && liftedNow.some((one) => one.mention_fp === change.mentionFp))
      ) {
        counts.skipped += 1;
        continue;
      }
      changed = true;
      if (change.current !== undefined) {
        await tx.query("delete from knowledge.mention_bindings where id = $1", [change.current.id]);
        counts.handlesRemoved += 1;
      }
      if (change.target !== null) {
        await tx.query(
          "insert into knowledge.mention_bindings (id, ruling_id, origin, evidence_id, mention_fp, address_fp, created_at, compartments) values ($1, null, 'code', $2, $3, $4, $5, $6)",
          [newId("mbd"), moment.evidence_id, change.mentionFp, change.target, stamp(now), moment.compartments],
        );
        counts.handlesBound += 1;
      }
    }
    if (changed) await tx.query(DUE_WITH_CALL_MATES, [moment.evidence_id]);
  });
}

async function bindPhones(
  writer: DrainContext,
  now: Date,
  limit: number,
  counts: ParticipantCounts,
  ownerFps: ReadonlySet<string>,
): Promise<void> {
  const { direct } = writer;
  const moments = await direct.query<SourceMoment>(
    `${SOURCE_MOMENTS} order by c.started_at desc, c.id collate "C" limit $1`,
    [limit],
  );
  const memo: LineMemo = new Map();
  const lines = async (moment: SourceMoment, facts: MomentCaptureFacts): Promise<void> =>
    deriveChatLines(writer, memo, moment, facts, ownerFps, counts);
  if (moments.length === 0) return;
  const { live, lifted, filed } = await bindingsOf(direct, moments);
  const targets = new Map<string, string | null>();
  const groupsMemo = new Map<string, Promise<ClientGroups>>();
  // When the one person who holds a phone's key under a label was made, or null.
  const keyed = new Map<string, number | null>();
  const keyedAt = async (phone: string, label: string[], memo: string): Promise<number | null> => {
    if (!keyed.has(memo)) {
      const key = phoneKey(phone);
      const keyFp = key === null ? null : fingerprint(direct.keys, "address", key);
      const [held] =
        keyFp === null ? [] : await direct.query<{ n: number; made: Date | null }>(PHONE_KEYED, [keyFp, label]);
      const suppressed =
        keyFp !== null && (await anySuppressed(direct.query, [keyFp, fingerprint(direct.keys, "name", phone)]));
      keyed.set(memo, held?.n === 1 && held.made !== null && !suppressed ? held.made.getTime() : null);
    }
    return keyed.get(memo) ?? null;
  };
  const momentsFailed = await eachInOwnTransaction(moments, async (moment) => {
    const facts = momentFacts(direct, moment);
    const changes: PhoneChange[] = [];
    let held = false;
    for (const phone of momentPhonesOf(facts)) {
      const mentionFp = fingerprint(direct.keys, "name", phone);
      const current = live.get(`${moment.evidence_id} ${mentionFp}`);
      if (current?.origin === "owner") continue;
      const memo = `${phone}\n${[...moment.compartments].sort().join(",")}`;
      if (!targets.has(memo))
        targets.set(memo, await phoneTarget(direct.query, direct.keys, phone, moment.compartments, groupsMemo));
      const found = targets.get(memo) ?? null;
      const target = found !== null && lifted.has(`${moment.source_item_fp} ${mentionFp}`) ? null : found;
      if ((current?.address_fp ?? null) !== target) changes.push({ phone, mentionFp, current, target });
      else if (current === undefined && !lifted.has(`${moment.source_item_fp} ${mentionFp}`)) {
        const committed = filed.get(`${moment.evidence_id} ${mentionFp}`);
        const made = committed === undefined ? null : await keyedAt(phone, moment.compartments, memo);
        if (made !== null && committed !== undefined && made > committed) held = true;
      }
    }
    if (changes.length === 0) {
      if (held)
        await writer.transaction(async (tx) => {
          const [lock] = await tx.query<{ held: boolean }>(TRY_EXTRACT);
          if (lock?.held !== true) {
            counts.skipped += 1;
            return;
          }
          // A moment due already (a run has not replayed it yet) is not counted again.
          counts.heldDue += (await tx.query<{ evidence_id: string }>(DUE_WITH_CALL_MATES, [moment.evidence_id])).length;
        });
    } else await applyPhoneChanges(writer, moment, changes, now, counts);
    await lines(moment, facts);
  });
  counts.failed += momentsFailed;
  const reached = moments.map((one) => one.id);
  const beyond = await direct.query<SourceMoment>(
    `${SOURCE_MOMENTS} and c.lines_fp is null and not (c.id = any($2::text[])) order by c.started_at desc, c.id collate "C" limit $1`,
    [limit, reached],
  );
  const beyondFailed = await eachInOwnTransaction(beyond, (moment) => lines(moment, momentFacts(direct, moment)));
  counts.failed += beyondFailed;
}

// Every stored meeting, newest first, at most `limit`, then every stored chat moment
// no agent-app rule admitted, newest first, at most `limit` more, each in a transaction of its own;
// one that fails is counted and left for the next sync. Moments are read apart, so their number
// never pushes a meeting past the limit. First the contacts' phone_fps catch-up,
// at most PHONE_FILL_PER_SYNC; last the source moments' phone handles (bindPhones).
const PHONE_FILL_PER_SYNC = 500;
export function bindParticipants(writer: DrainContext, now: Date, limit = 2_000): Promise<ParticipantCounts> {
  return writer.write(async () => {
    const counts: ParticipantCounts = {
      bound: 0,
      ambiguous: 0,
      created: 0,
      skipped: 0,
      capped: 0,
      failed: 0,
      handlesBound: 0,
      handlesRemoved: 0,
      phonesFilled: 0,
      linesWritten: 0,
      linesRemoved: 0,
      noLines: 0,
      notOwnerWord: 0,
      ownerHandle: 0,
      heldDue: 0,
    };
    // A fill that fails is counted and ends nothing else.
    try {
      counts.phonesFilled = await writer.transaction((tx) => fillPhoneFps(tx, PHONE_FILL_PER_SYNC));
    } catch (error) {
      if (isCoded(error, "unavailable")) throw error;
      counts.failed += 1;
    }
    const read = (where: string): Promise<Meeting[]> =>
      writer.direct.query<Meeting>(
        `select c.id, c.evidence_id, c.event_id, c.compartments, c.facts_enc, e.source_item_fp, e.source_account_id
         from knowledge.captures c join vault.evidence_items e on e.id = c.evidence_id
         where ${where} and e.payload_state = 'present'
         order by c.started_at desc, c.id collate "C" limit $1`,
        [limit],
      );
    // A page moment has a host and no thread, and pages are most
    // moments, so they are left out by those clear columns, or the newest pages would push the
    // chats out of the limit. A chat's entity is sealed, so a doc moment may still be read; it
    // names nobody.
    // Source moments are read apart, at most `limit` more, so a backfill
    // of them never pushes the screen chats out of theirs; their email handles are settled here, their
    // phone handles by bindPhones.
    const meetings = [
      ...(await read("c.kind = 'meeting'")),
      ...(await read(
        "c.kind = 'moment' and c.source is null and not c.agent_app and not (c.host_fp is not null and c.thread_fp is null)",
      )),
      ...(await read(SOURCE_MOMENT)),
    ];
    // The owner's addresses, by fingerprint, as get_self reads them: every account of the owner's entity.
    const ownerFps = new Set(
      (await writer.direct.query<{ value_fp: string }>(OWNER_ACCOUNT_FPS)).map((row) => row.value_fp),
    );
    const meetingsFailed = await eachInOwnTransaction(meetings, async (meeting) => {
      const work = await pending(writer, meeting, ownerFps);
      if (work.names.length + work.addresses.length > 0)
        await writer.transaction((tx) => settleMeeting(tx, meeting, work, now, counts));
    });
    counts.failed += meetingsFailed;
    await bindPhones(writer, now, limit, counts, ownerFps);
    return counts;
  });
}
