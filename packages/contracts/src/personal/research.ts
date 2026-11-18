import { z } from "zod";
import { ResearchTemplateId as SharedTemplateId } from "../ids.ts";
import { PublicIdentifier } from "../research.ts";
import { EntityId, Handle, MessageId, RequestId, ResearchRequestId } from "./ids.ts";
import { PersonalToolError } from "./tool-errors.ts";

// Public sources and the research lane. A request names a fixed template and public identifiers the
// store already holds, or a URL; never free text. No shape here has a key for a label, a
// compartment, a reader, a client, a destination or a grant: the database computes the label from
// the token, and the fetcher is told only what leaves.

// The shared id: a key of RESEARCH_TEMPLATES is checked where a request is filed.
export const ResearchTemplateId = SharedTemplateId;
export type ResearchTemplateId = z.infer<typeof ResearchTemplateId>;

type IdentifierKind = PublicIdentifier["kind"];
type Template = { readonly version: 1; readonly words: string; readonly kinds: readonly (readonly IdentifierKind[])[] };

const template = (words: string, kinds: IdentifierKind[][]): Template =>
  Object.freeze({ version: 1, words, kinds: Object.freeze(kinds.map((set) => Object.freeze(set))) });

// The fixed templates (provisional, Q7): each one's words, and the sets of identifier kinds it
// takes, one set per accepted combination.
export const RESEARCH_TEMPLATES = Object.freeze({
  person_role: template("current role and employer of this named person", [
    ["person_name", "organization_name"],
    ["person_name", "domain"],
  ]),
  person_profile: template("public professional profile of this named person", [
    ["person_name"],
    ["person_name", "organization_name"],
    ["person_name", "domain"],
  ]),
  organization_profile: template("what this organization does, where, and who leads it", [
    ["organization_name"],
    ["domain"],
  ]),
  organization_people: template("leadership and board of this organization", [["organization_name"], ["domain"]]),
  organization_filings: template("public filings of this organization", [["organization_name"]]),
});

const knownTemplate = (id: string): boolean => Object.hasOwn(RESEARCH_TEMPLATES, id);

// The identifiers' kinds are one of the template's combinations, in any order, each kind as
// often as the combination names it.
const sorted = (kinds: readonly string[]): string => [...kinds].sort().join(",");
const takes = (search: { template: string; identifiers: PublicIdentifier[] }): boolean => {
  const given = sorted(search.identifiers.map((one) => one.kind));
  return (
    RESEARCH_TEMPLATES[search.template as keyof typeof RESEARCH_TEMPLATES]?.kinds.some(
      (set) => sorted(set) === given,
    ) ?? false
  );
};

// Top-level domains of no public host. The shared PublicIdentifier's domain check refuses them; an
// address literal is checked for global unicast by the fetcher, when it connects.
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6 = /^\[[0-9a-f:.]+\]$/;
const publicHost = (host: string): boolean =>
  IPV4.test(host) || IPV6.test(host) || PublicIdentifier.safeParse({ kind: "domain", value: host }).success;

const MAX_URL = 2048;

// No white space, control or format character, and no backslash: what a URL parser would
// silently drop or turn into a slash. The canonical form is what the parser makes of the rest.
const plain = /^[^\s\p{C}\\]+$/u;

// An http or https URL of at most 2 048 characters, with no user part, its scheme's default
// port, and a public host name or an address literal. Parsed to its canonical form: the host
// lower case, the default port and the fragment dropped, the path as the parser leaves it.
export const PageUrl = z
  .string()
  .max(MAX_URL)
  .regex(plain)
  .transform((text, ctx) => {
    const url = URL.parse(text);
    if (
      url === null ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      !publicHost(url.hostname)
    ) {
      ctx.issues.push({ code: "custom", message: "not a page URL", input: text });
      return z.NEVER;
    }
    url.hash = "";
    return url.href;
  })
  .pipe(z.string().max(MAX_URL).brand<"PageUrl">());
export type PageUrl = z.infer<typeof PageUrl>;

// What a client files with request_research: a templated search about one stored person or
// organization, or a link that stands in a stored message. There is no url kind: a URL the
// owner types is theirs alone, filed with `pi fetch`. `requestId` makes a repeat answer the first.
export const ResearchArgs = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("search"),
      requestId: RequestId,
      template: ResearchTemplateId.refine(knownTemplate, { message: "not a research template" }),
      identifiers: z.array(PublicIdentifier).min(1).max(3),
      about: EntityId.or(Handle),
    })
    .refine(takes, { message: "not identifiers this template takes", path: ["identifiers"] }),
  z.strictObject({ kind: z.literal("link"), requestId: RequestId, message: MessageId.or(Handle), url: PageUrl }),
]);
export type ResearchArgs = z.infer<typeof ResearchArgs>;

// The only answer a filing gets: the new request's id. Never what it found.
export const ResearchAnswer = z.strictObject({ request: ResearchRequestId.or(Handle), state: z.literal("pending") });
export type ResearchAnswer = z.infer<typeof ResearchAnswer>;

// A filing's refusals, as the agent API's codes: a bad request is `invalid_request`,
// the code the agent API already answers for arguments that do not parse.
export const ResearchRefusal = PersonalToolError.extract([
  "invalid_request",
  "not_found",
  "not_permitted",
  "rate_limited",
]);
export type ResearchRefusal = z.infer<typeof ResearchRefusal>;

// A request's state: the latest of its events.
export const ResearchState = z.enum([
  "pending",
  "approved",
  "declined",
  "expired",
  "withdrawn",
  "running",
  "waiting",
  "done",
  "failed",
  "tainted",
]);
export type ResearchState = z.infer<typeof ResearchState>;

