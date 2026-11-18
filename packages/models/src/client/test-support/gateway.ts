import {
  EmbeddingResponse,
  GatewayRefusal,
  type HttpPort,
  type HttpResponse,
  type ServiceIdentity,
  SignedJobScope,
  type TrustGroupId,
} from "@intelligence/contracts";
import { checkCompletion, checkEmbedding, checkReply } from "../checks.ts";
import type { ModelClient } from "../client.ts";
import { ModelClientError } from "../errors.ts";

// One gateway, for one trust group. `scope` hands back a job scope that names this gateway,
// taken by the caller from the request that started its work.
export interface GatewayEndpoint {
  url: string;
  trustGroup: TrustGroupId;
  identity: ServiceIdentity;
  scope(): Promise<SignedJobScope>;
}

// The port owns the real deadline; this is what the request asks for.
const TIMEOUT_MS = 60_000;

// A test client over a model gateway, the live side of the replay tests. Talks to one model gateway, over the HttpPort the calling app built. It has no retry of its
// own and never tries a second endpoint: a failed call ends as `unavailable`, and the caller's
// queue lease retries the item. It logs nothing, and no error it throws carries evidence.
export function createGatewayClient(
  endpoint: GatewayEndpoint,
  mode: "full" | "embeddings_only",
  http: HttpPort,
): ModelClient {
  if (endpoint.identity.trustGroup !== undefined && endpoint.identity.trustGroup !== endpoint.trustGroup) {
    throw new ModelClientError("wrong_trust_group");
  }

  // The scope must name this gateway. The gateway checks its signature; the client never does.
  const jobScope = async (): Promise<SignedJobScope> => {
    let scope: ReturnType<typeof SignedJobScope.safeParse>;
    try {
      scope = SignedJobScope.safeParse(await endpoint.scope());
    } catch {
      throw new ModelClientError("no_scope");
    }
    if (!scope.success) throw new ModelClientError("no_scope");
    if (scope.data.payload.gateway !== endpoint.trustGroup) throw new ModelClientError("wrong_gateway");
    return scope.data;
  };

  const post = async (path: string, body: unknown): Promise<HttpResponse> => {
    const scope = await jobScope();
    let response: HttpResponse;
    try {
      response = await http.send({
        method: "POST",
        url: `${endpoint.url.replace(/\/+$/, "")}${path}`,
        headers: { "content-type": "application/json" },
        body,
        auth: scope,
        timeoutMs: TIMEOUT_MS,
        // A call that must not repeat is sent as a write, so the port never retries it.
        kind: "write",
      });
    } catch {
      throw new ModelClientError("unavailable");
    }
    if (response.status >= 200 && response.status < 300) return response;
    const refusal = GatewayRefusal.safeParse(response.body);
    if (refusal.success && refusal.data.code !== "vendor_failed")
      throw new ModelClientError("refused", refusal.data.code);
    throw new ModelClientError("unavailable");
  };

  return {
    async complete(req) {
      if (mode !== "full") throw new ModelClientError("wrong_mode");
      const { request, prompt } = checkCompletion(req);
      if (request.trustGroup !== endpoint.trustGroup) throw new ModelClientError("wrong_trust_group");

      return checkReply(prompt, request, (await post("/v1/complete", request)).body);
    },

    async embed(req) {
      const request = checkEmbedding(req);
      if (request.trustGroup !== endpoint.trustGroup) throw new ModelClientError("wrong_trust_group");

      const reply = EmbeddingResponse.safeParse((await post("/v1/embed", request)).body);
      if (!reply.success) throw new ModelClientError("unavailable");
      return { ...reply.data, label: request.label };
    },
  };
}
