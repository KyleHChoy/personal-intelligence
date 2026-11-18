import type { RawItem, SourceAccountId, Timestamp } from "@intelligence/contracts";
import type { MacContactItem } from "@intelligence/contracts/personal";
import { addressOf } from "../addresses.ts";
import { contactPhoneKey } from "../profile-key.ts";
import { CONTACT_LIMITS, contactItem, contactItemId } from "./contacts.ts";

// A Mac contact Lens sent, as one source item of the device's `lens_contacts` account, read as a
// saved contact is. Code only: nothing an entry says is followed. Its resource name is the key's
// ULID after `lens:`, so its source item id is `contact:lens:<ULID>` and no name, phone or email is
// in it or its evidence id.

// The source item id of a Mac contact's key, `contact:<ULID>`.
export const macContactItemId = (key: string): string => contactItemId(`lens:${key.slice("contact:".length)}`);

// The contacts' payload: the entry's name and nickname, each phone as its own canonical form (Lens
// sends only E.164), no organization, birthday or link. Its identifiers, in `addresses` and in
// `permissions` listed, are its emails, read strictly as a saved contact's are; with none, the one
// phone key contactPhoneKey gives, as the import connector adds it. No `updated`: the drain's clock
// is its time.
export function macContactItem(item: MacContactItem, at: { sourceAccount: SourceAccountId; now: Timestamp }): RawItem {
  const allAddresses: string[] = [];
  const refused: string[] = [];
  let badAddresses = 0;
  for (const email of item.emails) {
    const one = addressOf(email);
    if ("address" in one) {
      if (!allAddresses.includes(one.address)) allAddresses.push(one.address);
    } else {
      badAddresses += 1;
      if (one.refused !== null && !refused.includes(one.refused)) refused.push(one.refused);
    }
  }
  const phones = item.phones.slice(0, CONTACT_LIMITS.phones).map((value) => ({ value, canonical: value }));
  const keyed = allAddresses.length === 0 ? contactPhoneKey(phones) : null;
  if (keyed !== null) allAddresses.push(keyed);
  const contact = {
    resourceName: `lens:${item.key.slice("contact:".length)}`,
    names: [item.name],
    nicknames: item.nickname === undefined ? [] : [item.nickname],
    addresses: allAddresses.slice(0, CONTACT_LIMITS.addresses),
    phones,
    organizations: [],
  };
  return contactItem(
    { contact, allAddresses, badAddresses, refused },
    { sourceAccount: at.sourceAccount, changeKind: "live", now: at.now },
  );
}
