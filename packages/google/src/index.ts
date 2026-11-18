// The connector's public names, and nothing else. The cursor codec stays internal.
export { createGoogleConnector } from "./connector.ts";
export { driveAbout, driveFolder } from "./drive-about.ts";
export { gmailProfile, gmailSendAs } from "./gmail.ts";
export { createTiesReader, TIES_MS_PER_MESSAGE } from "./gmail-ties.ts";
export {
  createGoogleHttp,
  GOOGLE_SCOPES,
  type GoogleDeps,
  GoogleError,
  type GrantKind,
  grantedScopesFor,
  MAX_ANSWER_BYTES,
  MAX_DOCUMENT_ANSWER_BYTES,
  type RateLimitReason,
  scopesFor,
  type TokenSource,
} from "./http.ts";
export { buildAuthUrl, exchangeCode, listenForCode, pkceChallenge, pkcePair, tokenSource } from "./oauth.ts";
export { createPeopleConnector, PEOPLE_FIELDS, PEOPLE_PAGE_SIZE } from "./people.ts";
