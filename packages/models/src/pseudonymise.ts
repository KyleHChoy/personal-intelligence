import { createHmac } from "node:crypto";

// Names, addresses, phone numbers and handles become stable tokens in the text a request sends,
// and the tokens become the originals again in the text its answer returns. It works on the raw
// body text, whatever the vendor's shape, so the prompt's data, a tool result's { untrusted }
// value and the instructions are all treated alike.
//
// A token is a keyed HMAC of the value's normal form: the same value gives the same token in every
// call and every run under one key, and a vendor that sees tokens cannot test a guessed name
// without the key. The map back to the originals lives only in this object, in memory, and nothing
// here logs.

export type KnownIdentities = {
  names?: readonly string[];
  addresses?: readonly string[];
  phones?: readonly string[];
  handles?: readonly string[];
};

export type Pseudonymiser = {
  // The text with every known or found identity replaced by its token.
  outgoing(text: string): Promise<string>;
  // The text with every token this pseudonymiser handed out replaced by its original.
  incoming(text: string): string;
};

type Kind = "Person" | "Email" | "Phone" | "Handle";

const EMAIL_DOMAIN = "@pseudonym.invalid";
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A phone number written with a country code or with separators. A bare run of digits is an id,
// an amount or a time far more often than a phone, and a date is never one.
const PHONE = /(?<![\w+.-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{2,4}(?:[ .-]\d{2,4}){1,3}(?![\w-])/g;
const DATE = /\d{4}-\d{2}-\d{2}/;
// A display name before an address, as a header writes one (`Mira Okafor <mira@example.com>`), raw
// or escaped as a data block writes it, and with or without quotes around the name.
const DISPLAY_NAME =
  /(\p{Lu}[\p{L}'.-]*(?: \p{Lu}[\p{L}'.-]*){0,3})(?:\\*")? (?:<|&lt;)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:>|&gt;)/gu;
const TOKEN =
  /\b(?:Person|Phone|Handle)_[0-9a-f]{8}(?:[0-9a-f]{8})?\b|\bEmail_[0-9a-f]{8}(?:[0-9a-f]{8})?@pseudonym\.invalid\b/gi;
// A value that a JSON body or a data block would escape is left as it is: it could not be found
// in the body as written, and its original could not be put back into JSON text unescaped.
const UNSAFE = /["\\<>&\p{Cc}]/u;
const NOT_WORD = "(?<![\\p{L}\\p{N}_@.+-])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}_@-])";

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const collapsed = (value: string): string => value.normalize("NFC").replace(/\s+/g, " ").trim();
const normalOf = (kind: Kind, value: string): string => {
  const plain = collapsed(value).toLowerCase();
  if (kind === "Phone") return plain.replace(/[^\d]/g, "");
  if (kind === "Handle") return plain.replace(/^@/, "");
  return plain;
};

// `key` and `known` are read once, at the first request, so a caller may hand over a read of its
// store that runs only when a call is made.
export function createPseudonymiser(options: {
  key: () => Promise<Uint8Array>;
  known?: KnownIdentities | (() => Promise<KnownIdentities>);
}): Pseudonymiser {
  let loaded: Promise<[Uint8Array, KnownIdentities]> | undefined;
  // The pattern of every literal, made again only when a display name is learned.
  let made: { size: number; values: Map<string, Kind>; pattern: RegExp | null } | undefined;
  // Token, lower case, to its normal form and the value as first written.
  const issued = new Map<string, { normal: string; original: string }>();
  // Display names found in earlier requests, kept so a later request that names the person without
  // an address is covered too.
  const learned = new Set<string>();

  const tokenOf = (secret: Uint8Array, kind: Kind, original: string): string => {
    const normal = `${kind}:${normalOf(kind, original)}`;
    const hex = createHmac("sha256", secret).update(normal, "utf8").digest("hex");
    for (const width of [8, 16]) {
      const id = `${kind}_${hex.slice(0, width)}`;
      const token = kind === "Email" ? `${id}${EMAIL_DOMAIN}` : id;
      const held = issued.get(token.toLowerCase());
      if (held === undefined) issued.set(token.toLowerCase(), { normal, original });
      if (held === undefined || held.normal === normal) return token;
    }
    // Two values that share 64 bits of their HMAC: the second keeps its own text.
    return original;
  };

  const literals = (known: KnownIdentities): NonNullable<typeof made> => {
    if (made !== undefined && made.size === learned.size) return made;
    const all = new Map<string, Kind>();
    const add = (kind: Kind, values: Iterable<string>) => {
      for (const value of values) {
        const text = collapsed(value);
        if (text.length >= 2 && !UNSAFE.test(text) && !all.has(text.toLowerCase())) all.set(text.toLowerCase(), kind);
      }
    };
    add("Email", known.addresses ?? []);
    add("Phone", known.phones ?? []);
    add("Handle", known.handles ?? []);
    add("Person", [...(known.names ?? []), ...learned]);
    const alternatives = [...all.keys()].sort((a, b) => b.length - a.length).map(escaped);
    const pattern =
      all.size === 0 ? null : new RegExp(`${NOT_WORD}(?:${alternatives.join("|")})${NOT_WORD_AFTER}`, "giu");
    made = { size: learned.size, values: all, pattern };
    return made;
  };

  return {
    async outgoing(text) {
      const known = options.known;
      loaded ??= Promise.all([options.key(), typeof known === "function" ? known() : Promise.resolve(known ?? {})]);
      const [secret, identities] = await loaded;
      for (const match of text.matchAll(DISPLAY_NAME)) learned.add(collapsed(match[1] as string));
      const { values, pattern } = literals(identities);
      let out = text;
      if (pattern !== null) {
        out = out.replace(pattern, (found) => {
          const kind = values.get(collapsed(found).toLowerCase());
          if (kind === undefined) return found;
          // A one-word name counts only with its capital: "Will" may be a name, "will" is not.
          const lower = found[0] !== found[0]?.toUpperCase();
          if (kind === "Person" && !/\s/.test(found) && lower) return found;
          return tokenOf(secret, kind, found);
        });
      }
      out = out.replace(EMAIL, (found) =>
        found.toLowerCase().endsWith(EMAIL_DOMAIN) ? found : tokenOf(secret, "Email", found),
      );
      return out.replace(PHONE, (found) => {
        const digits = found.replace(/\D/g, "").length;
        const enough = found.startsWith("+") ? digits >= 8 && digits <= 15 : digits >= 10 && digits <= 15;
        return enough && !DATE.test(found) ? tokenOf(secret, "Phone", found) : found;
      });
    },
    incoming(text) {
      return text.replace(TOKEN, (found) => issued.get(found.toLowerCase())?.original ?? found);
    },
  };
}
