// seedPublic: the mixed store of gate test P2, written as pi_admin in SQL.

import { createHash } from "node:crypto";
import { type RawItem, RawItem as RawItemShape } from "@intelligence/contracts";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import { EntityId, SourceAccountId } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import { calendarItem, gmailItem } from "@intelligence/personal-core/items";
import type { Keys } from "../core/keys.ts";
import { hashFingerprint } from "./clients.ts";
import { session } from "./connections.ts";
import { fingerprint, sealRow } from "./database.ts";
import { gmailMessage } from "./items.ts";
import { daysFrom, hoursFrom, interactionId, iso } from "./values.ts";

// ---------------------------------------------------------------------------------------------
// seedPublic: the mixed store of gate test P2, written as pi_admin in SQL
// ---------------------------------------------------------------------------------------------

export const PUBLIC_NOW = new Date("2026-03-10T12:00:00.000Z");

// The entity ids a test chooses, so it controls their order: the owner, persons A to D, and the
// organization of example.org.
export type PublicIds = { owner: string; a: string; b: string; c: string; d: string; org: string };
type PublicCompartment = "public" | "own";
type PublicPerson = "a" | "b" | "c" | "d";

export const PUBLIC = Object.freeze({
  // Person A: three `public` inbound messages, each as the sender, two of them at one instant.
  a: { name: "Avery Stone", address: "stone.open@example.org" },
  // Person B: three `public` and five `own` inbound messages, each as the sender, and under `own`
  // another name, on the latest item of all.
  b: { name: "Avery Brook", address: "brook.mixed@example.org", ownName: "Brook Hiddenalias Canary" },
  // Person C: `own` messages only.
  c: { name: "Corin Canary-Ownonly", address: "corin.canary-ownonly@example.com" },
  // Person D: the sender of one `public` message, with an account row and a name under `own`
  // only (as a co-recipient of C's first message). No writer leaves a store so; it is here so a
  // reader that reaches an entity through its interactions, and not through a visible account,
  // is caught.
  d: { name: "Dara Canary-Halfseen", address: "canary-own-dara@example.org" },
  ownerAddress: { public: "owner.open@example.org", own: "owner.personal@example.com" },
  domain: "example.org",
  // The days before PUBLIC_NOW of each person's messages in each compartment. B's `own`
  // messages are both newer and older than its `public` ones, and three of them (7 to 9 days)
  // are alone in their week.
  days: {
    a: { public: [1, 2, 2], own: [] },
    b: { public: [4, 5, 6], own: [0.5, 7, 8, 9, 40] },
    c: { public: [], own: [10, 11] },
    d: { public: [3], own: [] },
  },
  // Sixty-five more people of example.org, known by an account row alone: fifty-five under
  // `public`, and ten under `own` whose ids sort among the first of them.
  members: { visible: 55, hidden: 10 },
  // Meetings a day ahead, at one instant: one with A and one with B, under `public`. And one
  // half a day ahead with B and C, under `own`.
  meetings: { one: "open meeting one", two: "open meeting two", own: "canary-own-meeting" },
  // What a client cleared for `public` alone must never see.
  ownNeedles: [
    "canary-own",
    "Corin Canary-Ownonly",
    "corin.canary-ownonly",
    "owner.personal",
    "example.com",
    "Hiddenalias",
    "Dara Canary-Halfseen",
  ],
});

// A row id that sorts by its parts: the prefix and 26 digits.
const rowId = (prefix: string, ...parts: number[]): string =>
  `${prefix}_${parts
    .map((part) => String(part).padStart(6, "0"))
    .join("")
    .padStart(26, "0")}`;

// The ids seedPublic gives the rows a test asks about by id. A visible member's id is even and a
// hidden one's odd, so the ten hidden ones sort among the first twenty.
export const publicMemberId = (kind: "visible" | "hidden", n: number): EntityId =>
  EntityId.parse(`ent_5${String(kind === "visible" ? 2 * n : 2 * n + 1).padStart(25, "0")}`);
