import { z } from "zod";

// The research app: what a run may ask it, what it answers, and what it hands to ingest. A
// request names a fixed template and public identifiers, never free text or a member.

// Each value is checked by a pattern for its kind, at most 120 characters. A domain is lower-case
// labels joined by dots. A name is words of letters, with digits for an organization, and a few
// marks inside words, joined by single spaces. None holds a control character, a slash, an at
// sign or a newline, and none ends in a space.
const domain = /^(?=.{1,120}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// No word of an organization name is a search operator: no OR or AND, no leading minus, and no
// ampersand, question mark or equals sign.
const organizationName =
  /^(?=.{1,120}$)(?!(?:.* )?(?:OR|AND)(?: |$))[\p{L}\p{N}][\p{L}\p{M}\p{N}.,'-]*(?: [\p{L}\p{N}][\p{L}\p{M}\p{N}.,'-]*)*$/u;
const personName = /^(?=.{1,120}$)\p{L}(?:[\p{L}\p{M}.'-]| (?! ))*(?<! )$/u;

// Top-level domains that name no public host. "example" stays: the synthetic world uses it.
const reservedTopLevel = new Set([
  "internal",
  "local",
  "localhost",
  "localdomain",
  "arpa",
  "onion",
  "invalid",
  "test",
  "lan",
  "home",
  "corp",
  "intranet",
]);

// A public host name: no reserved top-level domain, no all-numeric label, and no label shaped
// like an address with dashes, so neither 127.0.0.1.nip.io nor 127-0-0-1.nip.io parses. The
// research app still checks the address a host resolves to when it fetches.
const isPublicDomain = (value: string): boolean => {
  const labels = value.split(".");
  return (
    !reservedTopLevel.has(labels.at(-1) ?? "") &&
    !labels.some((label) => /^\d+$/.test(label) || /^\d{1,3}(?:-\d{1,3}){3}$/.test(label))
  );
};

export const PublicIdentifier = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("domain"),
    value: z.string().regex(domain).refine(isPublicDomain, { message: "not a public host name" }),
  }),
  z.strictObject({ kind: z.literal("organization_name"), value: z.string().regex(organizationName) }),
  z.strictObject({ kind: z.literal("person_name"), value: z.string().regex(personName) }),
]);
export type PublicIdentifier = z.infer<typeof PublicIdentifier>;
