import type { CaptureMention, MeetingCaptureFacts } from "@intelligence/contracts/personal";
import { normalizeAddress } from "../addresses.ts";
import { foldName } from "../text.ts";

// Whether a mention of a meeting is the owner, decided by code before any name
// or address is matched, so the owner is never bound to, made into or met as another person. A
// mention with an address is the owner's when the address is one of theirs (`own`, given a
// normalized address). A mention with a name and no address is the owner's when the name is one
// the meeting knows the owner by: the name on the speaker it marks as the owner, or on any of its
// mentions whose address is the owner's. The caller adds the names the store knows the owner by
// (their entity's aliases) by its own check. The owner wins over a namesake: in the owner's own
// meeting a mention of the owner's name with no address is the owner, whoever else holds that name.
export function meetingOwner(
  facts: MeetingCaptureFacts,
  own: (address: string) => boolean,
): (mention: CaptureMention | null | undefined) => boolean {
  const ownAddress = (address: string): boolean => {
    const normalized = normalizeAddress(address);
    return normalized !== null && own(normalized);
  };
  const mentions = [
    ...facts.speakers.map((one) => one.mention),
    ...(facts.attendees ?? []),
    facts.calendar?.organizer,
    ...(facts.calendar?.attendees ?? []),
  ];
  const names = new Set<string>();
  for (const speaker of facts.speakers)
    if (speaker.owner && speaker.mention?.name !== undefined) names.add(foldName(speaker.mention.name));
  for (const mention of mentions)
    if (mention?.name !== undefined && mention.address !== undefined && ownAddress(mention.address))
      names.add(foldName(mention.name));
  names.delete("");
  return (mention) => {
    if (mention === null || mention === undefined) return false;
    if (mention.address !== undefined) return ownAddress(mention.address);
    return mention.name !== undefined && names.has(foldName(mention.name));
  };
}

// An entry of the name with no address adds none. One address is the person the name is; two or
// more are namesakes, between whom code never chooses.
export function attendeeAddresses(facts: MeetingCaptureFacts, name: string): string[] {
  const folded = foldName(name);
  if (folded === "") return [];
  const listed = [...(facts.attendees ?? []), facts.calendar?.organizer, ...(facts.calendar?.attendees ?? [])];
  const addresses = new Map<string, string>();
  for (const one of listed) {
    if (one?.name === undefined || one.address === undefined || foldName(one.name) !== folded) continue;
    addresses.set(normalizeAddress(one.address) ?? one.address.trim().toLowerCase(), one.address);
  }
  return [...addresses.values()];
}

// The one address of `attendeeAddresses`, or null for none or namesakes.
export function attendeeAddress(facts: MeetingCaptureFacts, name: string): string | null {
  const [only, other] = attendeeAddresses(facts, name);
  return only !== undefined && other === undefined ? only : null;
}
