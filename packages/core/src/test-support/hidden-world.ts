import type { CalendarEvent, CalendarPerson, GmailMessage } from "../items/types.ts";
import type { World } from "./world.ts";

// The hidden twin of a world, for invariant 6's world pairs. It is the base world with, under one compartment
// only, `perTable` more messages and `perTable` more events: mail from and to the base world's own
// correspondents and domains, half of it in the base world's own threads, and meetings with the same people,
// so that every person, sender, domain and thread a viewer of the other compartments can see has rows it
// cannot; and with four people of its own, whom only that compartment knows, so that an id a viewer cannot see
// exists. Every account under another compartment, and everything the base world expects, is unchanged.
// Nothing is random: two calls with one base and one count are deep-equal.

export type HiddenOptions = { compartment: string; perTable: number };

const [MINUTE, HOUR, DAY] = [60_000, 3_600_000, 86_400_000];

// Gmail ids are hexadecimal; the base world's accounts use 19a and 19b.
const PREFIX = "19f";
const BODY = "Noted, thank you.\r\n";

// Reserved for examples (RFC 2606, RFC 6761): every address the hidden world writes is on one.
export const isReserved = (address: string): boolean => {
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  return (
    domain.endsWith(".test") ||
    ["example.com", "example.org", "example.net"].some((one) => domain === one || domain.endsWith(`.${one}`))
  );
};

type Person = { name: string | null; address: string };

// The people of one header: `Name <address>` or a bare address, comma separated.
function peopleOf(value: string): Person[] {
  return value.split(",").flatMap((part) => {
    const text = part.trim();
    const angled = /^(.*)<([^<>\s]+@[^<>\s]+)>$/.exec(text);
    if (angled !== null) {
      const name = (angled[1] ?? "").trim().replace(/^"|"$/g, "");
      return [{ name: name === "" ? null : name, address: (angled[2] ?? "").toLowerCase() }];
    }
    return /^[^<>\s]+@[^<>\s]+$/.test(text) ? [{ name: null, address: text.toLowerCase() }] : [];
  });
}

// Every correspondent of the base world: each address on a message's From, To or Cc, or on an
// event, but the owner's, on a reserved domain, once, with the first display name it was given;
// in order of address.
export function correspondentsOf(base: World): Person[] {
  const owner = new Set(base.owner.addresses.map((address) => address.toLowerCase()));
  const found = new Map<string, Person>();
  const add = (one: Person): void => {
    if (owner.has(one.address) || !isReserved(one.address)) return;
    const known = found.get(one.address);
    if (known === undefined) found.set(one.address, one);
    else if (known.name === null && one.name !== null) known.name = one.name;
  };
  for (const account of base.accounts) {
    for (const message of account.messages) {
      for (const header of message.headers)
        if (["from", "to", "cc"].includes(header.name.toLowerCase())) peopleOf(header.value).forEach(add);
    }
    for (const event of account.events) {
      for (const one of [event.organizer, ...(event.attendees ?? [])])
        if (one !== undefined) add({ name: one.displayName ?? null, address: one.email.toLowerCase() });
    }
  }
  return [...found.values()].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}

// The people only the hidden compartment knows: no base world item names them.
export const HIDDEN_ONLY: readonly Person[] = Object.freeze(
  [1, 2, 3, 4].map((n) => ({ name: `Hidden Person${n}`, address: `hidden.person${n}@hidden.example.org` })),
);

const mailbox = (one: Person): string => (one.name === null ? one.address : `${one.name} <${one.address}>`);
const wholeSecond = (now: number): number => Math.floor(now / 1000) * 1000;

export function hiddenWorld(base: World, options: HiddenOptions): World {
  if (!Number.isInteger(options.perTable) || options.perTable < 0)
    throw new Error("hiddenWorld: perTable is a whole number");
  const hidden = structuredClone(base);
  const account = hidden.accounts.find((one) => one.compartment === options.compartment);
  if (account === undefined) throw new Error(`hiddenWorld: the base world has no account under ${options.compartment}`);
  const people = [...correspondentsOf(base), ...HIDDEN_ONLY];
  // Each thread of the base world, every account's, once, in order.
  const threads = [...new Set(base.accounts.flatMap((one) => one.messages.map((message) => message.threadId)))].sort();
  const me: Person = { name: base.owner.name, address: account.address };
  const now = wholeSecond(Date.parse(base.now));

  for (let k = 0; k < options.perTable; k += 1) {
    const id = `${PREFIX}${k.toString(16).padStart(13, "0")}`;
    const other = people[k % people.length] as Person;
    const copied = people[(k + 1) % people.length] as Person;
    // Each correspondent is written to and writes back in turn, so its mail is kept.
    const outbound = (Math.floor(k / people.length) + (k % people.length)) % 2 === 1;
    // Spread over the last 150 days, never in the future.
    const internalDate = now - (((k * 7) % 150) * DAY + (k % 24) * HOUR + (k % 50) * MINUTE + MINUTE);
    const date = new Date(internalDate - (1 + (k % 10)) * MINUTE).toUTCString().replace("GMT", "+0000");
    const message: GmailMessage = {
      id,
      threadId: k % 2 === 0 ? (threads[(k / 2) % threads.length] ?? id) : id,
      internalDate,
      labelIds: outbound ? ["SENT"] : ["INBOX"],
      text: BODY,
      headers: [
        { name: "From", value: mailbox(outbound ? me : other) },
        { name: "To", value: mailbox(outbound ? other : me) },
        ...(k % 3 === 0 ? [{ name: "Cc", value: mailbox(copied) }] : []),
        { name: "Date", value: date },
        { name: "Subject", value: `Hidden note ${k}` },
        { name: "Message-ID", value: `<${id}@hidden.example.com>` },
      ],
    };
    account.messages.push(message);
  }

  for (let k = 0; k < options.perTable; k += 1) {
    const id = `evt-hidden-${k}`;
    const a = people[k % people.length] as Person;
    const b = people[(k + 1) % people.length] as Person;
    // From twenty days before now to twenty after, so some are upcoming.
    const start = now + ((k % 40) - 20) * DAY + ((k % 9) + 1) * HOUR;
    const attendee = (one: Person): CalendarPerson => ({
      email: one.address,
      ...(one.name === null ? {} : { displayName: one.name }),
      responseStatus: "accepted",
    });
    const event: CalendarEvent = {
      id,
      status: "confirmed",
      etag: `etag-${id}`,
      updated: new Date(now - DAY - (k % 24) * HOUR).toISOString(),
      summary: `Hidden meeting ${k}`,
      start: { dateTime: new Date(start).toISOString() },
      end: { dateTime: new Date(start + HOUR).toISOString() },
      organizer: { email: me.address, self: true },
      attendees: [{ email: me.address, self: true, responseStatus: "accepted" }, attendee(a), attendee(b)],
    };
    account.events.push(event);
  }
  return hidden;
}
