// @intelligence/personal-core: the stable base every personal package shares (units, hashing,
// ordering, clock, values, the owner, item ids, addresses and domains, identity keys, text normal
// forms and days). Feature modules have their own entries: `/items`, `/lens`, `/views`, `/planner`,
// `/checks`, `/outbound` and `/research`.
export { addressesIn, findAddresses, normalizeAddress, strictAddress } from "./addresses.ts";
export { canonicalBytes } from "./canonical.ts";
export { type Checked, check, type GroundingHook } from "./claim-pipeline/check.ts";
export { PipelineError } from "./claim-pipeline/errors.ts";
export { checkOutput, type Interpreted } from "./claim-pipeline/interpret.ts";
export { combine } from "./claim-pipeline/labels.ts";
export { type Parsed, parse, segmentAt } from "./claim-pipeline/parse.ts";
export type { PipelineItem } from "./claim-pipeline/ports.ts";
export { type ReadItem, verify } from "./claim-pipeline/read-set.ts";
export { type Now, systemNow } from "./clock.ts";
export { byText } from "./compare.ts";
export { DAY_MS } from "./days.ts";
export {
  CONSUMER_DOMAINS,
  foldDomain,
  mentionDomain,
  mentionOrganization,
  organizationDomain,
  organizationOfDomain,
} from "./domains.ts";
export { sha256 } from "./hash.ts";
export { gmailItemId, parseGmailItemId } from "./item-id.ts";
export { canonicalJson } from "./json.ts";
export { isPicture, isShaping, keyPhrase, keyWords, polarPhrase, statesTwoFacts } from "./key-phrase.ts";
export { PERSONAL_LIMITS } from "./limits.ts";
export { type MaskedSpan, maskCredentials, maskedField, maskedIn, maskedInUnits, maskedSpans } from "./mask.ts";
export { datedTitle } from "./own-dates.ts";
export { THE_OWNER } from "./owner.ts";
export { phoneDigits, phonesIn } from "./phones.ts";
export {
  e164Of,
  isMintedKey,
  isNamedKey,
  isPhoneKey,
  isProfileKey,
  MEETING_KEY_PREFIX,
  meetingKey,
  NAMED_KEY_PREFIX,
  namedKey,
  phoneKey,
  phoneRegionOf,
  profileKey,
  proposalKey,
} from "./profile-key.ts";
export { registrableDomain } from "./public-suffix.ts";
export { repoFile, repoRoot } from "./repo-root.ts";
export { codePoints } from "./units.ts";
