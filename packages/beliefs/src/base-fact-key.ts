import { createHmac } from "node:crypto";
import { type ClaimContent, type ClaimId, type OntologyView, type Sha256, TypedValue } from "@intelligence/contracts";
import { sha256 } from "@intelligence/personal-core";

// The base fact key and support hash that personalFactKey (fact-key.ts) and buildBelief
// (build-belief.ts) build on. Deterministic: the same inputs always give the same key, so a key
// stored once is found again.

// Sorted by UTF-8 byte order, which is how Postgres sorts under collation "C".
export const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

// SHA-256 over the ids sorted by byte order and joined by a line feed, repeats removed.
export function supportHash(ids: ClaimId[]): Sha256 {
  return sha256([...new Set<string>(ids)].sort(byBytes).join("\n"));
}

// JSON with no white space and object keys in code-unit order.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    const parts = Object.keys(fields)
      .sort()
      .filter((key) => fields[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(fields[key])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value);
}

// The fields of a claim that are typed values: an id, an enumeration value, a date,
// a number or a boolean. Free text is not one.
function typedFields(fields: Record<string, unknown>): Record<string, TypedValue> {
  const typed: Record<string, TypedValue> = {};
  for (const [name, value] of Object.entries(fields)) {
    const parsed = TypedValue.safeParse(value);
    if (parsed.success) typed[name] = parsed.data;
  }
  return typed;
}

// The fields of a claim that the ontology declares as typed: every declared field whose kind
// is not "text" and whose value is a typed value. A field the type does not declare is not
// one, whatever it holds, and neither is a declared text field that happens to hold one word.
//
// An enumeration value is said as the ontology lists it: one that differs from a listed
// value only in letter case, or in white space around it, is that listed value. So one
// fact has one key and one value however a source spelled it.
export function declaredFields(content: ClaimContent, ontology: OntologyView): Record<string, TypedValue> {
  const typed: Record<string, TypedValue> = {};
  for (const field of ontology.get(content.type)?.fields ?? []) {
    if (field.kind === "text") continue;
    let value = content.fields[field.name];
    if (field.kind === "enum" && typeof value === "string") {
      const said = value.trim();
      value = field.values?.find((listed) => listed.toLowerCase() === said.toLowerCase()) ?? said;
    }
    const parsed = TypedValue.safeParse(value);
    if (parsed.success) typed[field.name] = parsed.data;
  }
  return typed;
}

// How a fact key is made. With an ontology, the typed fields are the ones the ontology
// declares as typed, not the ones whose value looks typed. With a key, the fingerprint is
// an HMAC under it, so a typed field with few possible values cannot be found by trying them.
export type FactKeying = { ontology?: OntologyView; key?: Uint8Array };

// Depends only on type, subject, typed fields and context. A claim with no context
// is a global one. With one argument it is the unkeyed fingerprint over the fields whose
// value is typed.
export function factKey(content: ClaimContent): string;
export function factKey(content: ClaimContent, keying: FactKeying): string;
export function factKey(content: ClaimContent, keying?: unknown): string {
  // Anything but a keying is no keying: `contents.map(factKey)` passes an index here.
  const { ontology, key }: FactKeying = typeof keying === "object" && keying !== null ? keying : {};
  const context = content.context ?? { kind: "global" };
  const stated = canonical({
    type: content.type,
    subject: content.subject,
    fields: ontology === undefined ? typedFields(content.fields) : declaredFields(content, ontology),
    context: { kind: context.kind, id: context.id },
  });
  return key === undefined ? sha256(stated) : createHmac("sha256", key).update(stated, "utf8").digest("hex");
}
