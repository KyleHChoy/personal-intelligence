// What every admin module shares and nothing in the admin's own graph is needed for: the
// clearance's cap, a client token and a Google secret's name. It imports no admin
// module, so the modules the Admin is built from can import it without a cycle back to admin.ts.
import { createHash, randomBytes } from "node:crypto";
import type { RulingId } from "@intelligence/contracts/personal";
import { AdminError } from "../core/admin-error.ts";
import type { Query } from "../core/db.ts";
import { TRY_SYNC } from "../core/locks.ts";

// The decision a repeated request id wrote first, or undefined: a repeat returns it and writes nothing.
export const repeatedDecision = async (query: Query, requestId: string): Promise<RulingId | undefined> =>
  (await query<{ id: RulingId }>("select id from knowledge.owner_decisions where request_id = $1", [requestId]))[0]?.id;

// The same, with the ruling it superseded.
export async function repeatedRuling(
  query: Query,
  requestId: string,
): Promise<{ id: RulingId; supersedes: string | null } | undefined> {
  const [row] = await query<{ id: RulingId; supersedes: string | null }>(
    "select id, supersedes from knowledge.owner_decisions where request_id = $1",
    [requestId],
  );
  return row;
}

// Counted after `agent:<name>` is added, each compartment once.
export const MAX_COMPARTMENTS = 32;
export function capped(compartments: string[]): string[] {
  if (new Set(compartments).size > MAX_COMPARTMENTS) throw new AdminError("too_many_compartments");
  return compartments;
}

export function newToken(): { token: string; hash: string } {
  const token = `pit_${randomBytes(32).toString("base64url")}`;
  return { token, hash: createHash("sha256").update(token, "utf8").digest("hex") };
}

// A new token for the active client of that name, in place of its old one, which stops resolving at
// once; its expiry is set again to the column's default, 90 days on. Nothing else of the row changes.
// Null for a revoked or unknown name. `rotateToken`'s, and a Lens device's (lens-admin.ts).
export async function rotated(query: Query, name: string): Promise<string | null> {
  const { token, hash } = newToken();
  const rows = await query(
    "update policy.clients set token_hash = $2, expires_at = default where name = $1 and status = 'active' returning id",
    [name, hash],
  );
  return rows.length === 0 ? null : token;
}

// "google/<label>/refresh_token", "google/<label>/client" or, for a label's Drive grant (GD),
// "google/<label>/drive_refresh_token", or for its contacts grant (contacts and identity),
// "google/<label>/contacts_refresh_token".
export function googleSecretName(
  label: string,
  kind: "refresh_token" | "client" | "drive_refresh_token" | "contacts_refresh_token",
): string {
  return `google/${label}/${kind}`;
}

// Held by a sync, nothing is written.
export async function syncLock(query: Query): Promise<void> {
  const [lock] = await query<{ held: boolean }>(TRY_SYNC);
  if (lock?.held !== true) throw new AdminError("sync_running");
}
