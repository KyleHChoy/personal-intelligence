import type { RawItem, SourceAccountId, Timestamp } from "@intelligence/contracts";
import { addressOf, normalizeAddress } from "../addresses.ts";
import { profileKey } from "../profile-key.ts";
import { contactItem } from "./contacts.ts";
import { personLink } from "./person-links.ts";

// A person the owner confirmed from an agent's proposal, as one saved contact of that agent's
// people source (`agent-people:<client>`), so the contacts path makes the person: identity by exact
// address, aliases from the name, erasure and suppression, all unchanged. Code only: what the agent
// wrote is data, and the owner confirmed it before it reaches here.

// The resource name of a confirmed person's contact: one per proposal record, by the record's
// evidence id, so a re-run never makes a second contact and an erasure can name the record.
export const agentPersonId = (recordEvidence: string): string => `proposal:${recordEvidence}`;
export const recordOfAgentPerson = (resourceName: string): string | null =>
  resourceName.startsWith("proposal:") ? resourceName.slice("proposal:".length) : null;

export type ConfirmedPerson = {
  name: string;
  email?: string | undefined;
  phone?: string | undefined;
  linkedin?: string | undefined;
};

// The one identifier the person's contact is keyed by, as the writer's identity port
// keys it (its normal form: an address in lower case, a LinkedIn profile's key), or null when
// neither is given and the proposal itself keys it. The card asks whether this one is held.
export function agentPersonKey(person: Pick<ConfirmedPerson, "email" | "linkedin">): string | null {
  const read = person.email === undefined ? null : addressOf(person.email);
  const address = read !== null && "address" in read ? normalizeAddress(read.address) : null;
  return address ?? (person.linkedin === undefined ? null : profileKey(person.linkedin));
}

// The person's identifiers, as an imported row's: the address when it
// reads strictly; else the LinkedIn profile's key; else `proposalKey`, the key of the confirmed
// proposal itself (profile-key.ts), so a person proposed with no identifier is still one person,
// keyed by what the owner confirmed and by no name. `id` is the item's resource name.
export function agentPersonItem(
  person: ConfirmedPerson,
  at: { sourceAccount: SourceAccountId; now: Timestamp; id: string; proposalKey: string },
): RawItem {
  const read = person.email === undefined ? null : addressOf(person.email);
  const address = read !== null && "address" in read ? read.address : null;
  const refused = read !== null && "refused" in read && read.refused !== null ? [read.refused] : [];
  const allAddresses = [agentPersonKey(person) ?? at.proposalKey];
  const link = person.linkedin === undefined ? null : personLink(person.linkedin);
  const contact = {
    resourceName: at.id,
    names: [person.name],
    nicknames: [],
    addresses: allAddresses,
    phones: person.phone === undefined ? [] : [{ value: person.phone }],
    organizations: [],
    links: link === null ? [] : [link],
  };
  return contactItem(
    { contact, allAddresses, badAddresses: read !== null && address === null ? 1 : 0, refused },
    { sourceAccount: at.sourceAccount, changeKind: "live", now: at.now },
  );
}
