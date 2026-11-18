import { createHash } from "node:crypto";

// SHA-256, in hex, over a value's JSON. Ids are made with it: a claim's, and the request id of
// each identity resolution.
export const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

// Keys sorted at every depth, so one content has one encoding.
export const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, inner]) => [key, canonical(inner)]),
        )
      : value;
