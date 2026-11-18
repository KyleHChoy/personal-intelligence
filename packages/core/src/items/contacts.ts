import {
  type ChangeKind,
  type LocalEntityId,
  type RawItem,
  type SourceAccountId,
  type SourceDeletion,
  Timestamp,
} from "@intelligence/contracts";
import { IMPORT_LIMITS, ImportedExtras, PersonLink } from "@intelligence/contracts/personal";
import { addressOf } from "../addresses.ts";
import { sha256 } from "../hash.ts";
import { resolutionRequestId } from "../limits.ts";
import { THE_OWNER } from "../owner.ts";
import { contactPhoneKey } from "../profile-key.ts";
import { codePoints } from "../units.ts";
import { fields, isRecord, isString, list, optional, whitelisted } from "../values.ts";
import { personLink, uniqueLinks } from "./person-links.ts";
import type { Contact, ItemContext, ItemFacts } from "./types.ts";

// A saved contact before it reaches the store. Code only: no network, no key and nothing a contact
// says is followed.

// The bounds of a contact's lists and texts, and of the unreadable contacts of one page.
export const CONTACT_LIMITS = Object.freeze({
  addresses: 20,
  names: 5,
  nicknames: 5,
  phones: 20,
  organizations: 5,
  links: 10,
  textChars: 200,
  unreadablePerPage: 5,
  unreadableShare: 0.02,
});

// One reading of a People answer's person. `allAddresses` is every address the strict reading
// accepts, each once, in source order, uncut; `refused` the normalizeAddress form of each value it
// refused that has one, for the suppression check alone, never stored.
export type ContactRead = { contact: Contact; allAddresses: string[]; badAddresses: number; refused: string[] };

