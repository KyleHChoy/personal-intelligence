import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  BROWSER_BUNDLES,
  type CallOptions,
  type CaptureItem,
  type CaptureKey,
  type CaptureRefusal,
  type ClientView,
  isAgentHost,
  isSignInHost,
  MOMENT_SOURCE_BUNDLES,
  MULTI_ACCOUNT_SURFACES,
  type PersonalLogger,
  type PushCaptureAck,
  PushCaptureArgs,
  type ReadOutcome,
} from "@intelligence/contracts/personal";
import { canonicalJson } from "@intelligence/personal-core";
import { fingerprint, scopeNormal } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import type { Keys } from "../core/keys.ts";
import { TAINT_SHARED } from "../core/locks.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import { parsed } from "../core/read-tool.ts";
import { sealUnder } from "../core/seal.ts";
import type { ReaderCalls } from "../read/read-db.ts";

// Lens's push_capture: a device's batch into the inbox, through policy.push_capture, in one read
// committed transaction under the shared taint lock, in this order: the token, the client and the
// tool; the arguments; each item's keyed fingerprints; the storage ceiling, once a batch; each item
// sealed under `own`, bound to its inbox row; the function; the ack; the call row. A push reads
// nothing, so it writes no read log row, and its ack says nothing the device does not hold but
// `out_of_scope` and `ceiling`.

export const CAPTURE_CEILING_BYTES = 3 * 1024 * 1024 * 1024;

// The database's size in bytes, for the storage ceiling.
export const DATABASE_SIZE = "select pg_database_size(current_database())::text as bytes";
const PUSH = "select ordinal, outcome, code from policy.push_capture($1, $2, $3::jsonb, $4)";
const ERASED = "select capture_key from policy.capture_erased_since_push($1)";
// The function's own 42501 is answered not_permitted under a savepoint, so the call row is still
// written.
const SAVEPOINT = "savepoint push_call";
const RELEASE = "release savepoint push_call";
const ROLLBACK = "rollback to savepoint push_call";

// The frozen lists of contracts are matched by the `capture_scope` normal form.
const onList = (list: readonly string[], value: string): boolean =>
  list.some((one) => scopeNormal(one) === scopeNormal(value));
export const isBrowserBundle = (bundle: string): boolean => onList(BROWSER_BUNDLES, bundle);
export const isSourceBundle = (bundle: string): boolean => onList(Object.values(MOMENT_SOURCE_BUNDLES), bundle);
export const isMultiAccount = (surface: { bundle?: string; host?: string }): boolean =>
  (surface.bundle !== undefined && onList(MULTI_ACCOUNT_SURFACES.bundles, surface.bundle)) ||
  (surface.host !== undefined && onList(MULTI_ACCOUNT_SURFACES.hosts, surface.host));

