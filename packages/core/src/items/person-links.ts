import { ClaimRecord, IMPORT_LIMITS, type LinkKind, type PersonLink } from "@intelligence/contracts/personal";
import { sha256 } from "../hash.ts";
import { profileKey } from "../profile-key.ts";
import { codePoints } from "../units.ts";

// A link on a person, read by code from a contact or an import, and the `link`
// claims made from a contact's links. A link is never fetched, followed or opened by anything:
// it is a value, served as untrusted, use-only as a contact's details are. Pure.

// The kind a host gives, the host itself or any subdomain of it. Every other host is `other`; a
// look-alike (`linkedin.com.example.test`, `evil-github.com`) matches none of these.
const HOSTS: readonly (readonly [string, LinkKind])[] = [
  ["linkedin.com", "linkedin"],
  ["x.com", "x"],
  ["twitter.com", "x"],
  ["github.com", "github"],
];

// A host of letters, digits and hyphens in two or more labels, the last of letters: no IP
// literal, no single label such as localhost. An internationalized label (`xn--`) is refused, the
// form a look-alike of a known host takes. No host of a name space that is never public
// (`.localhost`, `.local`, `.internal`, `.lan`, `.corp`, `.home`, `.intranet`, `.private`,
// `.home.arpa`).
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const plainHost = (host: string): boolean => {
  const labels = host.split(".");
  const last = labels.at(-1) ?? "";
  if (PRIVATE_TLDS.has(last) || host.endsWith(".home.arpa")) return false;
  return (
    labels.length >= 2 &&
    labels.every((label) => LABEL.test(label) && !label.startsWith("xn--")) &&
    /^[a-z]{2,63}$/.test(last)
  );
};
// A scheme: a name and a colon not followed by a digit, so `janedoe.com:8080/x` is a host with a
// port, and `javascript:`, `data:` and `mailto:` are schemes.
const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;
const PRIVATE_TLDS: ReadonlySet<string> = new Set([
  "localhost",
  "local",
  "internal",
  "lan",
  "corp",
  "home",
  "intranet",
  "private",
]);

export const hostKind = (host: string): LinkKind =>
  HOSTS.find(([known]) => host === known || host.endsWith(`.${known}`))?.[1] ?? "other";

// One link in its normal form, or null. Only http and https, read as https; no user or password;
// the host in lower case; no query, fragment or trailing slash; a LinkedIn profile as
// https://linkedin.com/in/<slug> (the profile key's form). A value with no scheme
// is read as https. At most IMPORT_LIMITS.url code points. `kind` is the caller's, else the host's;
// a label is kept when it is one to IMPORT_LIMITS.text code points.
export function personLink(value: string, options: { kind?: LinkKind; label?: string } = {}): PersonLink | null {
  const text = value.normalize("NFC").trim();
  if (text === "" || codePoints(text) > IMPORT_LIMITS.url) return null;
  const http = /^https?:\/\//i.test(text);
  if (!http && SCHEME.test(text)) return null;
  let url: URL;
  try {
    url = new URL(http ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    !plainHost(url.hostname)
  )
    return null;
  const host = url.hostname;
  const derived = hostKind(host);
  // The parsed URL, its scheme in lower case, so `HTTPS://` folds too.
  const profile = derived === "linkedin" ? profileKey(url.href) : null;
  const path = url.pathname.replace(/\/+$/, "");
  const normal =
    profile === null
      ? `https://${host}${url.port === "" ? "" : `:${url.port}`}${path}`
      : `https://${profile.slice("profile:".length)}`;
  if (codePoints(normal) > IMPORT_LIMITS.url) return null;
  const label = options.label?.trim();
  const keptLabel = label !== undefined && label !== "" && codePoints(label) <= IMPORT_LIMITS.text ? label : undefined;
  return { url: normal, kind: options.kind ?? derived, ...(keptLabel === undefined ? {} : { label: keptLabel }) };
}

// Each URL once, the first link that gave it kept, at most `max`.
export function uniqueLinks(links: readonly (PersonLink | null)[], max: number): PersonLink[] {
  const seen = new Set<string>();
  const out: PersonLink[] = [];
  for (const link of links) {
    if (link === null || seen.has(link.url)) continue;
    seen.add(link.url);
    out.push(link);
  }
  return out.slice(0, max);
}

// One step of a fact key's chain, as extract's personalFactKey takes it.
export const extend = (key: string, part: string): string => sha256(`${key}\n${part}`);

// `personalFactKey` of a link (the extract package's, held equal by its test): the shared key over
// type and subject (a link has no typed field it keys by: its kind and label are values), then
// `url:` and its normal form, then `compartment:` and the sorted compartments. So one URL on one
// person is one fact whatever its kind or label, and two mailboxes never mix.
export function linkFactKey(subject: string, url: string, compartments: readonly string[]): string {
  const key = sha256(`{"context":{"kind":"global"},"fields":{},"subject":${JSON.stringify(subject)},"type":"link"}`);
  return extend(extend(key, `url:${url}`), `compartment:${[...compartments].sort().join(",")}`);
}

export type LinkClaimsInput = {
  evidenceId: string;
  compartments: readonly string[];
  readers: readonly string[];
  observedAt: string;
  links: readonly PersonLink[];
  people: readonly { entity: string }[];
  // An imported row's confidence and standing, carried on each claim.
  confidence?: number;
  standing?: "verified" | "probable";
};

// A contact's links as `link` claims about each person its identifiers named, made by `version`
// (the contact's or the import's claims version): a third party's statement in a source the owner
// holds, origin `source`, basis and disclosure `third_party` (use-only), under the contact's
// evidence label. The ids are fixed by the revision, so writing them again is a no-op.
export function linkClaims(input: LinkClaimsInput, version: string): ClaimRecord[] {
  const subjects = [...new Set(input.people.map((one) => one.entity))];
  return subjects.flatMap((subject) =>
    input.links.map((link, index) => {
      const fields: Record<string, string> = {
        url: link.url,
        kind: link.kind,
        ...(link.label === undefined ? {} : { label: link.label }),
      };
      return ClaimRecord.parse({
        claim: {
          id: sha256(`${version}\n${input.evidenceId}\n${subject}\nlinks/${index}\nlink`),
          content: { type: "link", subject, fields },
          statementKind: "stated_fact",
          basis: "third_party",
          validFrom: input.observedAt,
          evidence: [{ evidenceId: input.evidenceId, span: `links/${index}` }],
          primaryEvidenceId: input.evidenceId,
          label: { compartments: [...input.compartments], readers: [...input.readers] },
          destination: "personal",
          pipelineVersion: version,
          extractorGeneration: 0,
          changeKind: "live",
          systemOriginated: false,
          origin: "source",
          identityEpoch: 0,
        },
        subjectKind: "person",
        disclosure: ["third_party"],
        factKey: linkFactKey(subject, link.url, input.compartments),
        lane: "correspondence",
        fieldKinds: Object.fromEntries(Object.keys(fields).map((field) => [field, field === "kind" ? "enum" : "text"])),
        entities: [subject],
        origin: "source",
        answersSystem: false,
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
        ...(input.standing === undefined ? {} : { standing: input.standing }),
      });
    }),
  );
}
