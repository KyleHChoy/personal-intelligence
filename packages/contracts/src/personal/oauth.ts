// OAuth 2.1 for the agent endpoint: the port `pi http` asks the store through, and the approval
// code's form. Every token, code and approval code crosses the port as the hex SHA-256 of its UTF-8
// bytes, never in clear.

export type OAuthRegistration = { redirectUris: string[]; clientName: string | null };

export type PersonalOAuth = {
  register(registration: string, value: OAuthRegistration): Promise<void>;
  // With the fingerprint the consent page shows, which the owner names to `pi oauth approve`.
  registration(registration: string): Promise<(OAuthRegistration & { fingerprint: string }) | null>;
  // Spends the approval code and issues the authorization code. False for an approval code that is
  // unknown, spent or expired, or whose client is revoked.
  authorize(grant: {
    registration: string;
    approvalHash: string;
    codeHash: string;
    redirectUri: string;
    challenge: string;
    resource: string | null;
  }): Promise<boolean>;
  // `challenge` is the S256 of the verifier the client sent.
  exchange(grant: {
    registration: string;
    codeHash: string;
    challenge: string;
    redirectUri: string;
    resource: string | null;
    accessHash: string;
    refreshHash: string;
  }): Promise<boolean>;
  refresh(grant: {
    registration: string;
    refreshHash: string;
    accessHash: string;
    nextRefreshHash: string;
  }): Promise<boolean>;
};

// The lifetimes the store keeps: what the token endpoint tells the client.
export const OAUTH_ACCESS_SECONDS = 3600;

// The approval code: 12 characters of Crockford's base32, 60 bits, printed in three groups of four.
// What the owner types is read case-insensitively, with spaces and hyphens dropped and the letters
// Crockford reads as digits (I and L as 1, O as 0) read so.
export const APPROVAL_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const APPROVAL_LENGTH = 12;

// The code as stored and hashed, or null for text that is no approval code.
export function approvalCodeText(typed: string): string | null {
  const text = typed.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return text.length === APPROVAL_LENGTH && [...text].every((one) => APPROVAL_ALPHABET.includes(one)) ? text : null;
}
