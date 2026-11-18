// Where a served fact came from (FactSource), from the ids and capture columns its row already
// carries and its record's origin. Code decides it; nothing a model wrote reaches it.

import type { FactSource } from "@intelligence/contracts/personal";

export type SourceRow = {
  message_id: string | null;
  document_id: string | null;
  page_id?: string | null;
  capture_id?: string | null;
  // The capture row's kind and source, as the token returns them; absent where a statement reads none.
  capture_kind?: string | null;
  capture_source?: string | null;
  record_id?: string | null;
  contact?: boolean;
  // A compiled read's flags, for a row it serves with no document or page id.
  document?: boolean;
  from_page?: boolean;
};

export const AGENT_ORIGINS: ReadonlySet<string> = new Set(["agent_record", "agent_close", "agent_research"]);

export function factSourceOf(row: SourceRow, origin: string): FactSource {
  if (row.document_id !== null || row.document === true) return "document";
  if (row.message_id !== null) return "mail";
  if ((row.page_id ?? null) !== null || row.from_page === true) return "web";
  if ((row.capture_id ?? null) !== null) {
    // A capture whose kind the statement did not read is named by no kind.
    if (row.capture_kind === "meeting") return "meeting";
    if ((row.capture_kind ?? null) === null) return "other";
    return (row.capture_source ?? null) !== null ? "messages" : "screen";
  }
  if ((row.record_id ?? null) !== null || AGENT_ORIGINS.has(origin)) return "agent";
  if (row.contact === true) return "contacts";
  if (origin === "owner_command") return "owner";
  return "other";
}

// The same kinds for the admin's reads, which see every evidence row: a SQL expression over a
// claim `c`, its message `m`, its document `d` and its capture `k`, falling back to the evidence's
// connector for a claim with none of them (a calendar event's, a contact's, an owner command's).
export const ADMIN_FACT_SOURCE = `
  case
    when d.id is not null then 'document'
    when m.id is not null then 'mail'
    when exists (select 1 from knowledge.pages g where g.evidence_id = c.evidence_id) then 'web'
    when k.kind = 'meeting' then 'meeting'
    when k.id is not null and k.source is not null then 'messages'
    when k.id is not null then 'screen'
    when exists (select 1 from ledger.agent_writes w where w.evidence_id = c.evidence_id) then 'agent'
    else coalesce((
      select case a.connector
        when 'owner_command' then 'owner'
        when 'google_calendar' then 'calendar'
        when 'google_contacts' then 'contacts'
        when 'contacts_import' then 'contacts'
        when 'lens_contacts' then 'contacts'
        when 'agent' then 'agent'
        when 'agent_people' then 'agent'
        when 'web' then 'web'
        when 'google_mail' then 'mail'
        when 'google_docs' then 'document'
        when 'lens_meetings' then 'meeting'
        when 'lens_activity' then 'screen'
        when 'lens_blocks' then 'screen'
      end
      from vault.evidence_items e2 join vault.source_accounts a on a.id = e2.source_account_id
      where e2.id = c.evidence_id), 'other')
  end`;
