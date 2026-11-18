import type { ConnectorCursor, SourceAccountId } from "@intelligence/contracts";
import type { ListingMark } from "@intelligence/personal-core/items";

// What the writer's parts share, apart from `Writer` itself, which imports them all.
export type SourceAccountRow = {
  id: SourceAccountId;
  label: string;
  // `lens_contacts`: a device's Mac contacts, which the writer ingests in takeContacts.
  connector:
    | "google_mail"
    | "google_calendar"
    | "google_docs"
    | "google_contacts"
    | "contacts_import"
    | "agent_people"
    | "agent"
    | "web"
    | "lens_contacts";
  sourceKind: "email" | "calendar" | "document" | "crm" | "agent_record" | "web_research";
  compartment: string;
};

// `left` for a document whose root is no longer one of its label's roots; nothing is written.
// `no_tie`: a headers-depth message that is bulk or unread, of which nothing is kept.
export type IngestAnswer = "stored" | "repeat" | "unread" | "removed" | "suppressed" | "left" | "no_tie";

export type ListingPage = {
  listing?: ListingMark;
  listedIds: string[];
  skippedIds: string[];
  leftIds?: string[];
  next: ConnectorCursor;
};

export type ListingDone = { removed: number; reconciled: boolean; recordsRemoved: number; unreadable?: number };

// The accounts a connector syncs.
export type GoogleAccountRow = SourceAccountRow & {
  connector: "google_mail" | "google_calendar" | "google_docs" | "google_contacts";
  sourceKind: "email" | "calendar" | "document" | "crm";
};

// What one sync of one account listed and decided. `added` only for a source that lists additions
// (Gmail's history); `decided` counts every way the sync disposed of an item.
export type SyncCounts = {
  kind: "full" | "fast";
  added?: number;
  stored: number;
  held: number;
  junk: number;
  decided: number;
  removed: number;
};
