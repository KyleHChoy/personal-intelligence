import { z } from "zod";
import {
  ClientId,
  Compartment,
  EvidenceId,
  GrantId,
  KeyId,
  MemberId,
  RunId,
  ScopeId,
  SessionId,
  Store,
  Timestamp,
  TokenId,
  TrustGroupId,
  Vault,
} from "./ids.ts";

// The runtime rows of the team deployment's credentials list: one role per process kind.
export const RoleName = z.enum([
  "ingest",
  "pipeline",
  "store_worker",
  "provider",
  "reasoner",
  "outbound",
  "research",
  "evals",
  "key_service",
  "identity_service",
  "policy_service",
  "compliance_registry",
  "directory_connector",
  "promotion_gate",
  "model_gateway",
  "app_api",
  "agent_api",
  "channel_adapters",
]);
export type RoleName = z.infer<typeof RoleName>;

// What a member may do beyond reading. Read from the member's signed token.
const StandingRole = z.enum(["match_broker", "quarantine_reviewer", "grant_authority", "compliance_officer"]);
type StandingRole = z.infer<typeof StandingRole>;

// Set by code from the tool or action, never by the caller.
const TokenPurpose = z.enum(["read", "workbench", "request", "propose", "act", "correction", "review", "run", "evals"]);
type TokenPurpose = z.infer<typeof TokenPurpose>;

// What a job scope may ask of the key service.
const KeyOperation = z.enum([
  "create",
  "encrypt",
  "decrypt",
  "register",
  "register_card",
  "relabel",
  "shred",
  "reencrypt",
]);
type KeyOperation = z.infer<typeof KeyOperation>;

// A way out to a member. "mobile" and "push" are kept but not part of this build.
export const Channel = z.enum(["workbench", "mobile", "agent_api", "chat", "push", "email_digest", "draft"]);
export type Channel = z.infer<typeof Channel>;

// The grant a run works under. The compartments let a vault check a span request without
// holding policy.
const MatchingGrantRef = z.strictObject({
  id: GrantId,
  compartments: z.array(Compartment).min(1),
});
type MatchingGrantRef = z.infer<typeof MatchingGrantRef>;

// What the policy service signs for each request. The provider sets it per transaction.
// A run token is this with runId set, and then sessionId equals runId.
export const ViewerToken = z
  .strictObject({
    id: TokenId,
    member: MemberId,
    sessionId: SessionId,
    client: ClientId,
    purpose: TokenPurpose,
    stores: z.array(Store).min(1),
    roles: z.array(StandingRole),
    expiresAt: Timestamp,
    runId: RunId.optional(),
    // Needs runId. The member is then the grantee.
    matchingGrant: MatchingGrantRef.optional(),
  })
  .refine((token) => token.runId === undefined || String(token.runId) === String(token.sessionId), {
    message: "a run token's session is its run id",
    path: ["sessionId"],
  })
  .refine((token) => token.matchingGrant === undefined || token.runId !== undefined, {
    message: "a matching grant needs a run id",
    path: ["matchingGrant"],
  });
export type ViewerToken = z.infer<typeof ViewerToken>;

// The kind says which it is: a run token has a run id, a viewer token has none.
export const SignedViewerToken = z
  .strictObject({
    kind: z.enum(["viewer_token", "run_token"]),
    token: ViewerToken,
    keyId: KeyId,
    signature: z.string().min(1),
  })
  .refine((signed) => (signed.kind === "run_token") === (signed.token.runId !== undefined), {
    message: "the kind does not agree with the run id",
    path: ["kind"],
  });
export type SignedViewerToken = z.infer<typeof SignedViewerToken>;

const scopeFields = {
  role: RoleName,
  vault: Vault.optional(),
  store: Store.optional(),
  gateway: TrustGroupId.optional(),
  operation: KeyOperation.optional(),
  // A pipeline scope: the leased items and the earlier replies their extractions read.
  items: z.array(EvidenceId).optional(),
};

type ScopeFields = z.infer<z.ZodObject<typeof scopeFields>>;

// A scope is one of two things. A key scope names a vault or a store, never both, and one
// operation; it may list items only with a vault. A gateway scope names a gateway and nothing
// else. A scope that names only a role, or a place with no operation, is neither.
const scopeIsCoherent = (scope: ScopeFields): boolean => {
  const places = [scope.vault, scope.store].filter((place) => place !== undefined).length;
  if (scope.gateway !== undefined) return places === 0 && scope.operation === undefined && scope.items === undefined;
  if (places !== 1 || scope.operation === undefined) return false;
  return scope.items === undefined || scope.vault !== undefined;
};
const incoherent = { message: "not one key scope or one gateway scope" };

export const JobScope = z
  .strictObject({ id: ScopeId, ...scopeFields, expiresAt: Timestamp })
  .refine(scopeIsCoherent, incoherent);
export type JobScope = z.infer<typeof JobScope>;

export const SignedJobScope = z.strictObject({
  kind: z.literal("job_scope"),
  payload: JobScope,
  keyId: KeyId,
  signature: z.string().min(1),
});
export type SignedJobScope = z.infer<typeof SignedJobScope>;
