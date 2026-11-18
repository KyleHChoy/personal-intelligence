import { canonicalTimeZone, E164_PHONE } from "@intelligence/contracts/personal";

// Contact import: a LinkedIn profile URL is the identity key of an imported row that has no
// address. Its key is `profile:linkedin.com/in/<slug>`: the URL NFC-normalized before it is read,
// the host folded to linkedin.com (www and a country subdomain alike), the slug in lower case, no
// query, fragment, trailing slash or sub-page. It is carried, stored and fingerprinted as an
// address is, and never as plaintext in an id or a log. Any other URL is no key.

const PROFILE_KEY_PREFIX = "profile:";

// The exact shape: every reader that trusts the prefix checks this instead.
const PROFILE_KEY = /^profile:linkedin\.com\/in\/[^@/\s]+$/u;
// The key of a person the owner confirmed from an agent's proposal that named no
// address and no LinkedIn profile, `profile:proposal/<64 hex>`, a keyed fingerprint of the
// proposal's record the writer makes (agent-people.ts). It is resolved, suppressed and erased as
// a profile key is, so the person is withheld, found and forgotten as any other; a name never
// makes one.
const PROPOSAL_KEY = /^profile:proposal\/[0-9a-f]{64}$/u;
// No reader serves one as an address; it is an id, not a way to reach anyone.
const PROPOSAL_KEY_PREFIX = `${PROFILE_KEY_PREFIX}proposal/`;
export const isProposalKey = (value: string): boolean => PROPOSAL_KEY.test(value);
export const proposalKey = (fingerprint: string): string | null => {
  const key = `${PROPOSAL_KEY_PREFIX}${fingerprint}`;
  return PROPOSAL_KEY.test(key) ? key : null;
};
// The key of a person the sync made for a meeting's participant known by a name
// alone, `profile:meeting/<64 hex>`, a keyed fingerprint of the name (and, after the owner split
// one meeting's binding, of that meeting and the split's count) the writer makes
// (participant-binding.ts). Resolved, suppressed and erased as a proposal's key is, and, as it, an
// id and never a way to reach anyone.
const MEETING_KEY = /^profile:meeting\/[0-9a-f]{64}$/u;
export const MEETING_KEY_PREFIX = `${PROFILE_KEY_PREFIX}meeting/`;
export const meetingKey = (fingerprint: string): string | null => {
  const key = `${MEETING_KEY_PREFIX}${fingerprint}`;
  return MEETING_KEY.test(key) ? key : null;
};
// Resolved, suppressed and erased as a meeting's key is, and, as it, an id and never a way to reach
// anyone.
const NAMED_KEY = /^profile:named\/[0-9a-f]{64}$/u;
export const NAMED_KEY_PREFIX = `${PROFILE_KEY_PREFIX}named/`;
export const isNamedKey = (value: string): boolean => NAMED_KEY.test(value);
export const namedKey = (fingerprint: string): string | null => {
  const key = `${NAMED_KEY_PREFIX}${fingerprint}`;
  return NAMED_KEY.test(key) ? key : null;
};
// Resolved, suppressed and erased as an address is; a source moment's phone handle resolves to the
// person holding it. The phone is served from the contact, so no reader serves the key as an
// address either.
const PHONE_KEY_PREFIX = "tel:";
const PHONE_KEY = new RegExp(`^tel:${E164_PHONE.source.slice(1)}`, "u");
export const isPhoneKey = (value: string): boolean => PHONE_KEY.test(value);
export const phoneKey = (e164: string): string | null => (E164_PHONE.test(e164) ? `${PHONE_KEY_PREFIX}${e164}` : null);
// Only a zone of the North American Numbering Plan gives one, `1`: the zones of the United States
// and its territories, Canada and the plan's Caribbean members, pinned, each compared in its
// canonical form, so an alias (US/Central) is its zone. Any other zone, or none, gives none, so no
// country is guessed outside the plan.
const NANP_ZONES = [
  "America/New_York",
  "America/Detroit",
  "America/Kentucky/Louisville",
  "America/Kentucky/Monticello",
  "America/Indiana/Indianapolis",
  "America/Indiana/Vincennes",
  "America/Indiana/Winamac",
  "America/Indiana/Marengo",
  "America/Indiana/Petersburg",
  "America/Indiana/Vevay",
  "America/Indiana/Tell_City",
  "America/Indiana/Knox",
  "America/Chicago",
  "America/Menominee",
  "America/North_Dakota/Center",
  "America/North_Dakota/New_Salem",
  "America/North_Dakota/Beulah",
  "America/Denver",
  "America/Boise",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Juneau",
  "America/Sitka",
  "America/Metlakatla",
  "America/Yakutat",
  "America/Nome",
  "America/Adak",
  "Pacific/Honolulu",
  "America/Puerto_Rico",
  "America/St_Thomas",
  "Pacific/Guam",
  "Pacific/Saipan",
  "Pacific/Pago_Pago",
  "America/St_Johns",
  "America/Halifax",
  "America/Glace_Bay",
  "America/Moncton",
  "America/Goose_Bay",
  "America/Toronto",
  "America/Iqaluit",
  "America/Winnipeg",
  "America/Rankin_Inlet",
  "America/Resolute",
  "America/Regina",
  "America/Swift_Current",
  "America/Edmonton",
  "America/Cambridge_Bay",
  "America/Inuvik",
  "America/Dawson_Creek",
  "America/Fort_Nelson",
  "America/Whitehorse",
  "America/Dawson",
  "America/Vancouver",
  "America/Atikokan",
  "America/Blanc-Sablon",
  "America/Creston",
  "America/Nassau",
  "America/Barbados",
  "America/Anguilla",
  "America/Antigua",
  "America/Tortola",
  "America/Cayman",
  "America/Dominica",
  "America/Santo_Domingo",
  "America/Grenada",
  "America/Jamaica",
  "America/Montserrat",
  "America/Lower_Princes",
  "America/St_Kitts",
  "America/St_Lucia",
  "America/St_Vincent",
  "America/Port_of_Spain",
  "America/Grand_Turk",
  "Atlantic/Bermuda",
] as const;
const NANP: ReadonlySet<string> = new Set(NANP_ZONES.map(canonicalTimeZone).filter((one) => one !== null));
export function phoneRegionOf(zone: string | null): "1" | null {
  const canonical = zone === null ? null : canonicalTimeZone(zone);
  return canonical !== null && NANP.has(canonical) ? "1" : null;
}
// A number of the plan's shape: ten digits, the area code's and the exchange's first digit 2 to 9,
// with 1 before them or not.
const NANP_NUMBER = /^1?([2-9][0-9]{2}[2-9][0-9]{6})$/u;

