import { createHash } from "node:crypto";
import type { Sha256 } from "@intelligence/contracts/personal";

// JSON with every object's keys sorted, so the same value has one text whatever its key order.
// An undefined field is left out, as JSON.stringify leaves it out.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonicalJson(item ?? null)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value).filter(([, held]) => held !== undefined);
    fields.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${fields.map(([name, held]) => `${JSON.stringify(name)}:${canonicalJson(held)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (text: string): Sha256 => createHash("sha256").update(text, "utf8").digest("hex");

export const hashOf = (value: unknown): Sha256 => sha256(canonicalJson(value));
