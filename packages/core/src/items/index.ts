// @intelligence/personal-core/items. Source items: the Google, contact, document, Lens-contact and agent-person item builders, their derivation into the facts the writer keeps, and the connector types.
export { membersOf, memoryItem, pipelineItemOf, UNSEALED } from "./adapter.ts";
export { agentPersonId, agentPersonItem, agentPersonKey, type ConfirmedPerson } from "./agent-people.ts";
export {
  calendarItem,
  gmailHeadersItem,
  gmailItem,
  gmailLink,
  isBareCancellation,
  isHeadersMail,
  TIES_HEADERS,
  whitelistedEvent,
} from "./builders.ts";
export {
  addressKind,
  derivingLabels,
  isConditional,
  isConditionalLabels,
  isDraft,
  isJunk,
  messageCategory,
  ownerSent,
  personalBulk,
} from "./bulk.ts";
export {
  CONTACT_CLAIMS_V1,
  CONTACT_CLAIMS_V2,
  CONTACT_CLAIMS_V3,
  CONTACT_CLAIMS_VERSION,
  type ContactClaimsVersion,
  contactClaims,
} from "./contact-claims.ts";
export { type ImportRead, importItem, readContacts } from "./contact-import.ts";
export {
  CONTACT_LIMITS,
  contactDeletion,
  contactItem,
  contactItemId,
  contactKept,
  REFUSED_MARKER,
  whitelistedContact,
} from "./contacts.ts";
export { deriveItem } from "./derive.ts";
export {
  DRIVE_READING,
  documentBlock,
  documentKind,
  documentLink,
  documentTooLong,
  driveItem,
  driveRevisionTag,
} from "./documents.ts";
export { isOwnerAddress, readEvent } from "./events.ts";
export { RECOVERY_MARKERS, recoveryHold } from "./hold.ts";
export { importClaimCounts, importClaims } from "./import-claims.ts";
export { macContactItem, macContactItemId } from "./mac-contacts.ts";
export { attendeeAddress, attendeeAddresses, meetingOwner } from "./meeting-owner.ts";
export { headersOnly } from "./message.ts";
export { isFullName } from "./names.ts";
export { passageOf, recordPassageOf } from "./passage.ts";
export { documentPassages, PASSAGE_CHARS } from "./passages.ts";
export { linkClaims, linkFactKey, personLink } from "./person-links.ts";
export { RESTRICTED_TERMS, restrictedCategories } from "./screen.ts";
export type {
  Attachment,
  CalendarEvent,
  CalendarPerson,
  CalendarTime,
  Connector,
  ConnectorOptions,
  DocBlock,
  DocBody,
  DocumentFacts,
  DriveFile,
  DrivePerson,
  EventFacts,
  GmailMessage,
  ItemContext,
  ItemFacts,
  ItemMembers,
  ListingMark,
  MessageFacts,
  PageFacts,
  Passage,
  Person,
  PersonalConnector,
  PersonalPage,
  PersonalSource,
  TiesPass,
  TiesReader,
} from "./types.ts";