// The research gate's causes. Every check runs and every cause is returned.
export const ResearchGateCause = z.enum([
  "no_authority",
  "bad_form",
  "private_url",
  "origin",
  "vetoed",
  "erased",
  "sealed",
  "budget",
]);
export type ResearchGateCause = z.infer<typeof ResearchGateCause>;

// How one egress ended, as its fetch row records it. The first four are `pi research run`'s,
// from the store; `robots` and `bad_answer` are its too; the rest are the fetcher's.
export const FetchOutcome = z.enum([
  "stored",
  "repeat",
  "fresh",
  "expired",
  "redirect",
  "not_text",
  "too_large",
  "timeout",
  "refused_address",
  "robots",
  "http_4xx",
  "http_5xx",
  "gone",
  "no_provider",
  "search_failed",
  "bad_answer",
]);
export type FetchOutcome = z.infer<typeof FetchOutcome>;

// What the fetcher may answer: never a store's outcome or `pi`'s own.
const FetcherOutcome = FetchOutcome.exclude(["stored", "repeat", "fresh", "expired", "robots", "bad_answer"]);

const robotsUrl = PageUrl.refine(
  (url) => {
    const parsed = new URL(url);
    return parsed.pathname === "/robots.txt" && parsed.search === "";
  },
  { message: "not a robots.txt URL" },
);

// One line to the fetcher: a search's template words and values, or one URL to read. A robots
// request is `/robots.txt` on the page's scheme and host, built by `pi research run`.
export const FetcherRequest = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("search"),
    query: z.strictObject({
      words: z.string().min(1).max(200),
      values: z.array(z.string().min(1).max(120)).min(1).max(3),
    }),
  }),
  z.strictObject({ kind: z.literal("page"), url: PageUrl }),
  z.strictObject({ kind: z.literal("robots"), url: robotsUrl }),
]);
export type FetcherRequest = z.infer<typeof FetcherRequest>;

const MAX_PAGE = 1024 * 1024;
const MAX_ROBOTS = 64 * 1024;
const base64 = z
  .string()
  .max(Math.ceil(MAX_PAGE / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const robotsText = z
  .string()
  .refine((text) => new TextEncoder().encode(text).length <= MAX_ROBOTS, { message: "over 64 KiB" });
// A media type, its parameters dropped.
const mediaType = z
  .string()
  .max(127)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/);
// A body comes exactly when the fetcher read one, and then there is no outcome: `pi research
// run` decides what storing it was.
const bodyOrOutcome = (answer: { body: string | null; outcome: string | null }): boolean =>
  (answer.body === null) !== (answer.outcome === null);

// One line from the fetcher. Untrusted: `pi research run` checks that a page answer names a URL it
// asked for. A search answer's outcome is null when the provider answered.
export const FetcherAnswer = z.union([
  z
    .strictObject({ kind: z.literal("search"), urls: z.array(PageUrl).max(10), outcome: FetcherOutcome.nullable() })
    .refine((answer) => answer.outcome === null || answer.urls.length === 0, {
      message: "a failed search names no URL",
    }),
  z
    .strictObject({
      kind: z.literal("page"),
      url: PageUrl,
      status: z.number().int().min(100).max(599).nullable(),
      mediaType: mediaType.nullable(),
      body: base64.nullable(),
      outcome: FetcherOutcome.nullable(),
    })
    .refine(bodyOrOutcome, { message: "a body or an outcome" }),
  z
    .strictObject({
      kind: z.literal("robots"),
      url: robotsUrl,
      body: robotsText.nullable(),
      outcome: FetcherOutcome.nullable(),
    })
    .refine(bodyOrOutcome, { message: "a body or an outcome" }),
]);
export type FetcherAnswer = z.infer<typeof FetcherAnswer>;

// An owner decision of kind `research` answers one of these: a card's approve or decline, or
// `typed` for a request the owner filed themselves.
export const ResearchDecisionAnswer = z.enum(["approve", "decline", "typed"]);
export type ResearchDecisionAnswer = z.infer<typeof ResearchDecisionAnswer>;

// A `research` decision's details: `privateUrl` only when the owner fetched a private URL with `pi
// fetch --private-url`, which the gate reads.
export const ResearchDecisionDetails = z.strictObject({ privateUrl: z.literal(true).optional() });
export type ResearchDecisionDetails = z.infer<typeof ResearchDecisionDetails>;

const cap = z.number().int().nonnegative();

// `policy.research_settings`, the owner's caps (provisional, Q6) and their switch for client link
// requests (Q16).
export const ResearchSettings = z.strictObject({
  clientLinkRequests: z.boolean(),
  maxRequestsPerClientPerDay: cap,
  maxSearchesPerDay: cap,
  maxFetchesPerDay: cap,
  // A search answer holds at most 10 URLs.
  maxPagesPerRequest: cap.max(10),
  refetchAfterDays: cap,
  // A card's expiry, as NewCard's.
  cardExpiryDays: z.number().int().min(1).max(90),
});
export type ResearchSettings = z.infer<typeof ResearchSettings>;

// A `research_settings` decision's details: the settings it changed, at least one. A key given as
// undefined is no setting: it would be stored as nothing.
export const ResearchSettingsPatch = ResearchSettings.partial().refine(
  (patch) => Object.values(patch).some((value) => value !== undefined),
  { message: "no setting" },
);
export type ResearchSettingsPatch = z.infer<typeof ResearchSettingsPatch>;
