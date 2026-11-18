import type {
  AccessListPage,
  ConnectorCursor,
  ConnectorPage,
  EvidenceId,
  IdentityResolver,
  InteractionRecord,
  LocalEntityId,
  MemberId,
  RawItem,
  SkippedItem,
  SourceAccount,
  SourceAccountId,
  Timestamp,
} from "@intelligence/contracts";
import type {
  DocumentKind,
  DocumentUnreadable,
  EntityId,
  ImportedExtras,
  MessageCategory,
  PageUrl,
  PersonLink,
  ResearchRequestId,
  RestrictedCategory,
} from "@intelligence/contracts/personal";
import type { MailAuth } from "./mail-auth.ts";

// The types personal code shares between its own packages. They cross no boundary beyond
// personal code, so they live here and not in contracts. The shared shapes (RawItem,
// SourceDeletion and the rest) are the contracts', used unchanged.

// What is recorded of an attachment, never its bytes. `name` may be empty; `size` is in bytes.
export type Attachment = { name: string; type: string; size: number };

// Gmail's format=full answer. `internalDate` is milliseconds since the epoch. `text` and `html`
// are the message's plain text and HTML, decoded; an absent `attachments` is none. `unreadable`
// is true for a message the connector could read only by its headers: it then has no `text`
// and no `html`.
export type GmailMessage = {
  id: string;
  threadId: string;
  internalDate: number;
  labelIds: string[];
  headers: { name: string; value: string }[];
  text?: string;
  html?: string;
  attachments?: Attachment[];
  unreadable?: boolean;
};

export type CalendarTime = { dateTime?: string; date?: string };

export type CalendarPerson = {
  email: string;
  displayName?: string;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  self?: boolean;
  resource?: boolean;
  organizer?: boolean;
};

// The whitelist of an event's fields. A bare cancellation may carry only `id` and `status`.
export type CalendarEvent = {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  etag?: string;
  updated?: string;
  summary?: string;
  start?: CalendarTime;
  end?: CalendarTime;
  organizer?: CalendarPerson;
  attendees?: CalendarPerson[];
  // Untrusted data the system never follows.
  callLink?: string;
  inviteLink?: string;
};

// On a page of a full listing. `first` is the listing's first page; `ended` is on its last
// page, `complete` when it reached the source's end and `window` when it stopped at the
// backfill window. `since` is the lower bound the listing actually used, and `until` the upper
// bound on an event's start, exclusive, that a calendar listing sent as timeMax.
export type ListingMark = { first: boolean; ended?: "window" | "complete"; since?: Timestamp; until?: Timestamp };

// A superset of ConnectorPage. `more` is true when the source's answer carried a next page token:
// there is another page to read, whatever this one holds. A page of a full listing carries its
// mark. `listed` holds source item ids the page names and hands nothing else of. `left` holds the
// source item ids the page saw leave the owner's scope. `added`: on a Gmail history page, how many
// message ids its own history records list as added, 0 on a page that only continues `pending`;
// absent on any other page. Sync sums it for coverage.
export type PersonalPage = ConnectorPage & {
  more: boolean;
  listing?: ListingMark;
  listed?: string[];
  left?: string[];
  added?: number;
};

// A connector reads one source and keeps no state. It never advances a cursor: ingest stores
// `next` only after the evidence writer commits. A failed page rejects and returns no `next`.
export interface Connector {
  listChanges(account: SourceAccount, cursor: ConnectorCursor | null, limit: number): Promise<ConnectorPage>;
  syncAccessList(account: SourceAccount, cursor: ConnectorCursor | null): Promise<AccessListPage>;
}

// It satisfies Connector. `resetCursor` is the cursor a reset
// stores, so that a reset whose run fails is still a reset on the next run: for mail one that
// starts a new listing to the mailbox's end, and for a calendar null, the cleared cursor.
export type PersonalConnector = {
  listChanges(account: SourceAccount, cursor: ConnectorCursor | null, limit: number): Promise<PersonalPage>;
  syncAccessList(account: SourceAccount, cursor: ConnectorCursor | null): Promise<AccessListPage>;
  resetCursor(): ConnectorCursor | null;
};

