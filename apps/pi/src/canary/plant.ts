import { CANARY_COMPARTMENT, type MeetingItem, type MomentItem } from "@intelligence/contracts/personal";
import type { CalendarEvent, DocBody, DriveFile, GmailMessage } from "@intelligence/personal-core/items";

// One day's synthetic items for the standing end-to-end check, one per source, each stating a fresh
// fact about a fictional person at a reserved address. They are production code, since production
// code never loads the test support. Nothing here reads the clock or is random, so two calls for
// one day are deep-equal and a second try that day stores nothing new. Each is dated before the day
// begins, so none is ever in the future whenever the day's run starts: mail and the document an
// hour before, a meeting and a moment three, and an event two days after, in the coming week.

export const CANARY_LABEL = CANARY_COMPARTMENT;
export const CANARY_ADDRESS = "canary@example.invalid";
// The app whose captures the check's scope rule files under its compartment.
export const CANARY_APP = { bundle: "invalid.example.canary", name: "Canary" } as const;
export const CANARY_ROOT = "canaryRootFolder0001";

const HOUR = 3_600_000;
const seconds = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

// A capture key's ULID is 26 characters of Crockford's alphabet.
const captureUlid = (digits: string, letter: "M" | "N"): string => `01JC${digits}${letter}`.padEnd(26, "0");

type CanaryPerson = { name: string; address: string };
type CanaryProposal = { statement: string; quote: string; requestId: string };

export type CanaryPlant = {
  // The word of the day, and the mail's role title with it: each source says its own words, so a
  // read of one source's item is not satisfied by another's.
  word: string;
  title: string;
  people: Record<"mail" | "document" | "meeting" | "moment" | "contact" | "finding", CanaryPerson>;
  mail: GmailMessage;
  event: CalendarEvent;
  pastEvent: CalendarEvent;
  document: { file: DriveFile; body: DocBody };
  // As the People API answers: `whitelistedContact` reads it.
  contact: Record<string, unknown>;
  meeting: MeetingItem;
  moment: MomentItem;
  finding: { kind: "finding"; body: string; requestId: string; claims: Record<string, unknown>[] };
  proposal: CanaryProposal;
  // The same proposal asked again, under its own request id, once the first is answered.
  proposalAgain: CanaryProposal;
};

const person = (first: string, last: string): CanaryPerson => ({
  name: `${first} ${last}`,
  address: `${first}.${last}@example.invalid`.toLowerCase(),
});

