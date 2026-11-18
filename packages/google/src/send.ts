import type { HttpPort } from "@intelligence/contracts";
import type { SendResult } from "@intelligence/contracts/personal";
import { createGoogleHttp, type GoogleDeps, GoogleError, isRecord, text, withDefaults } from "./http.ts";

// The write side of Google, the entry `./send`. It reaches two URLs, the revoke URL and the send
// URL, and no other. Only `apps/pi/src/send/send.ts` imports it. The consent and the token are
// `oauth.ts`'s, with the grant `send`.

export { revokeSendToken } from "./send-oauth.ts";
export { renderMessage } from "./send-render.ts";

const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

// The port for the send call: the read port of `http.ts` with the one access token of the
// command, never refreshed, behind one check: a write POST to the send URL, or off_allowlist
// before anything is sent. A write is sent once by that port, so nothing here can retry it. The
// deadline is the one from deps, whatever the request asks.
export function createSendHttp({ accessToken, deps }: { accessToken: string; deps?: GoogleDeps }): HttpPort {
  const port = createGoogleHttp({
    tokens: { accessToken: async () => accessToken, invalidate: () => {} },
    ...(deps === undefined ? {} : { deps }),
  });
  const { timeoutMs } = withDefaults(deps);
  return {
    async send(req) {
      if (req.method !== "POST" || req.url !== SEND_URL || req.kind !== "write") throw new GoogleError("off_allowlist");
      return port.send({ ...req, timeoutMs });
    },
  };
}

// One POST, sent once. `failed` only for a 4xx Gmail gave, 408 excepted; everything else is
// `unknown`, since no error says the message was not taken. It never throws.
export async function sendMessage(http: HttpPort, bytes: Uint8Array, threadId?: string): Promise<SendResult> {
  try {
    const answer = await http.send({
      method: "POST",
      url: SEND_URL,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        raw: Buffer.from(bytes).toString("base64url"),
        ...(threadId === undefined ? {} : { threadId }),
      }),
      timeoutMs: withDefaults().timeoutMs,
      kind: "write",
    });
    const body = answer.body;
    if (!isRecord(body) || !text(body.id)) return { outcome: "unknown" };
    return { outcome: "sent", id: body.id, threadId: text(body.threadId) ? body.threadId : null };
  } catch (error) {
    const status = error instanceof GoogleError ? error.status : undefined;
    return status !== undefined && status >= 400 && status <= 499 && status !== 408
      ? { outcome: "failed", status }
      : { outcome: "unknown" };
  }
}
