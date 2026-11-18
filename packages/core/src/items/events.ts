import { DateOnly, Timestamp } from "@intelligence/contracts";
import { normalizeAddress } from "../addresses.ts";
import { PipelineError } from "../claim-pipeline/errors.ts";
import { isBareCancellation, whitelistedEvent } from "./builders.ts";
import { nameFor } from "./names.ts";
import type { CalendarEvent, CalendarPerson, CalendarTime, EventFacts } from "./types.ts";

// What one calendar event says, which the shared pipeline does not read: who is on it, when
// it is, and what the owner answered. Code only. A title is data and is returned unchanged.

// Whether an address is one of the owner's, compared as normalizeAddress writes both.
export function isOwnerAddress(address: string, ownerAddresses: string[]): boolean {
  const normalized = normalizeAddress(address);
  return normalized !== null && ownerAddresses.some((own) => normalizeAddress(own) === normalized);
}

// It is other people's data, so every field of the whitelist is checked before any is read, by the
// one reading of the whitelist: JSON that is no event, or holds a field of the wrong type, is
// refused as parse_failed and never read into facts. A key outside the whitelist is never read.
export function eventOf(payload: Uint8Array): CalendarEvent {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new PipelineError("parse_failed");
  }
  const event = whitelistedEvent(value);
  if (event === null) throw new PipelineError("parse_failed");
  return event;
}

// They are calendars, not people.
const CALENDAR_DOMAINS = ["group.calendar.google.com", "import.calendar.google.com", "resource.calendar.google.com"];

// The instant in UTC, when that is a timestamp. A time whose offset carries it, written in
// UTC, into a year a timestamp cannot hold (below 100, or above 9999) is none.
const utc = (text: string): string | null => {
  const at = Date.parse(text);
  const written = Number.isNaN(at) ? null : new Date(at).toISOString();
  return written !== null && Timestamp.safeParse(written).success ? written : null;
};

// Anything else is null, never a guess.
function timeOf(time: CalendarTime | undefined): string | null {
  if (time?.dateTime !== undefined) return Timestamp.safeParse(time.dateTime).success ? utc(time.dateTime) : null;
  if (time?.date !== undefined) return DateOnly.safeParse(time.date).success ? utc(`${time.date}T00:00:00Z`) : null;
  return null;
}

export function readEvent(event: CalendarEvent, ownerAddresses: string[]): EventFacts {
  if (isBareCancellation(event)) throw new PipelineError("parse_failed");

  const participants: EventFacts["participants"] = [];
  // Adds a person once, by address.
  const add = (one: CalendarPerson, role: "organizer" | "attendee"): boolean | undefined => {
    const address = normalizeAddress(one.email);
    if (one.resource === true || address === null || CALENDAR_DOMAINS.includes(address.split("@")[1] ?? ""))
      return undefined;
    const owner = one.self === true || isOwnerAddress(address, ownerAddresses);
    const name = nameFor(one.displayName, address);
    const at = participants.findIndex((known) => known.person.address === address);
    const known = participants[at];
    if (known === undefined)
      participants.push({ person: { address, ...(name === undefined ? {} : { name }) }, role, owner });
    else {
      // The same address again: an organizer stays one, and the first name it carries is kept.
      participants[at] = {
        person: known.person.name !== undefined || name === undefined ? known.person : { address, name },
        role: known.role === "organizer" ? "organizer" : role,
        owner: known.owner || owner,
      };
    }
    return owner;
  };

  if (event.organizer !== undefined) add(event.organizer, "organizer");
  // The owner's own response: that of the first attendee marked as the owner.
  let ownerAttendee: CalendarPerson | undefined;
  for (const attendee of event.attendees ?? []) {
    const owner = add(attendee, attendee.organizer === true ? "organizer" : "attendee");
    if (owner === true) ownerAttendee ??= attendee;
  }

  return {
    sourceId: event.id,
    revision: event.etag || event.updated || null,
    cancelled: event.status === "cancelled",
    title: event.summary ?? null,
    startsAt: timeOf(event.start),
    endsAt: timeOf(event.end),
    allDay: event.start?.dateTime === undefined && event.start?.date !== undefined,
    ...(ownerAttendee?.responseStatus === undefined ? {} : { ownerResponse: ownerAttendee.responseStatus }),
    participants,
    ...(event.callLink === undefined ? {} : { callLink: event.callLink }),
    ...(event.inviteLink === undefined ? {} : { inviteLink: event.inviteLink }),
  };
}