// `since` is the backfill window's start. For Drive: `roots`, each a folder id, `my-drive` or
// `shared-with-me`, and `stored`, which says whether an item, and with a tag that revision, is
// stored already or erased.
export type ConnectorOptions = {
  since?: Timestamp;
  roots?: string[];
  stored?: (sourceItemId: string, revisionTag?: string) => Promise<boolean>;
  // In any other phase no call is made and the page is empty, its `next` the cursor it was given.
  removalsOnly?: boolean;
};

// `list` names ids, newest first, within the window (`after` and `before` in whole epoch seconds),
// and `fetch` hands over those ids as headers-depth items, in order, with how many are gone and
// those skipped.
export type TiesPass = "sent" | "rest";
export type TiesReader = {
  list(
    pass: TiesPass,
    window: { after: number; before?: number },
    pageToken?: string,
  ): Promise<{ ids: string[]; next?: string }>;
  fetch(ids: string[]): Promise<{ items: RawItem[]; gone: number; skipped: SkippedItem[] }>;
};

// One connected label, as sync takes it.
export type PersonalSource = {
  label: string;
  compartment: string;
  profile(): Promise<{ address: string }>;
  connector(
    id: "google_mail" | "google_calendar" | "google_docs" | "google_contacts",
    sourceAccount: SourceAccountId,
    options: ConnectorOptions,
  ): PersonalConnector;
  // Present only for a label with a Drive grant. The address the Drive token belongs to
  // (`driveAbout`), which sync checks against the label's own before it lists.
  driveProfile?(): Promise<{ address: string }>;
  // Absent for a source that has none.
  sendAs?(): Promise<{ address: string; primary: boolean }[]>;
  // The ties backfill's reads of the label's mail. Absent for a source that has none.
  ties?(sourceAccount: SourceAccountId): TiesReader;
};

// What the writer hands deriveItem inside the item's transaction. `ownerAddresses` holds every
// owner address, from every connected account. `senderWrittenTo` says the owner has written to
// the item's sender from the item's account; absent is false.
export type ItemContext = {
  evidenceId: EvidenceId;
  revision: number;
  compartment: string;
  ownerAddresses: string[];
  ownerEntity: LocalEntityId;
  identity: IdentityResolver;
  senderWrittenTo?: boolean;
  // A page is derived only with one.
  page?: PageRequest;
  // The restricted categories turned on, from sync. Absent is none, as every category starts off.
  restrictedOn?: readonly RestrictedCategory[];
};

type PageRequest = { requestId: ResearchRequestId; about: EntityId | null; names: string[] };

// What the store keeps of one page: its canonical URL, its title as the shared parse reads it (null
// for a text/plain page or one the parse refuses), and its request's facts.
export type PageFacts = PageRequest & { url: PageUrl; title: string | null };

export type ItemMembers = { participantMembers: MemberId[]; senderMember?: MemberId };

export type Person = { address: string; name?: string };

// What the store keeps of one message for the message tools, bulk or not. `text` is null when
// the message has none; `unreadable` says its body could not be read as text; `held` says it
// matches the recovery markers, so no client is given it until the owner releases it.
// `restricted` holds the on categories the restricted term screen found in it, sorted: the writer
// stores the message under them.
// `messageId` and `references` are the message's own Message-ID and References, as the shared
// parse reads them: a sender's claims, kept for the stage that sends.
export type MessageFacts = {
  subject: string | null;
  at: Timestamp;
  sender?: Person;
  category: MessageCategory;
  text: string | null;
  unreadable: boolean;
  held: boolean;
  restricted: RestrictedCategory[];
  attachments: Attachment[];
  messageId?: string;
  references?: string[];
  // Whether it authenticates for its From domain (mail-auth.ts). The
  // derive always sets it; facts made without it are stored `unknown`.
  auth?: MailAuth;
};

// What reading an event returns. `revision` is the event's etag, else its updated, else null.
// `ownerResponse` is the owner's own attendee response.
export type EventFacts = {
  sourceId: string;
  revision: string | null;
  cancelled: boolean;
  title: string | null;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  ownerResponse?: "needsAction" | "declined" | "tentative" | "accepted";
  participants: { person: Person; role: "organizer" | "attendee"; owner: boolean }[];
  // The event's call link and calendar link as the whitelist kept them.
  callLink?: string;
  inviteLink?: string;
};