type Fields = Record<string, unknown>;
const inRange =
  (low: number, high: number) =>
  (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;
const [isMonth, isDay] = [inRange(1, 12), inRange(1, 31)];

// The People types of a website that is the person's own.
const SITE_TYPES: ReadonlySet<string> = new Set(["homePage", "home", "blog"]);

// Only what the owner saved is evidence here: a value from any other source is dropped.
const saved = (entry: Fields): boolean => {
  const metadata = entry.metadata;
  if (!isRecord(metadata)) return false;
  const source = metadata.source;
  return isRecord(source) && source.type === "CONTACT";
};

// A text the whitelist keeps: present, not empty, at most textChars code points.
const kept = (text: string | undefined): text is string =>
  text !== undefined && text !== "" && codePoints(text) <= CONTACT_LIMITS.textChars;
const keptOrUndefined = (text: string | undefined): string | undefined => (kept(text) ? text : undefined);

// The one reading of a People answer's person, or null when a kept field has the wrong type.
export function whitelistedContact(value: unknown): ContactRead | null {
  return whitelisted(() => {
    const raw = fields(value);
    const resourceName = optional(raw.resourceName, isString);
    if (resourceName === undefined || resourceName === "") return null;
    const metadata = raw.metadata === undefined ? {} : fields(raw.metadata);
    const sources = list(metadata.sources);
    const updated = sources.flatMap((source) =>
      source.type === "CONTACT" ? (optional(source.updateTime, isString) ?? []) : [],
    )[0];

    const names = list(raw.names).flatMap((entry) => {
      const name = optional(entry.displayName, isString);
      return saved(entry) && kept(name) ? [name] : [];
    });
    const nicknames = list(raw.nicknames).flatMap((entry) => {
      const name = optional(entry.value, isString);
      return saved(entry) && kept(name) ? [name] : [];
    });

    const allAddresses: string[] = [];
    const refused: string[] = [];
    let badAddresses = 0;
    for (const entry of list(raw.emailAddresses)) {
      const text = optional(entry.value, isString);
      if (!saved(entry) || text === undefined) continue;
      const one = addressOf(text);
      if ("address" in one) {
        if (!allAddresses.includes(one.address)) allAddresses.push(one.address);
      } else {
        badAddresses += 1;
        if (one.refused !== null && !refused.includes(one.refused)) refused.push(one.refused);
      }
    }

    const phones = list(raw.phoneNumbers).flatMap((entry) => {
      const [phone, canonical, type] = [
        optional(entry.value, isString),
        optional(entry.canonicalForm, isString),
        optional(entry.type, isString),
      ];
      if (!saved(entry) || !kept(phone)) return [];
      const [canonicalKept, typeKept] = [keptOrUndefined(canonical), keptOrUndefined(type)];
      return [
        {
          value: phone,
          ...(canonicalKept === undefined ? {} : { canonical: canonicalKept }),
          ...(typeKept === undefined ? {} : { type: typeKept }),
        },
      ];
    });
    // A contact with no address the strict reading accepts and one phone in E.164 form is keyed by
    // that phone, `tel:` and the number, as an imported row with no address is keyed by its
    // profile: its one identifier, so no contact joins two.
    if (allAddresses.length === 0) {
      const key = contactPhoneKey(phones.slice(0, CONTACT_LIMITS.phones));
      if (key !== null) allAddresses.push(key);
    }
    const organizations = list(raw.organizations).flatMap((entry) => {
      const [name, title] = [
        keptOrUndefined(optional(entry.name, isString)),
        keptOrUndefined(optional(entry.title, isString)),
      ];
      if (!saved(entry) || (name === undefined && title === undefined)) return [];
      return [{ ...(name === undefined ? {} : { name }), ...(title === undefined ? {} : { title }) }];
    });
    const birthdays = list(raw.birthdays).flatMap((entry) => {
      if (entry.date === undefined) return [];
      const date = fields(entry.date);
      const [month, day] = [optional(date.month, isMonth), optional(date.day, isDay)];
      return saved(entry) && month !== undefined && day !== undefined ? [{ month, day }] : [];
    });
    const [birthday] = birthdays;
    // Each saved website, normalized (personLink); one Google calls a home page or a
    // blog is a personal site when its host gives no other kind. Its type is its label.
    const links = uniqueLinks(
      list(raw.urls).map((entry) => {
        const [value, type, formatted] = [
          optional(entry.value, isString),
          optional(entry.type, isString),
          optional(entry.formattedType, isString),
        ];
        if (!saved(entry) || value === undefined) return null;
        const label = keptOrUndefined(formatted ?? type);
        const link = personLink(value, label === undefined ? {} : { label });
        return link !== null && link.kind === "other" && SITE_TYPES.has(type ?? "")
          ? { ...link, kind: "personal_site" as const }
          : link;
      }),
      CONTACT_LIMITS.links,
    );

    return {
      contact: {
        resourceName,
        ...(updated === undefined ? {} : { updated }),
        names: names.slice(0, CONTACT_LIMITS.names),
        nicknames: nicknames.slice(0, CONTACT_LIMITS.nicknames),
        addresses: allAddresses.slice(0, CONTACT_LIMITS.addresses),
        phones: phones.slice(0, CONTACT_LIMITS.phones),
        organizations: organizations.slice(0, CONTACT_LIMITS.organizations),
        ...(birthday === undefined ? {} : { birthday }),
        ...(links.length === 0 ? {} : { links }),
      },
      allAddresses,
      badAddresses,
      refused,
    };
  });
}

// The payload with its keys in a fixed order, so one contact is one payload.
const ordered = (contact: Contact): Contact => ({
  resourceName: contact.resourceName,
  ...(contact.updated === undefined ? {} : { updated: contact.updated }),
  names: contact.names,
  nicknames: contact.nicknames,
  addresses: contact.addresses,
  phones: contact.phones.map((phone) => ({
    value: phone.value,
    ...(phone.canonical === undefined ? {} : { canonical: phone.canonical }),
    ...(phone.type === undefined ? {} : { type: phone.type }),
  })),
  organizations: contact.organizations.map((one) => ({
    ...(one.name === undefined ? {} : { name: one.name }),
    ...(one.title === undefined ? {} : { title: one.title }),
  })),
  ...(contact.birthday === undefined ? {} : { birthday: { month: contact.birthday.month, day: contact.birthday.day } }),
  ...(contact.links === undefined || contact.links.length === 0
    ? {}
    : {
        links: contact.links.map((link) => ({
          url: link.url,
          kind: link.kind,
          ...(link.label === undefined ? {} : { label: link.label }),
        })),
      }),
});

export const contactItemId = (resourceName: string): string => `contact:${resourceName}`;

// The tag is over the kept content without `updated`, and every address, so an edit to a field that
// is not kept makes no revision and an address past the twentieth does. An imported contact carries
// its `imported` fields in its payload and its tag; a saved contact carries none, so its payload
// and tag do not depend on the import fields.
export function contactItem(
  read: ContactRead,
  at: { sourceAccount: SourceAccountId; changeKind: ChangeKind; now: Timestamp },
  imported?: ImportedExtras,
): RawItem {
  const payload = { ...ordered(read.contact), ...(imported === undefined ? {} : { imported }) };
  const { updated, ...hashed } = payload;
  const tag = sha256(`${JSON.stringify(hashed)}\n${[...read.allAddresses].sort().join(",")}`);
  return {
    sourceKind: "crm",
    sourceAccount: at.sourceAccount,
    sourceItemId: contactItemId(read.contact.resourceName),
    revisionTag: `c:${tag}`,
    observedAt: updated !== undefined && Timestamp.safeParse(updated).success ? updated : at.now,
    depth: "full",
    changeKind: at.changeKind,
    payload: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    mediaType: "application/json",
    permissions: { scope: "listed", identifiers: [...read.allAddresses] },
    markers: [
      "contact",
      ...(read.badAddresses > 0 ? ["bad_address"] : []),
      ...read.refused.map((form) => `${REFUSED_MARKER}${form}`),
    ],
  };
}

// The marker that carries a refused value's normalizeAddress form to the writer's suppression
// check. The writer seals the item without it.
export const REFUSED_MARKER = "refused:";

export const contactDeletion = (
  resourceName: string,
  at: { sourceAccount: SourceAccountId; now: Timestamp },
): SourceDeletion => ({
  sourceAccount: at.sourceAccount,
  sourceItemId: contactItemId(resourceName),
  deletedAt: at.now,
});

// It reads every address the contact has, and nothing else. A phone key stands as an address
// (`no_address` is no address and no such phone).
export function contactKept(raw: RawItem, ownerAddresses: string[]): "keep" | "no_address" | "own_contact" {
  const identifiers = raw.permissions.scope === "listed" ? raw.permissions.identifiers : [];
  if (identifiers.length === 0) return "no_address";
  const owner = new Set(ownerAddresses.map((one) => one.toLowerCase()));
  return identifiers.some((one) => owner.has(one.toLowerCase())) ? "own_contact" : "keep";
}

// The stored payload as a Contact, or null when it does not read as one.
function storedContact(raw: RawItem): Contact | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw.payload, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const strings = (one: unknown): one is string[] => Array.isArray(one) && one.every(isString);
  const optionalString = (one: unknown) => one === undefined || isString(one);
  const { resourceName, updated, names, nicknames, addresses, phones, organizations, birthday } = value;
  if (
    !isString(resourceName) ||
    !optionalString(updated) ||
    !strings(names) ||
    !strings(nicknames) ||
    !strings(addresses)
  )
    return null;
  if (
    !Array.isArray(phones) ||
    !phones.every(
      (one) => isRecord(one) && isString(one.value) && optionalString(one.canonical) && optionalString(one.type),
    )
  )
    return null;
  if (
    !Array.isArray(organizations) ||
    !organizations.every((one) => isRecord(one) && optionalString(one.name) && optionalString(one.title))
  )
    return null;
  if (birthday !== undefined && !(isRecord(birthday) && isMonth(birthday.month) && isDay(birthday.day))) return null;
  if (value.imported !== undefined && !ImportedExtras.safeParse(value.imported).success) return null;
  if (value.links !== undefined && !PersonLink.array().max(IMPORT_LIMITS.list).safeParse(value.links).success)
    return null;
  return value as Contact;
}