export const publicMeetingId = (meeting: keyof typeof PUBLIC.meetings): string =>
  rowId("evt", { one: 1, two: 2, own: 3 }[meeting]);

// Writes, as pi_admin, the rows that make up the mixed store, in the order the foreign keys
// need: the source accounts; the entities; each item's blob and evidence row; the message and
// event rows; the interaction, event-detail and participant rows; the account and domain rows;
// the aliases. Every content value is sealed with sealRow under its row's compartment key, bound
// to its row and column, and every fingerprint comes from `fingerprint`. The caller passes the
// entity ids, so a test controls their order; every other id is a fixed function of what the row
// is, so two stores seeded with the same ids hold the same ids.
//
// With `only`, the rows of the other compartments, and the entities seen only there, are never
// written: the store as if they had never existed. With `reversed`, each table's rows are
// written in the opposite order, so the physical order of every table runs against its id
// order: a reader that returns rows in the order the table gives them answers differently.
export async function seedPublic(
  adminUrl: string,
  keys: Keys,
  ids: PublicIds,
  options?: { only?: PublicCompartment[]; reversed?: boolean },
): Promise<void> {
  const compartments: PublicCompartment[] = (["public", "own"] as const).filter(
    (one) => options?.only === undefined || options.only.includes(one),
  );
  const written = (compartment: PublicCompartment): boolean => compartments.includes(compartment);
  const ordinal = (compartment: PublicCompartment): number => (compartment === "public" ? 1 : 2);
  const people: PublicPerson[] = ["a", "b", "c", "d"];
  const personNumber = (person: PublicPerson): number => people.indexOf(person) + 1;
  const entityOf = (person: PublicPerson): string => EntityId.parse(ids[person]);
  const seal = (compartment: string, table: string, id: string, column: string, value: string): string =>
    JSON.stringify(sealRow(keys, compartment, { table, id, column }, value));
  const mailAccount = (compartment: PublicCompartment): SourceAccountId =>
    SourceAccountId.parse(rowId("acc", ordinal(compartment)));
  const calendarAccount = (compartment: PublicCompartment): SourceAccountId =>
    SourceAccountId.parse(rowId("acc", 10 + ordinal(compartment)));

  // One list of statements per step of the foreign-key order.
  type Statement = [text: string, values: unknown[]];
  const steps: Record<
    "accounts" | "entities" | "blobs" | "evidence" | "items" | "rows" | "addresses" | "aliases",
    Statement[]
  > = {
    accounts: [],
    entities: [],
    blobs: [],
    evidence: [],
    items: [],
    rows: [],
    addresses: [],
    aliases: [],
  };
  const entities = new Set<string>();
  const entity = (id: string, kind: "owner" | "person" | "organization"): void => {
    if (entities.has(id)) return;
    entities.add(id);
    steps.entities.push(["insert into knowledge.entities (id, kind) values ($1, $2)", [EntityId.parse(id), kind]]);
  };

  // 1. Per compartment, a mail account and a calendar account.
  for (const compartment of compartments) {
    const address = PUBLIC.ownerAddress[compartment];
    for (const [id, connector, kind] of [
      [mailAccount(compartment), "google_mail", "email"],
      [calendarAccount(compartment), "google_calendar", "calendar"],
    ] as const) {
      steps.accounts.push([
        `insert into vault.source_accounts (id, label, connector, source_kind, compartments, address_fp, address_enc)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          id,
          compartment === "public" ? "open" : "personal",
          connector,
          kind,
          [compartment],
          fingerprint(keys, "address", address),
          seal(compartment, "vault.source_accounts", id, "address_enc", address),
        ],
      ]);
    }
  }
  entity(ids.owner, "owner");

  // An item's blob and evidence row. It returns the evidence id.
  const evidence = (compartment: PublicCompartment, raw: RawItem, blobRef: string): string => {
    RawItemShape.parse(raw);
    const evidenceId = evidenceIdFor({
      vault: "personal",
      sourceAccount: raw.sourceAccount,
      sourceItemId: raw.sourceItemId,
      revision: 0,
    });
    const { payload, ...rest } = raw;
    steps.blobs.push([
      "insert into vault.evidence_blobs (blob_ref, envelope, compartments) values ($1, $2::jsonb, $3)",
      [blobRef, seal(compartment, "vault.evidence_blobs", blobRef, "envelope", payload), [compartment]],
    ]);
    steps.evidence.push([
      `insert into vault.evidence_items
         (id, source_account_id, source_kind, source_item_fp, revision_tag_fp, revision, next_revision_id, thread_fp, content_hash,
          media_type, observed_at, change_kind, participant_members, system_originated, answers_system, payload_state, compartments, readers,
          blob_ref, item_enc)
       values ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10, 'backfill', $11, false, false, 'present', $12, $11, $13, $14::jsonb)`,
      [
        evidenceId,
        raw.sourceAccount,
        raw.sourceKind,
        fingerprint(keys, "source_id", raw.sourceItemId),
        fingerprint(keys, "revision_tag", raw.revisionTag),
        evidenceIdFor({
          vault: "personal",
          sourceAccount: raw.sourceAccount,
          sourceItemId: raw.sourceItemId,
          revision: 1,
        }),
        raw.threadId === undefined ? null : fingerprint(keys, "thread", raw.threadId),
        hashFingerprint(
          keys,
          "content_hash",
          createHash("sha256").update(Buffer.from(payload, "base64")).digest("hex"),
        ),
        raw.mediaType,
        raw.observedAt,
        [THE_OWNER],
        [compartment],
        blobRef,
        seal(compartment, "vault.evidence_items", evidenceId, "item_enc", JSON.stringify(rest)),
      ],
    ]);
    return evidenceId;
  };
  const interaction = (
    compartment: PublicCompartment,
    evidenceId: string,
    entityId: string,
    at: Date,
    role: "sender" | "recipient",
  ): void => {
    steps.rows.push([
      `insert into knowledge.interaction_log
         (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, entity_role, compartments, readers)
       values ($1, $2, $3, $4, 'inbound', 'email', $5, $6, $7, $8)`,
      [
        interactionId(evidenceId, entityId),
        evidenceId,
        THE_OWNER,
        entityId,
        at.toISOString(),
        role,
        [compartment],
        [THE_OWNER],
      ],
    ]);
  };

  // 2. Each message, in one compartment, with its sender's interaction row.
  const firstEvidence = new Map<string, string>();
  for (const person of people) {
    for (const compartment of compartments) {
      for (const [index, days] of PUBLIC.days[person][compartment].entries()) {
        entity(entityOf(person), "person");
        const at = daysFrom(PUBLIC_NOW, -days);
        const parts = [personNumber(person), ordinal(compartment), index + 1];
        const gmailId = `open-${person}-${compartment}-${index}`;
        const subject =
          compartment === "own" ? `canary-own-subject-${person}-${index}` : `open subject ${person} ${index}`;
        const cc = person === "c" && index === 0 ? [{ address: PUBLIC.d.address, name: PUBLIC.d.name }] : [];
        const raw = gmailItem(
          gmailMessage({
            id: gmailId,
            threadId: `thread-${gmailId}`,
            messageId: `${gmailId}@mail.example.org`,
            at: iso(at),
            from: {
              name: compartment === "own" && person === "b" ? PUBLIC.b.ownName : PUBLIC[person].name,
              address: PUBLIC[person].address,
            },
            to: [{ address: PUBLIC.ownerAddress[compartment] }],
            cc,
            subject,
            labels: ["INBOX"],
          }),
          { sourceAccount: mailAccount(compartment), changeKind: "backfill" },
        );
        const evidenceId = evidence(compartment, raw, rowId("blb", ...parts));
        if (!firstEvidence.has(`${person}/${compartment}`)) firstEvidence.set(`${person}/${compartment}`, evidenceId);
        const messageId = rowId("msg", ...parts);
        const threadId = raw.threadId ?? "";
        const senderName = compartment === "own" && person === "b" ? PUBLIC.b.ownName : PUBLIC[person].name;
        // The message's row as the full-content store keeps it: a person's message in the primary
        // category, not held, with its sender and its facts sealed, and no text (these items are
        // headers alone).
        steps.items.push([
          `insert into knowledge.messages
             (id, evidence_id, sent_at, direction, bulk, category, held, thread_fp, sender_fp, sender_domain_fp,
              subject_enc, thread_id_enc, sender_enc, sender_name_enc, facts_enc, compartments)
           values ($1, $2, $3, 'inbound', false, 'primary', false, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12)`,
          [
            messageId,
            evidenceId,
            at.toISOString(),
            fingerprint(keys, "thread", threadId),
            fingerprint(keys, "address", PUBLIC[person].address),
            fingerprint(keys, "domain", PUBLIC[person].address.split("@")[1] ?? ""),
            seal(compartment, "knowledge.messages", messageId, "subject_enc", subject),
            seal(compartment, "knowledge.messages", messageId, "thread_id_enc", threadId),
            seal(compartment, "knowledge.messages", messageId, "sender_enc", PUBLIC[person].address),
            seal(compartment, "knowledge.messages", messageId, "sender_name_enc", senderName),
            seal(
              compartment,
              "knowledge.messages",
              messageId,
              "facts_enc",
              JSON.stringify({ chars: 0, unreadable: false, attachments: [] }),
            ),
            [compartment],
          ],
        ]);
        interaction(compartment, evidenceId, entityOf(person), at, "sender");
        if (cc.length > 0) {
          // D, copied on C's first message: its one `own` row, and what its `own` name cites.
          entity(entityOf("d"), "person");
          interaction(compartment, evidenceId, entityOf("d"), at, "recipient");
          firstEvidence.set(`d/${compartment}`, evidenceId);
        }
      }
    }
  }

  // 3. The meetings: the owner organizes each.
  const meeting = (
    key: keyof typeof PUBLIC.meetings,
    compartment: PublicCompartment,
    start: Date,
    guests: PublicPerson[],
  ): void => {
    if (!written(compartment)) return;
    const id = publicMeetingId(key);
    const end = hoursFrom(start, 1);
    const item = calendarItem(
      {
        id: `open-meeting-${key}`,
        status: "confirmed",
        etag: `"etag-open-meeting-${key}"`,
        updated: daysFrom(PUBLIC_NOW, -1).toISOString(),
        summary: PUBLIC.meetings[key],
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        organizer: { email: PUBLIC.ownerAddress[compartment] },
        attendees: guests.map((guest) => ({ email: PUBLIC[guest].address })),
      },
      { sourceAccount: calendarAccount(compartment), changeKind: "backfill", now: iso(PUBLIC_NOW) },
    );
    if (!("payload" in item)) throw new Error("a bare cancellation");
    const evidenceId = evidence(compartment, item, rowId("blb", 9, ordinal(compartment), Number(id.slice(-1))));
    steps.items.push([
      "insert into knowledge.events (id, event_kind, occurred_at, evidence_id, compartments, readers) values ($1, 'meeting', $2, $3, $4, $5)",
      [id, start.toISOString(), evidenceId, [compartment], [THE_OWNER]],
    ]);
    steps.rows.push([
      `insert into knowledge.event_details (event_id, account_id, source_event_fp, starts_at, ends_at, all_day, cancelled, title_enc, compartments)
       values ($1, $2, $3, $4, $5, false, false, $6::jsonb, $7)`,
      [
        id,
        calendarAccount(compartment),
        fingerprint(keys, "source_id", item.sourceItemId),
        start.toISOString(),
        end.toISOString(),
        seal(compartment, "knowledge.event_details", id, "title_enc", PUBLIC.meetings[key]),
        [compartment],
      ],
    ]);
    for (const guest of guests) {
      steps.rows.push([
        "insert into knowledge.event_participants (event_id, entity_id, participant_role, compartments) values ($1, $2, 'participant', $3)",
        [id, entityOf(guest), [compartment]],
      ]);
    }
  };
  meeting("one", "public", daysFrom(PUBLIC_NOW, 1), ["a"]);
  meeting("two", "public", daysFrom(PUBLIC_NOW, 1), ["b"]);
  meeting("own", "own", hoursFrom(PUBLIC_NOW, 12), ["b", "c"]);

  // 4. Account rows: the owner's address under each account's compartment; each person's under
  // each compartment it wrote in, D's under `own` alone; and the members', by an account alone.
  const address = (entityId: string, compartment: PublicCompartment, value: string, number: number): void => {
    if (!written(compartment)) return;
    const id = rowId("adr", number, ordinal(compartment));
    steps.addresses.push([
      `insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments)
       values ($1, $2, 'email', $3, $4, $5::jsonb, $6)`,
      [
        id,
        entityId,
        fingerprint(keys, "address", value),
        fingerprint(keys, "domain", value.split("@")[1] ?? ""),
        seal(compartment, "knowledge.accounts", id, "value_enc", value),
        [compartment],
      ],
    ]);
  };
  for (const compartment of compartments)
    address(EntityId.parse(ids.owner), compartment, PUBLIC.ownerAddress[compartment], 0);
  for (const person of people) {
    for (const compartment of compartments) {
      if (person === "d" ? compartment === "own" : PUBLIC.days[person][compartment].length > 0)
        address(entityOf(person), compartment, PUBLIC[person].address, personNumber(person));
    }
  }
  for (let n = 0; n < PUBLIC.members.visible; n += 1) {
    if (!written("public")) break;
    entity(publicMemberId("visible", n), "person");
    address(publicMemberId("visible", n), "public", `member-${String(n).padStart(2, "0")}@${PUBLIC.domain}`, 100 + n);
  }
  for (let n = 0; n < PUBLIC.members.hidden; n += 1) {
    if (!written("own")) break;
    entity(publicMemberId("hidden", n), "person");
    address(
      publicMemberId("hidden", n),
      "own",
      `canary-own-member-${String(n).padStart(2, "0")}@${PUBLIC.domain}`,
      200 + n,
    );
  }

  // 5. The organization of example.org, with a domain row under each compartment.
  entity(ids.org, "organization");
  for (const compartment of compartments) {
    const id = rowId("dom", ordinal(compartment));
    steps.addresses.push([
      "insert into knowledge.domains (id, domain_fp, entity_id, domain_enc, compartments) values ($1, $2, $3, $4::jsonb, $5)",
      [
        id,
        fingerprint(keys, "domain", PUBLIC.domain),
        EntityId.parse(ids.org),
        seal(compartment, "knowledge.domains", id, "domain_enc", PUBLIC.domain),
        [compartment],
      ],
    ]);
  }

  // 6. One alias per person and compartment, citing one of its items there.
  for (const person of people) {
    for (const compartment of compartments) {
      const evidenceId = firstEvidence.get(`${person}/${compartment}`);
      if (evidenceId === undefined || (person === "d" && compartment === "public")) continue;
      const name = compartment === "own" && person === "b" ? PUBLIC.b.ownName : PUBLIC[person].name;
      const id = rowId("als", personNumber(person), ordinal(compartment));
      steps.aliases.push([
        "insert into knowledge.aliases (id, entity_id, value_fp, evidence_id, value_enc, compartments) values ($1, $2, $3, $4, $5::jsonb, $6)",
        [
          id,
          entityOf(person),
          fingerprint(keys, "name", name),
          evidenceId,
          seal(compartment, "knowledge.aliases", id, "value_enc", name),
          [compartment],
        ],
      ]);
    }
  }

  await session(adminUrl, async (query) => {
    await query("begin");
    for (const step of Object.values(steps)) {
      for (const [text, values] of options?.reversed === true ? [...step].reverse() : step) await query(text, values);
    }
    await query("commit");
  });
}
