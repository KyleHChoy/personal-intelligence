import { z } from "zod";
import { ChangeKind, ReferenceFacts, ReferenceKind, SourceKind } from "./evidence.ts";
import { Compartment, SourceAccountId, Timestamp, Vault } from "./ids.ts";

// In this build connectors run against fixtures only.
const ConnectorId = z.enum([
  "google_mail",
  "microsoft_mail",
  "google_calendar",
  "google_contacts",
  "microsoft_calendar",
  "slack_chat",
  "crm_attio",
  "crm_affinity",
  "notion",
  "google_docs",
  "edgar_filings",
  "public_data",
  "directory",
]);
type ConnectorId = z.infer<typeof ConnectorId>;

// An account with no access list is never suspended.
const AccessSyncKind = z.enum(["access_list", "none"]);
type AccessSyncKind = z.infer<typeof AccessSyncKind>;

export const SourceAccount = z.object({
  id: SourceAccountId,
  // Absent for an account no connector reads, such as the one for workbench corrections.
  connector: ConnectorId.optional(),
  sourceKind: SourceKind,
  vault: Vault,
  externalRef: z.string().min(1),
  accessSyncKind: AccessSyncKind,
  // The account's own compartments, beside its source compartment.
  compartments: z.array(Compartment),
  // Maps a folder or label marker to a compartment, such as a deal.
  markerCompartments: z.array(z.object({ marker: z.string().min(1), compartment: Compartment })),
  // Set for an account whose items are reference documents of one kind. The evidence writer
  // compares an item's reference kind with it.
  referenceKind: ReferenceKind.optional(),
});
export type SourceAccount = z.infer<typeof SourceAccount>;

// One source's read-only credential. Held in memory only.
export const SourceCredential = z.object({
  connector: ConnectorId,
  sourceAccount: SourceAccountId,
  scopes: z.array(z.string()),
  secret: z.string().min(1),
});
export type SourceCredential = z.infer<typeof SourceCredential>;

// Opaque. A connector never advances its own cursor.
export const ConnectorCursor = z.string().min(1).brand<"ConnectorCursor">();
export type ConnectorCursor = z.infer<typeof ConnectorCursor>;

// Who could see an item at the source. Source identifiers, never member ids.
const SourcePermissions = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("organization") }),
  z.strictObject({ scope: z.literal("listed"), identifiers: z.array(z.string()) }),
]);
type SourcePermissions = z.infer<typeof SourcePermissions>;

const rawItemFields = z.strictObject({
  sourceKind: SourceKind,
  sourceAccount: SourceAccountId,
  sourceItemId: z.string().min(1),
  revisionTag: z.string().min(1),
  threadId: z.string().min(1).optional(),
  observedAt: Timestamp,
  depth: z.enum(["headers", "full"]),
  changeKind: ChangeKind,
  // The bytes exactly as the source gave them, as base64.
  payload: z.base64(),
  // The format of those bytes, as a media type: "message/rfc822" for a raw message,
  // "text/html", "application/pdf". The parser reads it and never guesses.
  mediaType: z.string().regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/),
  permissions: SourcePermissions,
  // The source identifier that sent the item, where the source marks one. Ingest resolves this
  // one identifier to a member and records it as the evidence item's senderMember.
  sender: z.string().min(1).optional(),
  // The identifiers a message was sent to (To, Cc and Bcc), in source order. Absent for a
  // source with no addressees, such as a channel or a document. Ingest resolves them to the
  // evidence item's participantMembers, so a message in a shared mailbox narrows to the members
  // it was addressed to, not to everyone who can open the mailbox.
  addressees: z.array(z.string().min(1)).max(1000).optional(),
  // Folder and label names, for the screen's rules and for compartments.
  markers: z.array(z.string()),
  referenceKind: ReferenceKind.optional(),
  // What the source system says of a reference document, read from its own fields and never
  // from the document's text.
  reference: ReferenceFacts.optional(),
});

// What a connector hands to ingest. No label, no reader, no member id. Reference facts go
// only on a reference document, and only a policy is enforced.
export const RawItem = rawItemFields
  .refine((item) => item.reference === undefined || item.referenceKind !== undefined, {
    message: "reference facts on an item that is no reference document",
    path: ["reference"],
  })
  .refine((item) => item.reference?.enforced !== true || item.referenceKind === "policy", {
    message: "only a policy is enforced",
    path: ["reference", "enforced"],
  })
  // Whoever sent an item could see it, so a sender is one of the listed identifiers.
  .refine(
    (item) =>
      item.sender === undefined ||
      item.permissions.scope !== "listed" ||
      item.permissions.identifiers.includes(item.sender),
    {
      message: "a sender that is not one of the item's identifiers",
      path: ["sender"],
    },
  )
  // Whoever a message was sent to could see it, so each addressee is one of the listed identifiers.
  .refine(
    (item) => {
      const { permissions } = item;
      return (
        item.addressees === undefined ||
        permissions.scope !== "listed" ||
        item.addressees.every((to) => permissions.identifiers.includes(to))
      );
    },
    { message: "an addressee that is not one of the item's identifiers", path: ["addressees"] },
  );
export type RawItem = z.infer<typeof RawItem>;

export const SourceDeletion = z.object({
  sourceAccount: SourceAccountId,
  sourceItemId: z.string().min(1),
  deletedAt: Timestamp,
});
export type SourceDeletion = z.infer<typeof SourceDeletion>;

// An item the source would not let the connector read. Never silently omitted.
export const SkippedItem = z.object({
  sourceItemId: z.string().min(1),
  reason: z.enum(["forbidden", "too_large", "unsupported", "direct_message", "no_consent", "off_allowlist"]),
});
export type SkippedItem = z.infer<typeof SkippedItem>;

export const ConnectorPage = z.object({
  items: z.array(RawItem),
  deletions: z.array(SourceDeletion),
  skipped: z.array(SkippedItem),
  next: ConnectorCursor,
});
export type ConnectorPage = z.infer<typeof ConnectorPage>;

// A sharing change. It touches no content.
const AccessListChange = z.object({
  sourceAccount: SourceAccountId,
  sourceItemId: z.string().min(1),
  permissions: SourcePermissions,
  changedAt: Timestamp,
});
type AccessListChange = z.infer<typeof AccessListChange>;

export const AccessListPage = z.object({ changes: z.array(AccessListChange), next: ConnectorCursor });
export type AccessListPage = z.infer<typeof AccessListPage>;
