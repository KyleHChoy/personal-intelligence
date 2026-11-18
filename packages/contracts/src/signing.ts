import { z } from "zod";
import { KeyId, Store, TrustGroupId, Vault } from "./ids.ts";
import { Label } from "./label.ts";
import { Channel, RoleName } from "./tokens.ts";

// Signatures are Ed25519. A private key stays inside the process that loaded it and is not a contract.
export const KeyPurpose = z.enum(["vault_label", "token", "service_identity"]);
export type KeyPurpose = z.infer<typeof KeyPurpose>;

// What a caller is: its role, its process instance, such as "provider_people", and the vault,
// store, trust group or channel it serves. The server reads it from the verified call, never
// from a header or a body.
export const ServiceIdentity = z.strictObject({
  role: RoleName,
  instance: z.string().min(1),
  vault: Vault.optional(),
  store: Store.optional(),
  trustGroup: TrustGroupId.optional(),
  channel: Channel.optional(),
});
export type ServiceIdentity = z.infer<typeof ServiceIdentity>;

// A public key and what it may vouch for. Deployment configuration, never a secret. A service
// identity key carries the one whole identity it may sign for, so a process cannot sign a claim
// that names its own role and instance but another vault, store, trust group or channel.
export const VerificationKey = z
  .strictObject({
    keyId: KeyId,
    purpose: KeyPurpose,
    vault: Vault.optional(),
    identity: ServiceIdentity.optional(),
    publicKey: z.string().min(1),
  })
  .refine((key) => (key.vault !== undefined) === (key.purpose === "vault_label"), {
    message: "a vault is named exactly for a label key",
    path: ["vault"],
  })
  .refine((key) => (key.identity !== undefined) === (key.purpose === "service_identity"), {
    message: "an identity is named exactly for a service identity key",
    path: ["identity"],
  });
export type VerificationKey = z.infer<typeof VerificationKey>;

export const SignatureRejection = z.enum([
  "malformed",
  "unknown_key",
  "wrong_key",
  "wrong_kind",
  "wrong_binding",
  "bad_signature",
  "expired",
]);
export type SignatureRejection = z.infer<typeof SignatureRejection>;

// "added_compartment" is a claim label with a compartment that is on none of its evidence labels
// and is not one the deployment allows a claim to add.
export const LabelRejection = z.enum([
  ...SignatureRejection.options,
  "weaker_than_evidence",
  "no_evidence",
  "added_compartment",
]);
export type LabelRejection = z.infer<typeof LabelRejection>;

export const LabelCheck = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), label: Label }),
  z.object({ ok: z.literal(false), reason: LabelRejection }),
]);
export type LabelCheck = z.infer<typeof LabelCheck>;
