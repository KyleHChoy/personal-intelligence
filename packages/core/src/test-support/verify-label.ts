import { createPublicKey, verify } from "node:crypto";
import {
  LabelBinding,
  type LabelCheck,
  type LabelRejection,
  SignedLabel,
  type VerificationKey,
} from "@intelligence/contracts";
import { canonicalBytes } from "../canonical.ts";
import { normalize } from "../claim-pipeline/labels.ts";

// A vault's Ed25519 check of a signed label, as a team deployment verifies one. Personal code signs
// no label: the adapter's sentinel exists only so the claim pipeline's `verify` has a signature to
// refuse, and the tests hold that it fails this real check.

const refuse = (reason: LabelRejection): LabelCheck => ({ ok: false, reason });

// One PEM block labelled as a public key and nothing else.
const PUBLIC_PEM = /^-----BEGIN PUBLIC KEY-----[^-]+-----END PUBLIC KEY-----$/;

function signatureFails(publicKey: string, bytes: Uint8Array, signature: string): LabelRejection | undefined {
  let key: ReturnType<typeof createPublicKey> | undefined;
  try {
    key = PUBLIC_PEM.test(publicKey.trim()) ? createPublicKey(publicKey) : undefined;
  } catch {
    key = undefined;
  }
  if (key?.asymmetricKeyType !== "ed25519") return "wrong_key";
  const raw = Buffer.from(signature, "base64");
  // One signature has one spelling.
  if (raw.length !== 64 || raw.toString("base64") !== signature) return "bad_signature";
  return verify(null, bytes, key, raw) ? undefined : "bad_signature";
}

export function verifyLabel(signed: SignedLabel, binding: LabelBinding, keys: VerificationKey[]): LabelCheck {
  const envelope = SignedLabel.safeParse(signed);
  const given = LabelBinding.safeParse(binding);
  if (!envelope.success || !given.success || !Array.isArray(keys)) return refuse("malformed");
  const { label, vault, evidenceId, keyId, signature } = envelope.data;
  const named = keys.filter((key) => key.keyId === keyId);
  const key = named[0];
  if (named.length !== 1 || key === undefined) return refuse("unknown_key");
  if (key.purpose !== "vault_label" || key.vault !== vault) return refuse("wrong_key");
  const failed = signatureFails(
    key.publicKey,
    canonicalBytes({ kind: "label", keyId, payload: label, vault, evidenceId }),
    signature,
  );
  if (failed !== undefined) return refuse(failed);
  if (vault !== given.data.vault || evidenceId !== given.data.evidenceId) return refuse("wrong_binding");
  return { ok: true, label: normalize(label) };
}
