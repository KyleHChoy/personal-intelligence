import { APPROVAL_ALPHABET, type OAuthRegistration, type PersonalOAuth } from "@intelligence/contracts/personal";
import type pg from "pg";
import { Unavailable } from "../core/read-ctx.ts";

// A registration's fingerprint: what the consent page shows and the owner
// names to `pi oauth approve` and `pi oauth code`, so that a code opens the one registration
// approved. Eight characters of the approval code's alphabet, in two groups of four, from the
// first eight characters of the id's random part (`oc_` and 32 of base64url, minted by pi http),
// 5 bits of each. Not a secret: the id is the client's own client_id.
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const FINGERPRINT_LENGTH = 8;

export function registrationFingerprint(registration: string): string {
  const text = [...registration.slice(3, 3 + FINGERPRINT_LENGTH)]
    .map((one) => APPROVAL_ALPHABET[BASE64URL.indexOf(one) & 31] ?? "0")
    .join("");
  return `${text.slice(0, 4)}-${text.slice(4)}`;
}

// What the owner typed, in registrationFingerprint's form, read as an approval code is (case,
// spaces and hyphens dropped, I and L as 1, O as 0); null for text that is no fingerprint.
export function fingerprintText(typed: string): string | null {
  const text = typed.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return text.length === FINGERPRINT_LENGTH && [...text].every((one) => APPROVAL_ALPHABET.includes(one))
    ? `${text.slice(0, 4)}-${text.slice(4)}`
    : null;
}

// A database error throws Unavailable, holding nothing of the statement or its values; `pi http` answers
// it 503.
export class OAuthStore implements PersonalOAuth {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async #one<Row>(text: string, values: unknown[]): Promise<Row | undefined> {
    try {
      return (await this.#pool.query(text, values)).rows[0] as Row | undefined;
    } catch {
      throw new Unavailable();
    }
  }

  async #yes(text: string, values: unknown[]): Promise<boolean> {
    return (await this.#one<{ ok: boolean }>(text, values))?.ok === true;
  }

  async register(registration: string, value: OAuthRegistration): Promise<void> {
    await this.#one("select policy.oauth_register($1, $2, $3)", [registration, value.redirectUris, value.clientName]);
  }

  async registration(registration: string): Promise<(OAuthRegistration & { fingerprint: string }) | null> {
    const row = await this.#one<{ redirect_uris: string[]; client_name: string | null }>(
      "select redirect_uris, client_name from policy.oauth_registration($1)",
      [registration],
    );
    return row === undefined
      ? null
      : {
          redirectUris: row.redirect_uris,
          clientName: row.client_name,
          fingerprint: registrationFingerprint(registration),
        };
  }

  authorize(grant: Parameters<PersonalOAuth["authorize"]>[0]): Promise<boolean> {
    return this.#yes("select policy.oauth_authorize($1, $2, $3, $4, $5, $6) as ok", [
      grant.registration,
      grant.approvalHash,
      grant.codeHash,
      grant.redirectUri,
      grant.challenge,
      grant.resource,
    ]);
  }

  exchange(grant: Parameters<PersonalOAuth["exchange"]>[0]): Promise<boolean> {
    return this.#yes("select policy.oauth_exchange($1, $2, $3, $4, $5, $6, $7) as ok", [
      grant.registration,
      grant.codeHash,
      grant.challenge,
      grant.redirectUri,
      grant.resource,
      grant.accessHash,
      grant.refreshHash,
    ]);
  }

  refresh(grant: Parameters<PersonalOAuth["refresh"]>[0]): Promise<boolean> {
    return this.#yes("select policy.oauth_refresh($1, $2, $3, $4) as ok", [
      grant.registration,
      grant.refreshHash,
      grant.accessHash,
      grant.nextRefreshHash,
    ]);
  }
}
