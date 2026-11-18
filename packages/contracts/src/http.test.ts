import { describe, expect, it } from "vitest";
import { HttpRequest, ServiceIdentity } from "./index.ts";
import { signedJobScope, signedViewerToken } from "./test-samples.ts";

describe("service identity", () => {
  const identity = { role: "provider", instance: "provider_people", store: "people" };

  it("names a role, an instance and the vault, store, trust group or channel it serves", () => {
    expect(ServiceIdentity.safeParse(identity).success).toBe(true);
    expect(ServiceIdentity.safeParse({ role: "ingest", instance: "ingest_team", vault: "team" }).success).toBe(true);
    expect(
      ServiceIdentity.safeParse({ role: "channel_adapters", instance: "channel_adapters_chat", channel: "chat" })
        .success,
    ).toBe(true);
    expect(ServiceIdentity.safeParse({ role: "provider", store: "people" }).success).toBe(false);
    expect(ServiceIdentity.safeParse({ role: "operator", instance: "operator" }).success).toBe(false);
    expect(ServiceIdentity.safeParse({ ...identity, member: "m-ada" }).success).toBe(false);
  });
});

describe("http", () => {
  const request = {
    method: "POST",
    url: "http://127.0.0.1:4101/tools/get_entity",
    headers: {},
    timeoutMs: 2000,
    kind: "read",
  };

  it("a request is marked a read or a write", () => {
    expect(HttpRequest.safeParse(request).success).toBe(true);
    const { kind: _kind, ...unmarked } = request;
    expect(HttpRequest.safeParse(unmarked).success).toBe(false);
    expect(HttpRequest.safeParse({ ...request, method: "PUT" }).success).toBe(false);
  });

  it("a request carries its token or scope as a typed field", () => {
    expect(HttpRequest.safeParse({ ...request, auth: signedViewerToken }).success).toBe(true);
    expect(HttpRequest.safeParse({ ...request, auth: signedJobScope }).success).toBe(true);
    expect(HttpRequest.safeParse({ ...request, auth: "Bearer abc" }).success).toBe(false);
  });
});