export function canaryPlant(day: string): CanaryPlant {
  const digits = day.replaceAll("-", "");
  const dawn = Date.parse(`${day}T00:00:00Z`);
  const word = `quillwork${digits}`;
  const title = `head of ${word}`;
  const line = (who: string, what: string): string => `${who} is now ${what} of ${word} at Example Harbor.`;
  const people = {
    mail: person("Ines", "Varga"),
    // Everyone else is the person of the day's mail: one a read can find by name, whose timeline and
    // list entry rest on what each source added.
    document: person("Ines", "Varga"),
    meeting: person("Ines", "Varga"),
    moment: person("Ines", "Varga"),
    // The day's own, so a read cannot pass on yesterday's: a past event below gives them an
    // interaction to be listed by, and only the contact gives them a name.
    contact: person("Tomas", `Quill${digits}`),
    finding: person("Ines", "Varga"),
  };
  const contactId = `canary${digits}`;
  const contactSource = { metadata: { source: { type: "CONTACT", id: contactId } } };
  const capturedAt = dawn - 3 * HOUR;
  const momentLine = line(people.moment.name, "patron");
  const openingLine = `Good to see you. What is new? ${"Before you answer, a word on the plans. "}`;
  // The preferred object remains a meaningful work-writing preference when intake renders it
  // alone. The title carries the daily marker without asserting an invented airline exists.
  const stated = `The owner prefers work updates titled "${word} status report".`;
  const quote = `I prefer work updates titled "${word} status report".`;
  // Enough to pass the lanes' least length, and nothing to find in it.
  const filler =
    "We went over the week's schedule line by line, the room bookings and the small list of errands, and agreed to look at them again once the next round of notes comes in. Nothing else came up that needs a note, so the rest of the time went on the usual catching up about the weather and the trains. ";
  return {
    word,
    title,
    people,
    mail: {
      id: `canary${digits}mail`,
      threadId: `canary${digits}mail`,
      internalDate: dawn - HOUR,
      labelIds: ["INBOX", "CATEGORY_PERSONAL"],
      headers: [
        { name: "From", value: `${people.mail.name} <${people.mail.address}>` },
        { name: "To", value: CANARY_ADDRESS },
        { name: "Subject", value: `Quick update ${word}` },
        { name: "Date", value: new Date(dawn - HOUR).toUTCString() },
      ],
      text: `Hello, a short update from me. I am now ${title} at Example Harbor.`,
    },
    event: {
      id: `canary${digits}event`,
      status: "confirmed",
      updated: seconds(dawn - HOUR),
      summary: `Review of ${word}`,
      start: { dateTime: seconds(dawn + 48 * HOUR) },
      end: { dateTime: seconds(dawn + 49 * HOUR) },
      organizer: { email: CANARY_ADDRESS, self: true },
      attendees: [
        { email: CANARY_ADDRESS, self: true, responseStatus: "accepted" },
        { email: people.mail.address, displayName: people.mail.name, responseStatus: "accepted" },
      ],
    },
    pastEvent: {
      id: `canary${digits}past`,
      status: "confirmed",
      updated: seconds(dawn - 26 * HOUR),
      summary: `Earlier catch-up on ${word}`,
      start: { dateTime: seconds(dawn - 27 * HOUR) },
      end: { dateTime: seconds(dawn - 26 * HOUR) },
      organizer: { email: CANARY_ADDRESS, self: true },
      attendees: [
        { email: CANARY_ADDRESS, self: true, responseStatus: "accepted" },
        { email: people.contact.address, responseStatus: "accepted" },
      ],
    },
    document: {
      file: {
        id: `canary${digits}document`,
        name: `Notes on ${word}`,
        mimeType: "application/vnd.google-apps.document",
        createdTime: seconds(dawn - HOUR) as DriveFile["createdTime"],
        modifiedTime: seconds(dawn - HOUR) as DriveFile["modifiedTime"],
        parent: CANARY_ROOT,
        root: CANARY_ROOT,
        ownedByMe: true,
        modifiedByMe: true,
        owner: { address: CANARY_ADDRESS },
        canDownload: true,
      },
      body: {
        blocks: [
          {
            kind: "paragraph",
            text: `${people.document.address} will send ${CANARY_ADDRESS} the notes on ${word} by ${new Date(dawn + 7 * 24 * HOUR).toISOString().slice(0, 10)}.`,
          },
        ],
      },
    },
    contact: {
      resourceName: `people/${contactId}`,
      etag: `%E-${contactId}`,
      metadata: { sources: [{ type: "CONTACT", id: contactId, updateTime: seconds(dawn - HOUR) }] },
      names: [{ ...contactSource, displayName: people.contact.name }],
      emailAddresses: [{ ...contactSource, value: people.contact.address, type: "home" }],
    },
    meeting: {
      kind: "meeting",
      key: `meeting:${captureUlid(digits, "M")}`,
      revision: 0,
      startedAt: seconds(capturedAt),
      endedAt: seconds(capturedAt + HOUR / 2),
      app: CANARY_APP,
      title: `Catch-up ${word}`,
      consent: true,
      mode: "call",
      speakers: [
        { label: "S1", owner: true, mention: { address: CANARY_ADDRESS } },
        { label: "S2", owner: false, mention: { name: people.meeting.name, address: people.meeting.address } },
      ],
      segments: [
        { speaker: "S1", fromMs: 0, toMs: 5_000, channel: "input", text: `${openingLine}${filler}${filler}`.trimEnd() },
        { speaker: "S2", fromMs: 5_000, toMs: 15_000, channel: "output", text: line(people.meeting.name, "lead") },
      ],
    },
    moment: {
      kind: "moment",
      key: `moment:${captureUlid(digits, "N")}`,
      revision: 0,
      observedAt: seconds(capturedAt),
      endedAt: seconds(capturedAt + 60_000),
      app: CANARY_APP,
      entity: "chat",
      thread: `Chat ${word}`,
      participants: [{ name: people.moment.name, address: people.moment.address }],
      text: `${momentLine} ${filler}`.trimEnd(),
      read: "ax",
      turns: [{ from: 0, to: `${momentLine} ${filler}`.trimEnd().length, speaker: "participant", participant: 0 }],
    },
    finding: {
      kind: "finding",
      body: `${line(people.finding.name, "finder")} Noted by the standing check.`,
      requestId: `canary-${digits}-finding`,
      claims: [
        {
          subject: { address: people.finding.address },
          type: "role",
          fields: { title: `finder of ${word}`, organization_name: "Example Harbor" },
          cites: [],
          requestId: `canary-${digits}-finding-claim`,
        },
      ],
    },
    proposal: { statement: stated, quote, requestId: `canary-${digits}-propose-v4` },
    proposalAgain: { statement: stated, quote, requestId: `canary-${digits}-again-v4` },
  };
}