// A saved phone in E.164 form: its canonical form (Google's `canonicalForm`) when that is one,
// else its value once spaces, dashes, dots and brackets are removed when that is one. Else, with
// the owner's region `1` (phoneRegionOf), a value of the plan's shape read as +1
// and its ten digits. Any other national number is none.
export function e164Of(
  phone: { value: string; canonical?: string | null },
  region: string | null = null,
): string | null {
  const bare = phone.value.replace(/[\s.()[\]-]/gu, "");
  for (const one of [phone.canonical, bare]) if (typeof one === "string" && E164_PHONE.test(one)) return one;
  const national = region === "1" ? NANP_NUMBER.exec(bare)?.[1] : undefined;
  return national === undefined ? null : `+1${national}`;
}
// The phone key of a contact with no address: its one E.164 number, when its phones give exactly
// one (two distinct numbers would join two identifiers on one person); null otherwise.
// In E.164 form alone, since the connectors that key a contact read no time zone.
export function contactPhoneKey(phones: readonly { value: string; canonical?: string | null }[]): string | null {
  const numbers = [...new Set(phones.map((one) => e164Of(one)).filter((one): one is string => one !== null))];
  return numbers.length === 1 && numbers[0] !== undefined ? phoneKey(numbers[0]) : null;
}
// Every key that is an id the system made, or a phone's, which no reader serves as
// an address.
export const isMintedKey = (value: string): boolean =>
  PROPOSAL_KEY.test(value) || MEETING_KEY.test(value) || NAMED_KEY.test(value) || PHONE_KEY.test(value);
export const isProfileKey = (value: string): boolean =>
  PROFILE_KEY.test(value) ||
  PROPOSAL_KEY.test(value) ||
  MEETING_KEY.test(value) ||
  NAMED_KEY.test(value) ||
  PHONE_KEY.test(value);

const SLUG = /^[\p{L}\p{N}_%-]{1,100}$/u;

export function profileKey(value: string): string | null {
  let url: URL;
  try {
    const text = value.normalize("NFC").trim();
    // A scheme in any case (`HTTPS://`).
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  const [kind, raw] = url.pathname.split("/").filter((part) => part !== "");
  const slug = raw?.toLowerCase();
  if (kind?.toLowerCase() !== "in" || slug === undefined || !SLUG.test(slug)) return null;
  const key = `${PROFILE_KEY_PREFIX}linkedin.com/in/${slug}`;
  return isProfileKey(key) ? key : null;
}
