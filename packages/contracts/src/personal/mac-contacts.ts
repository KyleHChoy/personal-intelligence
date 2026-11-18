import { z } from "zod";
import { deepFreeze, E164_PHONE, isSourceAddress } from "./capture-forms.ts";
import { ClientName, ULID_PATTERN } from "./ids.ts";

// The owner's Mac contacts, sent by Lens so the phone handles of the owner's iMessage threads bind
// to the people they saved. A Mac contact is one entry of the Mac's address book whose phone or
// email is a handle of a thread Lens sent; Lens sends it with push_capture, and the box writes it
// through the contacts writer as a saved contact of the device's own source account. Every string
// is the device's account of what the address book holds: untrusted data, checked for form and size
// and never for meaning. No shape has a field for a label, a compartment, an entity id or any other
// id of the system. Only personal code imports these.
//
// The box's lane adds both items to `CaptureItem` and both key forms to `CaptureKey`, in the pull
// request that teaches `policy.push_capture` the two kinds, so no build parses an item the box's
// function would refuse.

// A name: 1 to `most` code points, no control character at all (a tab or a line feed included,
// unlike capture.ts's free text: a name is one line), and no white space at either end.
const CONTROL = /\p{Cc}/u;
const bounded = (most: number) =>
  z
    .string()
    .min(1)
    .max(most)
    .refine((value) => !CONTROL.test(value), { message: "a control character" })
    .refine((value) => value.trim() === value, { message: "no white space at either end" });

// Lens holds at most `listed` Mac contacts sent, so its listing always fits.
export const MAC_CONTACT_LIMITS = deepFreeze({ name: 200, phones: 20, emails: 20, listed: 2_000 } as const);

// `contacts:` and a ULID for one listing, a new one each listing.
export const MacContactKey = z.string().regex(new RegExp(`^contact:${ULID_PATTERN}$`));
export type MacContactKey = z.infer<typeof MacContactKey>;
export const MacContactsKey = z.string().regex(new RegExp(`^contacts:${ULID_PATTERN}$`));
export type MacContactsKey = z.infer<typeof MacContactsKey>;

const revision = z.number().int().min(0).max(1000);
const increasing = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);

// `name` is the entry's given, middle and family names joined by spaces; `nickname` its nickname.
// `phones` are the entry's phones that equal a handle of a thread Lens sent, in E.164 form, and
// only those; `emails` are every email of the entry, in lower case. Each list is in strictly
// increasing order, so each value is once and a rebuild of an unchanged entry is unchanged. At
// least one phone or email. No organization, title, note, postal address, birthday, photo, related
// name, URL or the address book's own id crosses.
export const MacContactItem = z
  .strictObject({
    kind: z.literal("contact"),
    key: MacContactKey,
    revision,
    name: bounded(MAC_CONTACT_LIMITS.name),
    nickname: bounded(MAC_CONTACT_LIMITS.name).optional(),
    phones: z
      .array(z.string().regex(E164_PHONE))
      .max(MAC_CONTACT_LIMITS.phones)
      .refine(increasing, { message: "phones in strictly increasing order" }),
    emails: z
      .array(z.string().refine(isSourceAddress, { message: "an email in lower case" }))
      .max(MAC_CONTACT_LIMITS.emails)
      .refine(increasing, { message: "emails in strictly increasing order" }),
  })
  .refine((item) => item.phones.length + item.emails.length > 0, { message: "a phone or an email" });
export type MacContactItem = z.infer<typeof MacContactItem>;

// The box removes each Mac contact of the device not in `keys` whose latest revision arrived before
// the listing. `revision` is always 0: each listing is a key of its own; it is here so every item
// but a forget carries one. Lens sends a listing past `removalNeedsConfirm` only after the owner's
// yes on the Mac; the box applies every listing as a contacts listing is applied, since a guard of
// its own could not tell Lens it held one.
export const MacContactsListed = z.strictObject({
  kind: z.literal("contacts"),
  key: MacContactsKey,
  revision: z.literal(0),
  keys: z
    .array(MacContactKey)
    .max(MAC_CONTACT_LIMITS.listed)
    .refine((keys) => new Set(keys).size === keys.length, { message: "a key twice" }),
});
export type MacContactsListed = z.infer<typeof MacContactsListed>;

// The two items, for the box's lane to add to `CaptureItem`.
export const MacContactPushItem = z.discriminatedUnion("kind", [MacContactItem, MacContactsListed]);
export type MacContactPushItem = z.infer<typeof MacContactPushItem>;

// A listing needs the owner's yes on the Mac when it keeps none of the Mac contacts Lens holds
// sent, or removes more than `most` of them and more than `share` of them. Kept here so Lens's copy
// is tested against the same vectors.
const MAC_CONTACT_REMOVAL_GUARD = deepFreeze({ most: 5, share: 0.5 } as const);
export const removalNeedsConfirm = (stored: number, kept: number): boolean => {
  const removed = stored - kept;
  if (removed <= 0) return false;
  return kept === 0 || (removed > MAC_CONTACT_REMOVAL_GUARD.most && removed > stored * MAC_CONTACT_REMOVAL_GUARD.share);
};

// `switched_off`: the device's switch was off at drain; `system_ids`: a name or email held a system
// id; `own_contact`, `no_address` and `suppressed`: the contacts' own refusals; `outranked`: a Mac
// contact with no email whose phone a stored contact with an address holds (saved, imported or
// another Mac contact), or whose handle the owner bound; `invalid_item`: a body that did not match
// its fingerprint or parse.
export const MAC_CONTACT_DROPS = Object.freeze([
  "switched_off",
  "system_ids",
  "own_contact",
  "no_address",
  "suppressed",
  "outranked",
  "invalid_item",
] as const);
export const MacContactDrop = z.enum(MAC_CONTACT_DROPS);
export type MacContactDrop = z.infer<typeof MacContactDrop>;

const count = z.number().int().min(0);

// Counts only: no name, phone or email. `dropped` counts the device's inbox rows the drain dropped,
// by code, while they are kept.
export const MacContactsView = z.strictObject({
  device: ClientName,
  on: z.boolean(),
  stored: count,
  dropped: z.partialRecord(MacContactDrop, count),
});
export type MacContactsView = z.infer<typeof MacContactsView>;