// The whitelist of a saved contact's fields, and its item's payload. `addresses` holds the first
// CONTACT_LIMITS.addresses of the addresses read strictly.
export type Contact = {
  resourceName: string;
  updated?: string;
  names: string[];
  nicknames: string[];
  addresses: string[];
  phones: { value: string; canonical?: string; type?: string }[];
  organizations: { name?: string; title?: string }[];
  birthday?: { month: number; day: number };
  // Its links, normalized; absent is none, so a contact with none keeps its payload.
  links?: PersonLink[];
  // An imported contact's further fields. A saved contact has none.
  imported?: ImportedExtras;
};

// What the store seals of a contact. `names` holds its names, then its nicknames.
export type ContactFacts = {
  sourceId: string;
  updatedAt: Timestamp;
  names: string[];
  phones: { value: string; canonical: string | null; type: string | null }[];
  organizations: { name: string | null; title: string | null }[];
  birthday: { month: number; day: number } | null;
  // Absent for a contact sealed before links were kept, or with none.
  links?: PersonLink[];
  imported?: ImportedExtras;
};

// One Drive file as the connector reads it, and the person on it. `root` is the root the
// file is admitted under: a folder id, `my-drive` or `shared-with-me`.
export type DrivePerson = { address?: string; name?: string };

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  createdTime: Timestamp;
  modifiedTime: Timestamp;
  parent?: string;
  root: string;
  ownedByMe: boolean;
  modifiedByMe: boolean;
  owner?: DrivePerson;
  sharer?: DrivePerson;
  canDownload: boolean;
};

// A Google Doc as it is read: headings, paragraphs, list items and table rows.
export type DocBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "item"; text: string }
  | { kind: "row"; cells: string[] };

export type DocBody = { blocks: DocBlock[] };

// What the store keeps of one document. `text` is null when it has none; a section's `start` and
// `end` are UTF-16 offsets into it; `held` says it matches the recovery markers.
export type DocumentFacts = {
  fileId: string;
  title: string;
  kind: DocumentKind;
  modifiedAt: Timestamp;
  createdAt: Timestamp;
  mine: boolean;
  editedByMe: boolean;
  owner?: DrivePerson;
  sharer?: DrivePerson;
  root: string;
  parent?: string;
  size?: number;
  text: string | null;
  sections: { heading: string; start: number; end: number }[];
  unreadable: DocumentUnreadable | null;
  held: boolean;
};

// One passage of a document's text, inside one section.
export type Passage = { span: string; section: number; heading: string };

// What the writer keeps of one item. "unread" is evidence kept with nothing derived. An email's
// subject is `message.subject`, and `message.at` equals `record.occurredAt`.
export type ItemFacts =
  | { kind: "email"; members: ItemMembers; bulk: true; message: MessageFacts }
  | {
      kind: "email";
      members: ItemMembers;
      bulk: false;
      message: MessageFacts;
      record: InteractionRecord;
      roles: { entity: LocalEntityId; role: "sender" | "recipient" }[];
      names: { entity: LocalEntityId; name: string }[];
      ownerNames?: string[];
    }
  | {
      kind: "event";
      members: ItemMembers;
      facts: EventFacts;
      record: InteractionRecord;
      participants: { entity: LocalEntityId; role: "organizer" | "participant" }[];
      names: { entity: LocalEntityId; name: string }[];
    }
  | {
      kind: "contact";
      members: ItemMembers;
      contact: ContactFacts;
      // The person each address resolved to, in the contact's order.
      people: { entity: LocalEntityId; address: string }[];
      // Empty unless the contact has exactly one address.
      names: { entity: LocalEntityId; name: string }[];
    }
  | { kind: "document"; members: ItemMembers; document: DocumentFacts }
  | { kind: "page"; members: ItemMembers; page: PageFacts }
  // An email whose subject and text were read but that derives nothing else carries what the
  // restricted screen found in them, so it is stored under its label too.
  | { kind: "unread"; members: ItemMembers; restricted?: RestrictedCategory[] };
