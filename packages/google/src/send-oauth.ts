import { createGoogleHttp, type GoogleDeps, GoogleError, withDefaults } from "./http.ts";

// The send grant's revoke. The consent and the token are `oauth.ts`'s, with the grant `send`.

const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

// One form POST of the refresh token, a write, sent once, through a port with no tokens. True
// only for a 200, with or without a body that parses; any other answer or error is false.
export async function revokeSendToken(refreshToken: string, deps: GoogleDeps = {}): Promise<boolean> {
  const http = createGoogleHttp({ tokens: null, deps });
  try {
    const answer = await http.send({
      method: "POST",
      url: REVOKE_URL,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }).toString(),
      timeoutMs: withDefaults(deps).timeoutMs,
      kind: "write",
    });
    return answer.status === 200;
  } catch (error) {
    return error instanceof GoogleError && error.status === 200;
  }
}
