// One connected Google label for sync: the OAuth client `pi google connect` stored for it, which
// labels are connected, and the PersonalSource built from its tokens.
import type { PersonalLogger } from "@intelligence/contracts/personal";
import type { PersonalSource } from "@intelligence/personal-core/items";
import type { GoogleDeps } from "@intelligence/personal-google";
import {
  createGoogleConnector,
  createGoogleHttp,
  createPeopleConnector,
  createTiesReader,
  driveAbout,
  GOOGLE_SCOPES,
  GoogleError,
  gmailProfile,
  gmailSendAs,
  MAX_DOCUMENT_ANSWER_BYTES,
  scopesFor,
  tokenSource,
} from "@intelligence/personal-google";
import { googleSecretName } from "@intelligence/personal-store";
import { refusal } from "../env.ts";

// A label's OAuth client and its compartment, as `pi google connect` seals them.
export type GoogleClient = { clientId: string; clientSecret: string; compartment: string };

// A label's stored client, or null when the secret is missing or is not JSON that holds the
// three as non-empty strings.
export function clientOf(stored: string | null): GoogleClient | null {
  let value: unknown;
  try {
    value = stored === null ? null : JSON.parse(stored);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { clientId, clientSecret, compartment } = value as Record<string, unknown>;
  const filled = (one: unknown): one is string => typeof one === "string" && one !== "";
  return filled(clientId) && filled(clientSecret) && filled(compartment)
    ? { clientId, clientSecret, compartment }
    : null;
}

// The connected labels among the stored secrets' names: each one that has a client.
export function connectedLabels(names: string[]): string[] {
  return names.flatMap((name) => {
    const [, label] = name.split("/");
    return label !== undefined && name === googleSecretName(label, "client") ? [label] : [];
  });
}

export function googleSource(
  label: string,
  client: GoogleClient,
  tokens: { mail: string; contacts: string | null; drive: string | null },
  deps: GoogleDeps,
  log: PersonalLogger,
): PersonalSource {
  const { clientId, clientSecret, compartment } = client;
  const http = createGoogleHttp({
    tokens: tokenSource({ grant: "mail", clientId, clientSecret, refreshToken: tokens.mail }, deps),
    deps,
  });
  const secret = JSON.stringify({ clientId, clientSecret, refreshToken: tokens.mail });
  const contacts = tokens.contacts;
  const driveToken = tokens.drive;
  const driveHttp =
    driveToken === null
      ? null
      : createGoogleHttp({
          tokens: tokenSource({ grant: "drive", clientId, clientSecret, refreshToken: driveToken }, deps),
          deps,
          maxAnswerBytes: MAX_DOCUMENT_ANSWER_BYTES,
        });
  const driveSecret = JSON.stringify({ clientId, clientSecret, refreshToken: driveToken });
  return {
    label,
    compartment,
    profile: () => gmailProfile(http, deps),
    sendAs: () => gmailSendAs(http, deps),
    connector: (id, sourceAccount, options) => {
      const logged: GoogleDeps = {
        ...deps,
        onRateLimit: (reason, pausedMs) =>
          log.warn({
            event: "rate_limited",
            ids: { account: sourceAccount },
            counts: { paused_ms: pausedMs },
            code: reason,
          }),
      };
      if (id === "google_contacts") {
        if (contacts === null) throw new GoogleError("off_allowlist");
        const people = createGoogleHttp({
          tokens: tokenSource({ grant: "contacts", clientId, clientSecret, refreshToken: contacts }, deps),
          deps,
        });
        const credential = {
          connector: id,
          sourceAccount,
          scopes: [...scopesFor("contacts")],
          secret: JSON.stringify({ clientId, clientSecret, refreshToken: contacts }),
        };
        return createPeopleConnector(credential, people, deps);
      }
      if (id !== "google_docs")
        return createGoogleConnector(
          id,
          { connector: id, sourceAccount, scopes: [...GOOGLE_SCOPES], secret },
          http,
          options,
          logged,
        );
      if (driveHttp === null) throw refusal("reconnect_drive");
      return createGoogleConnector(
        id,
        { connector: id, sourceAccount, scopes: [...scopesFor("drive")], secret: driveSecret },
        driveHttp,
        options,
        logged,
      );
    },
    ties: (sourceAccount) =>
      createTiesReader(http, sourceAccount, {
        ...deps,
        onRateLimit: (reason, pausedMs) =>
          log.warn({
            event: "rate_limited",
            ids: { account: sourceAccount },
            counts: { paused_ms: pausedMs },
            code: reason,
          }),
      }),
    ...(driveHttp === null ? {} : { driveProfile: () => driveAbout(driveHttp, deps) }),
  };
}