export function boxHostOf(value: string | undefined): string | undefined {
  if (value === undefined || !/^https:\/\/[^/@?#]+\/?$/.test(value)) return undefined;
  const url = URL.parse(value);
  if (
    url === null ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname === ""
  )
    return undefined;
  return scopeNormal(url.hostname);
}

export function neverDefault(host: string | undefined, boxHost: string | undefined): boolean {
  if (host === undefined || boxHost === undefined) return true;
  const normal = scopeNormal(host);
  if (!normal.includes(".") || isIP(normal.replace(/^\[|\]$/g, "")) !== 0) return true;
  return isSignInHost(normal) || isAgentHost(normal) || normal === boxHost || normal.endsWith(`.${boxHost}`);
}

// On a multi-account surface the drain then asks the map (capture-drain.ts).
export const defaultAdmits = (
  mode: { deny: boolean; boxHost: string | undefined },
  bundle: string,
  host: string | undefined,
): boolean => mode.deny && isBrowserBundle(bundle) && !neverDefault(host, mode.boxHost);

// One surface of an item for the scope: the keyed fingerprints of its bundle, host and account, and
// whether the bundle is a browser's and the surface a multi-account one; and whether the default
// may never admit it.
type Surface = {
  bundle_fp: string;
  host_fp: string | null;
  account_fp: string | null;
  browser: boolean;
  multi_account: boolean;
  never_default: boolean;
};
// `source_bundle`, whether its bundle is a source's app, which the function cannot tell from the
// bundle's fingerprint.
type Pushed = {
  id: string;
  kind: CaptureItem["kind"];
  source_key_fp: string;
  revision: number;
  content_fp: string;
  body_bytes: number;
  body_enc: unknown;
  surfaces: Surface[];
  source: string | null;
  source_bundle: boolean;
};

function surface(
  keys: Keys,
  boxHost: string | undefined,
  bundle: string,
  host: string | undefined,
  account: string | undefined,
): Surface {
  const scoped = (value: string | undefined): string | null =>
    value === undefined ? null : fingerprint(keys, "capture_scope", value);
  return {
    bundle_fp: fingerprint(keys, "capture_scope", bundle),
    host_fp: scoped(host),
    account_fp: scoped(account),
    browser: isBrowserBundle(bundle),
    multi_account: isMultiAccount({ bundle, ...(host === undefined ? {} : { host }) }),
    never_default: neverDefault(host, boxHost),
  };
}

// A block day has one surface for each block; a forget none.
function surfaces(keys: Keys, boxHost: string | undefined, item: CaptureItem): Surface[] {
  switch (item.kind) {
    case "moment":
      return [
        surface(
          keys,
          boxHost,
          item.app.bundle,
          item.url === undefined ? undefined : new URL(item.url).hostname,
          item.account,
        ),
      ];
    case "meeting":
      return [surface(keys, boxHost, item.app.bundle, item.host, item.account)];
    case "block":
      return item.blocks.map((block) => surface(keys, boxHost, block.app.bundle, block.host, block.account));
    // Nor has a Mac contact or a listing of them.
    case "task":
    case "contact":
    case "contacts":
    case "forget":
      return [];
  }
}

// Steps 3 and 4 for one item: its key's and content's fingerprints and its surfaces, and its JSON
// sealed under `own`, bound to its inbox row and column. The JSON is canonical, so its SHA-256 is
// that of captureBlock(item).
function pushed(keys: Keys, boxHost: string | undefined, item: CaptureItem): Pushed {
  const id = newId("cin");
  const json = canonicalJson(item);
  return {
    id,
    kind: item.kind,
    source_key_fp: fingerprint(keys, "source_id", item.key),
    revision: item.kind === "forget" ? 0 : item.revision,
    content_fp: fingerprint(keys, "content_hash", createHash("sha256").update(json, "utf8").digest("hex")),
    body_bytes: Buffer.byteLength(json, "utf8"),
    body_enc: sealUnder(keys, ["own"], { table: "ledger.capture_inbox", id, column: "body_enc" }, json),
    surfaces: surfaces(keys, boxHost, item),
    source: item.kind === "moment" ? (item.source ?? null) : null,
    source_bundle: item.kind === "moment" && isSourceBundle(item.app.bundle),
  };
}

type Acked = PushCaptureAck["items"][number];
const refused = (item: CaptureItem, code: CaptureRefusal): Acked => ({ key: item.key, outcome: "refused", code });

// Steps 3 to 5, for a batch whose arguments parsed: the ack, or `rate_limited` for the whole batch.
// The function is called for every batch, full or not, so its checks and the call rate always hold;
// at or over the ceiling it refuses each capture item `ceiling` and takes each forget.
async function push(
  ctx: Ctx,
  args: PushCaptureArgs,
  ceilingBytes: number,
  boxHost: string | undefined,
): Promise<ReadOutcome<PushCaptureAck>> {
  const [size] = await ctx.run<{ bytes: string }>(DATABASE_SIZE, []);
  if (size === undefined) throw new Unavailable();
  const full = BigInt(size.bytes) >= BigInt(ceilingBytes);
  let rows: Pushed[];
  try {
    rows = args.items.map((item) => pushed(ctx.keys, boxHost, item));
  } catch {
    throw new Unavailable();
  }
  const session = await ctx.session();
  await ctx.run(SAVEPOINT, []);
  let answer: { ordinal: number | null; outcome: string; code: string | null }[];
  try {
    answer = await ctx.run(PUSH, [session, args.batch, JSON.stringify(rows), full]);
  } catch (error) {
    if (!(error instanceof Unavailable && error.raised && error.sqlstate === "42501")) throw error;
    await ctx.run(ROLLBACK, []);
    return { ok: false, code: "not_permitted" };
  }
  await ctx.run(RELEASE, []);
  if (answer.length === 1 && answer[0]?.ordinal === null && answer[0].outcome === "rate_limited")
    return { ok: false, code: "rate_limited" };
  if (answer.length !== args.items.length) throw new Unavailable();
  const items = answer.map((row, index): Acked => {
    const item = args.items[index];
    if (item === undefined || row.ordinal !== index + 1) throw new Unavailable();
    if (row.outcome === "accepted" || row.outcome === "replayed") return { key: item.key, outcome: row.outcome };
    if (
      row.outcome === "refused" &&
      (row.code === "ceiling" || row.code === "conflict" || row.code === "out_of_order" || row.code === "out_of_scope")
    )
      return refused(item, row.code);
    throw new Unavailable();
  });
  const erased = (await ctx.run<{ capture_key: string }>(ERASED, [session])).map(
    (row) => row.capture_key as CaptureKey,
  );
  return { ok: true, value: { ...(erased.length === 0 ? {} : { erased }), items } };
}

function logPushed(log: PersonalLogger, device: ClientView["id"], ack: PushCaptureAck): void {
  const counts: Record<string, number> = { accepted: 0, replayed: 0 };
  for (const item of ack.items) {
    const name = item.outcome === "refused" ? `refused_${item.code ?? "unknown"}` : item.outcome;
    counts[name] = (counts[name] ?? 0) + 1;
  }
  log.info({ event: "capture_pushed", ids: { device }, counts });
}

// Reader.pushCapture, and Reader.refused's for push_capture, which hands null for `args`.
export async function pushCapture(
  reader: ReaderCalls,
  token: string,
  args: unknown,
  options: CallOptions | undefined,
): Promise<ReadOutcome<PushCaptureAck>> {
  let pushedBy: { log: PersonalLogger; device: ClientView["id"]; ack: PushCaptureAck } | undefined;
  const outcome = await reader.tool(
    token,
    { isolation: "read committed", lock: TAINT_SHARED, signal: options?.signal },
    { name: "push_capture", view: null, parse: () => parsed(PushCaptureArgs.safeParse(args)) },
    async ({ client, ctx: ctxOf }, valid) => {
      const ctx = ctxOf(client);
      const answer = await push(ctx, valid, reader.captureCeilingBytes, reader.boxHost);
      if (answer.ok) pushedBy = { log: ctx.log, device: client.id, ack: answer.value };
      return { outcome: answer, rows: answer.ok ? answer.value.items.length : 0 };
    },
  );
  // Once committed: a push that rolled back logs nothing.
  if (outcome.ok && pushedBy !== undefined) logPushed(pushedBy.log, pushedBy.device, pushedBy.ack);
  return outcome;
}
