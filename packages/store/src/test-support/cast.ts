// The cast, every address on a reserved domain, and their source accounts.

import type { Writer } from "../write/writer.ts";
import type { SourceAccountRow } from "../write/writer-types.ts";

// ---------------------------------------------------------------------------------------------
// The cast. Every address is on a reserved domain; every name is made up.
// ---------------------------------------------------------------------------------------------

// What must never be found in plaintext in any column.
export const CANARIES = {
  ownerAddress: "odalys.owner-canary@hearth-canary.test",
  ownerName: "Odalys Quillfeather-Canary",
  address: "zephyrine.canary@harbor-canary.test",
  name: "Zephyrine Saltmarsh-Canary",
  domain: "harbor-canary.test",
  subject: "Canary subject: the heron ledger for Thursday",
  eventTitle: "Canary title: heron ledger walkthrough",
  messageId: "canary-message-5c1e@harbor-canary.test",
  gmailId: "gmcanary5c1e77aa",
  threadId: "thread-canary-5c1e",
  eventId: "evcanary7781xq",
  cursor: "canary-cursor-history-918273",
  secret: "canary-refresh-token-1//0gQx-heron",
  // What a message says, and what an attachment is called.
  bodyText: "Canary body: the heron ledger is under the third lamp, bring the brass key on Thursday.",
  attachmentName: "canary-heron-ledger-thursday.pdf",
} as const;

export type Who = { address: string; name?: string };

export const OWNER = {
  name: CANARIES.ownerName,
  personal: CANARIES.ownerAddress,
  work: "odalys.owner@employer-example.test",
  // Neither account's own address: seen only as the From of a SENT message.
  alias: "o.sidedoor@alias-one.test",
  bulkAlias: "o.bulletin@alias-two.test",
} as const;

export const OWNER_PERSONAL: Who = { address: OWNER.personal, name: OWNER.name };
export const OWNER_WORK: Who = { address: OWNER.work, name: OWNER.name };

export const CANARY_PERSON: Who = { address: CANARIES.address, name: CANARIES.name };
export const QUENTIN: Who = { address: "quentin@lighthouse.test", name: "Quentin Lampwick" };
// On Quentin's domain: a second person of one organization.
export const RHEA: Who = { address: "rhea@lighthouse.test", name: "Rhea Lampwick" };
// Seen in one message and nowhere else.
export const SOLO: Who = { address: "solo@one-message.test", name: "Solo Onemessage" };
// Seen in one event and nowhere else.
export const GUEST: Who = { address: "guest@one-event.test", name: "Guest Oneevent" };
// Seen under the employer's account only.
export const WORK_ONLY: Who = { address: "wren@partner-example.test", name: "Wren Partnerfield" };
// A person at first; the re-derive tests make this address the owner's.
export const LATER_OWNER: Who = { address: "odalys.second@second-home.test", name: "Odalys Secondhome" };

// ---------------------------------------------------------------------------------------------
// Source accounts
// ---------------------------------------------------------------------------------------------

export type Accounts = {
  personalMail: SourceAccountRow;
  personalCalendar: SourceAccountRow;
  workMail: SourceAccountRow;
  workCalendar: SourceAccountRow;
};

// The owner's two labels, each with mail and a calendar: `personal` under `own`, `work` under
// `employer:example`.
export async function connect(writer: Writer): Promise<Accounts> {
  return {
    personalMail: await writer.ensureSourceAccount("personal", "google_mail", "own", OWNER.personal),
    personalCalendar: await writer.ensureSourceAccount("personal", "google_calendar", "own", OWNER.personal),
    workMail: await writer.ensureSourceAccount("work", "google_mail", "employer:example", OWNER.work),
    workCalendar: await writer.ensureSourceAccount("work", "google_calendar", "employer:example", OWNER.work),
  };
}