// Each address is resolved alone; a contact that lists one address names its person, and one of two
// or more names nobody until the owner rules. The owner's own contact derives nothing.
export async function deriveContact(raw: RawItem, ctx: ItemContext): Promise<ItemFacts> {
  const members = { participantMembers: [THE_OWNER] };
  const contact = storedContact(raw);
  const listed = raw.permissions.scope === "listed" ? raw.permissions.identifiers : [];
  if (contact === null || contactKept(raw, ctx.ownerAddresses) === "own_contact") return { kind: "unread", members };

  // A profile-only imported row lists its profile's key as its one
  // identifier, which resolves here as an address does: no import joins two identifiers.
  const people: { entity: LocalEntityId; address: string }[] = [];
  for (const [index, address] of [...new Set(contact.addresses)].entries()) {
    const resolution = await ctx.identity.resolve(
      { key: { kind: "address", value: address }, observedAt: raw.observedAt },
      "people",
      resolutionRequestId(ctx, "contact", index),
    );
    if (resolution.outcome !== "linked" && resolution.outcome !== "created") continue;
    if (resolution.entity === ctx.ownerEntity) continue;
    people.push({ entity: resolution.entity, address });
  }
  const all = [...contact.names, ...contact.nicknames];
  const [one] = people;
  const names =
    listed.length === 1 && people.length === 1 && one !== undefined
      ? [...new Set(all)].map((name) => ({ entity: one.entity, name }))
      : [];
  return {
    kind: "contact",
    members,
    contact: {
      sourceId: raw.sourceItemId,
      updatedAt: raw.observedAt,
      names: all,
      phones: contact.phones.map((phone) => ({
        value: phone.value,
        canonical: phone.canonical ?? null,
        type: phone.type ?? null,
      })),
      organizations: contact.organizations.map((org) => ({ name: org.name ?? null, title: org.title ?? null })),
      birthday: contact.birthday === undefined ? null : { month: contact.birthday.month, day: contact.birthday.day },
      ...(contact.links === undefined || contact.links.length === 0 ? {} : { links: contact.links }),
      ...(contact.imported === undefined ? {} : { imported: contact.imported }),
    },
    people,
    names,
  };
}
