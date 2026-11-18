import { describe, expect, it } from "vitest";
import { JobScope, SignedViewerToken, VerificationKey, ViewerToken } from "./index.ts";
import { jobScope, later, runToken, viewerToken } from "./test-samples.ts";

const sig = { keyId: "k-token-1", signature: "sig" };

describe("signed kinds", () => {
  it("a verification key names a vault only for labels", () => {
    const key = { keyId: "k-1", publicKey: "cHVibGlj" };
    expect(VerificationKey.safeParse({ ...key, purpose: "token" }).success).toBe(true);
    expect(VerificationKey.safeParse({ ...key, purpose: "vault_label", vault: "team" }).success).toBe(true);
    expect(VerificationKey.safeParse({ ...key, purpose: "vault_label" }).success).toBe(false);
    expect(VerificationKey.safeParse({ ...key, purpose: "token", vault: "team" }).success).toBe(false);
  });

  it("a service identity key carries the whole identity it may sign for, and no other key does", () => {
    const key = { keyId: "k-1", publicKey: "cHVibGlj" };
    const identity = { role: "provider", instance: "provider_people", store: "people" };
    expect(VerificationKey.safeParse({ ...key, purpose: "service_identity", identity }).success).toBe(true);
    expect(VerificationKey.safeParse({ ...key, purpose: "service_identity" }).success).toBe(false);
    expect(
      VerificationKey.safeParse({ ...key, purpose: "service_identity", identity: { role: "provider" } }).success,
    ).toBe(false);
    expect(
      VerificationKey.safeParse({ ...key, purpose: "service_identity", identity: { ...identity, member: "m-ada" } })
        .success,
    ).toBe(false);
    expect(VerificationKey.safeParse({ ...key, purpose: "token", identity }).success).toBe(false);
    expect(VerificationKey.safeParse({ ...key, purpose: "vault_label", vault: "team", identity }).success).toBe(false);
    expect(VerificationKey.safeParse({ ...key, purpose: "service_identity", identity, vault: "team" }).success).toBe(
      false,
    );
  });

  it("a service identity key no longer names a bare role or instance", () => {
    const key = {
      keyId: "k-1",
      publicKey: "cHVibGlj",
      purpose: "service_identity",
      role: "provider",
      instance: "provider_people",
    };
    expect(VerificationKey.safeParse(key).success).toBe(false);
    expect(Object.keys(VerificationKey.shape)).toEqual(["keyId", "purpose", "vault", "identity", "publicKey"]);
  });
});

describe("tokens", () => {
  it("accepts a viewer token and a run token", () => {
    expect(ViewerToken.safeParse(viewerToken).success).toBe(true);
    expect(ViewerToken.safeParse(runToken).success).toBe(true);
  });

  it("rejects a token with no id, member or session", () => {
    for (const key of ["id", "member", "sessionId"] as const) {
      const { [key]: _dropped, ...rest } = viewerToken;
      expect(ViewerToken.safeParse(rest).success, key).toBe(false);
    }
  });

  it("rejects a run token whose session is not its run id", () => {
    expect(ViewerToken.safeParse({ ...runToken, sessionId: "s-1" }).success).toBe(false);
  });

  it("rejects a matching grant without a run id or without compartments", () => {
    const matchingGrant = { id: "g-2", compartments: ["deal:birch"] };
    expect(ViewerToken.safeParse({ ...runToken, matchingGrant }).success).toBe(true);
    expect(ViewerToken.safeParse({ ...viewerToken, matchingGrant }).success).toBe(false);
    expect(ViewerToken.safeParse({ ...runToken, matchingGrant: { id: "g-2", compartments: [] } }).success).toBe(false);
  });

  it("rejects a role outside the four standing roles and a token with no store", () => {
    expect(ViewerToken.safeParse({ ...viewerToken, roles: ["match_broker"] }).success).toBe(true);
    expect(ViewerToken.safeParse({ ...viewerToken, roles: ["admin"] }).success).toBe(false);
    expect(ViewerToken.safeParse({ ...viewerToken, stores: [] }).success).toBe(false);
  });

  it("a signed token's kind agrees with its run id", () => {
    const sig = { keyId: "k-token-1", signature: "sig" };
    expect(SignedViewerToken.safeParse({ kind: "viewer_token", token: viewerToken, ...sig }).success).toBe(true);
    expect(SignedViewerToken.safeParse({ kind: "run_token", token: runToken, ...sig }).success).toBe(true);
    expect(SignedViewerToken.safeParse({ kind: "run_token", token: viewerToken, ...sig }).success).toBe(false);
    expect(SignedViewerToken.safeParse({ kind: "viewer_token", token: runToken, ...sig }).success).toBe(false);
  });
});

describe("job scopes", () => {
  it("accepts a key scope and a gateway scope", () => {
    expect(JobScope.safeParse(jobScope).success).toBe(true);
    const gateway = { id: "sc-2", role: "pipeline", gateway: "tg-team", expiresAt: later };
    expect(JobScope.safeParse(gateway).success).toBe(true);
  });

  it("rejects a gateway scope that names a key operation", () => {
    const scope = {
      id: "sc-2",
      role: "pipeline",
      gateway: "tg-team",
      operation: "decrypt",
      vault: "team",
      expiresAt: later,
    };
    expect(JobScope.safeParse(scope).success).toBe(false);
  });

  it("rejects a scope that names both a vault and a store", () => {
    const { items: _items, ...scope } = jobScope;
    expect(JobScope.safeParse({ ...scope, store: "people" }).success).toBe(false);
  });

  it("rejects an operation without a vault or store, and items without a vault", () => {
    const { vault: _vault, items: _items, ...bare } = jobScope;
    expect(JobScope.safeParse(bare).success).toBe(false);
    expect(JobScope.safeParse({ ...bare, store: "people", items: ["ev-1"] }).success).toBe(false);
  });

  it("rejects a scope that names nothing but a role, or a place with no operation", () => {
    const base = { id: "sc-3", role: "pipeline", expiresAt: later };
    expect(JobScope.safeParse(base).success).toBe(false);
    expect(JobScope.safeParse({ ...base, vault: "team" }).success).toBe(false);
    expect(JobScope.safeParse({ ...base, store: "people" }).success).toBe(false);
    expect(JobScope.safeParse({ ...base, store: "people", operation: "decrypt" }).success).toBe(true);
  });

  it("rejects a gateway scope that also names a vault or a store", () => {
    const gateway = { id: "sc-2", role: "pipeline", gateway: "tg-team", expiresAt: later };
    expect(JobScope.safeParse({ ...gateway, vault: "team" }).success).toBe(false);
    expect(JobScope.safeParse({ ...gateway, store: "people" }).success).toBe(false);
    expect(JobScope.safeParse({ ...gateway, items: ["ev-1"] }).success).toBe(false);
  });
});
