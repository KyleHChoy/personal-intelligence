import type { PublicIdentifier, Timestamp } from "@intelligence/contracts";
import {
  CodedError,
  type EntityId,
  type FetchOutcome,
  type Fill,
  type MessageId,
  type PageUrl,
  type RequestId,
  type ResearchGateCause,
  type ResearchRequestId,
  ResearchSettings,
  type ResearchState,
  type ResearchTemplateId,
} from "@intelligence/contracts/personal";
import { normalizeAddress, organizationOfDomain, profileKey } from "@intelligence/personal-core";
import { canonicalUrl } from "@intelligence/personal-core/research";
import { fingerprint } from "./fingerprint.ts";
import type { Keys } from "./keys.ts";

// The research lane's shapes and pure helpers, shared by the owner's commands
// (admin-research.ts) and the reader's filing (read-research.ts). The run's side, `pi research
// run`, is designed and not built. Nothing here logs a URL, a query, a value or a page's text.

// A request's body, opened. A `url` request is the owner's alone; `names` are those the owner typed
// with `--name`.
export type ResearchBody =
  | { kind: "search"; template: ResearchTemplateId; identifiers: PublicIdentifier[]; about: EntityId }
  | { kind: "link"; message: MessageId; url: PageUrl }
  | { kind: "url"; url: PageUrl; about: EntityId | null; names: string[]; privateUrl: boolean };

// What the owner files as a fetch or a research request.
export type OwnerResearchArgs = { requestId: RequestId } & ResearchBody;

// A request as the owner's list prints it: ids, kinds, states, times and causes. `show` adds
// the opened body, for a terminal only.
export type ResearchRow = {
  id: ResearchRequestId;
  kind: ResearchBody["kind"];
  state: ResearchState;
  createdAt: Timestamp;
  causes: ResearchGateCause[];
};

// The owner's research status: counts only, no content.
export type ResearchStatusView = {
  requests: Partial<Record<ResearchState, number>>;
  searchesToday: number;
  fetchesToday: number;
  outcomes: Partial<Record<FetchOutcome, number>>;
  pages: number;
};

// A request's closed fields, one per line, for its keyed `research_query` fingerprint: a repeat
// of a filing is known by it, and nothing of it is in clear.
export function queryText(body: ResearchBody): string {
  switch (body.kind) {
    case "search":
      return ["search", body.template, body.about, ...body.identifiers.map((one) => `${one.kind}:${one.value}`)].join(
        "\n",
      );
    case "link":
      return ["link", body.message, body.url].join("\n");
    case "url":
      return ["url", body.url, body.about ?? "", ...body.names].join("\n");
  }
}

// Where a URL may end in running text: white space, and the marks mail puts around a link.
const AROUND = /[\s<>"'()[\]{}]+/;

export const urlInText = (text: string, url: string): boolean =>
  text.includes(url) || text.split(AROUND).some((word) => word.startsWith("http") && canonicalUrl(word) === url);

export const REQUEST_BODY = (id: string) => ({ table: "ledger.research_requests", id, column: "body_enc" });

export const RESEARCH_SETTINGS = `select client_link_requests, max_requests_per_client_per_day, max_searches_per_day, max_fetches_per_day,
  max_pages_per_request, refetch_after_days, card_expiry_days from policy.research_settings`;

export type SettingsRow = {
  client_link_requests: boolean;
  max_requests_per_client_per_day: number;
  max_searches_per_day: number;
  max_fetches_per_day: number;
  max_pages_per_request: number;
  refetch_after_days: number;
  card_expiry_days: number;
};

export const settingsOf = (row: SettingsRow | undefined): ResearchSettings => {
  if (row === undefined) throw new CodedError("not_found");
  return ResearchSettings.parse({
    clientLinkRequests: row.client_link_requests,
    maxRequestsPerClientPerDay: row.max_requests_per_client_per_day,
    maxSearchesPerDay: row.max_searches_per_day,
    maxFetchesPerDay: row.max_fetches_per_day,
    maxPagesPerRequest: row.max_pages_per_request,
    refetchAfterDays: row.refetch_after_days,
    cardExpiryDays: row.card_expiry_days,
  });
};

// The identifier a fill names, as the identity port keys it, or null.
export function fillIdentity(fill: Fill): string | null {
  const identity = fill.identity;
  if (identity === undefined) return null;
  if (identity.email !== undefined) return normalizeAddress(identity.email);
  return identity.linkedin === undefined ? null : profileKey(identity.linkedin);
}

// The registrable domain a fill names for an organization node, or null (a provider's domain, a
// public suffix, a malformed one).
export function fillDomain(fill: Fill): string | null {
  const domain = fill.domain?.domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return domain === undefined || domain === "" ? null : organizationOfDomain(domain);
}

export const identityFp = (keys: Keys, identity: string): string => fingerprint(keys, "address", identity);
export const domainFp = (keys: Keys, domain: string): string => fingerprint(keys, "domain", domain);
