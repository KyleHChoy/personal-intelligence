import { createHash, randomBytes } from "node:crypto";
import type { Timestamp } from "@intelligence/contracts";
import {
  APPROVAL_ALPHABET,
  APPROVAL_LENGTH,
  type ClientId,
  type ClientKind,
  type ClientName,
  ClientRegistration,
  type ClientRuntime,
  type HarnessModeId,
  INTENT_KINDS,
  INTERNAL_STAGES,
  type IntentId,
  isCanaryClient,
  type OpportunityKind,
  type PersonalCompartment,
  PersonalReadTool,
  PersonalRunTool,
  PersonalTool,
  type PersonalView,
  PersonalWorkTool,
  QUOTA_DEFAULTS,
  STAGE_PLAN,
  type VendorRetention,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp, stampOrNull } from "../../core/db.ts";
import { newId } from "../../core/ids.ts";
import { grantDecision } from "../../core/owner-decision.ts";
import { fingerprintText, registrationFingerprint } from "../../read/oauth.ts";
import { removeWebhook } from "../../work/notices.ts";
import { capped, newToken, rotated } from "../admin-base.ts";
import { unrestrictedOf } from "../admin-time-base.ts";
import { quotaValues } from "./admin-quota.ts";
import { type ClientAccess, clientAccess } from "./client-access.ts";

// The admin's clients, run as pi_admin: which tools a registration may list and which an agent is
// given by default, a client registered and its OAuth approval codes, its tools and compartments
// set, an agent brought to the owner's defaults, the list and the revocation, and the agent source
// account a client with record writes under.

// request_research is in the contracts before anything serves it, so a registration that lists
// it is refused "not_built".
const RESEARCH_TOOL: PersonalTool = "request_research";

// A registered client. Never a token or a token hash.
const isReadTool = (tool: PersonalTool): tool is PersonalReadTool => PersonalReadTool.safeParse(tool).success;

// Work tools are an agent's and run tools the reasoner's (the contracts keep each set to its kind).
const isWorkTool = (tool: PersonalTool): boolean => PersonalWorkTool.safeParse(tool).success;
const isRunTool = (tool: PersonalTool): boolean => PersonalRunTool.safeParse(tool).success;
// request_research is let through here and refused "not_built" after every other check, since
// nothing serves it yet (a reasoner's registration already refuses it).
// propose_about_you, import_memory, propose_person, close_commitment and reopen_commitment write
// on the agent lane under `agent:<name>`, which record sets up (its key, its compartment and its
// source account), so each is served only beside record. answer_owner_question writes there too,
// and reports the question's move done through report_move, so it is served only beside both.
const servedTools = (tools: PersonalTool[], kind: ClientRegistration["kind"]): boolean =>
  (kind ?? "agent") === "agent"
    ? tools.every(
        (tool) =>
          tool === "record" ||
          ((tool === "propose_about_you" ||
            tool === "import_memory" ||
            tool === "propose_person" ||
            tool === "close_commitment" ||
            tool === "reopen_commitment") &&
            tools.includes("record")) ||
          (tool === "answer_owner_question" && tools.includes("record") && tools.includes("report_move")) ||
          tool === RESEARCH_TOOL ||
          isReadTool(tool) ||
          isWorkTool(tool),
      )
    : tools.every((tool) => isReadTool(tool) || isRunTool(tool));

// The read tools no registration may list: those with nothing behind them yet, and Lens's
// sync_mirror, which is built and is on this list because it is device-only, not because it is
// unbuilt: it is a device's mirror client's alone, so no other registration may list it, and no
// agent is given it by default (DEFAULT_AGENT_TOOLS). `addDevice` (lens-admin.ts) registers a
// device's mirror client with it, without this check, and setTools keeps it for that client. The
// read log's, the read quota's and the other generic read tests leave it out by this list; its own
// are mirror-sync.db.test.ts's and mirror-gate.db.test.ts's.
export const UNBUILT_READ_TOOLS = [
  "get_decision_history",
  "sync_mirror",
] as const satisfies readonly PersonalReadTool[];
export type UnbuiltReadTool = (typeof UNBUILT_READ_TOOLS)[number];
export const isUnbuiltRead = (tool: PersonalTool): tool is UnbuiltReadTool =>
  (UNBUILT_READ_TOOLS as readonly string[]).includes(tool);
// Agents get broad access at provisioning: what `clients add` gives an agent when the owner names
// no tools or views is every served read tool, every work tool, record and the tools served beside
// it; never a run tool, never request_research until it is built. The owner narrows with flags.
// Every stage an agent may be cleared for, as [kind, stage]: each kind's planned
// stages that are internal. From STAGE_PLAN, so a new kind or stage needs no list kept by hand.
export const AGENT_STAGES: readonly (readonly [OpportunityKind, (typeof INTERNAL_STAGES)[number]])[] = Object.entries(
  STAGE_PLAN,
).flatMap(([kind, stages]) =>
  stages.filter((stage) => INTERNAL_STAGES.includes(stage)).map((stage) => [kind as OpportunityKind, stage] as const),
);

// What agentDefaults added: harness grants, intents, and clients whose compartments it widened.
type AgentDefaults = { grants: number; intents: number; shared: number };

export const DEFAULT_AGENT_VIEWS = ["self", "people", "work"] as const;
// propose_goal_target is the owner's to give, with `pia clients set-tools`.
export const DEFAULT_AGENT_TOOLS: readonly PersonalTool[] = PersonalTool.options.filter(
  (tool) =>
    (isReadTool(tool) && !isUnbuiltRead(tool)) ||
    // Each only a registration that names it holds: the owner gives propose_goal_target, record_spend
    // writes against the day's budget, the outcome test's are its one client's, and list_ideas, a
    // read of the idea ledger, is the owner's to give.
    (isWorkTool(tool) &&
      tool !== "propose_goal_target" &&
      tool !== "list_ideas" &&
      tool !== "record_spend" &&
      tool !== "start_outcome_test" &&
      tool !== "record_held_out_question" &&
      tool !== "record_outcome_task") ||
    tool === "record" ||
    tool === "propose_about_you" ||
    tool === "import_memory" ||
    tool === "answer_owner_question" ||
    tool === "propose_person" ||
    tool === "close_commitment" ||
    tool === "reopen_commitment",
);

// Only read tools can be unbuilt. A Lens device's mirror client that holds sync_mirror keeps it;
// every other client is refused it.
const unbuilt = (tools: PersonalTool[], mirror = false): boolean =>
  tools.some((tool) => isUnbuiltRead(tool) && !(mirror && tool === "sync_mirror"));
// Vendor retention gates nothing.
const memoryForReasoner = (tools: PersonalTool[], kind: ClientRegistration["kind"]): boolean =>
  kind === "reasoner" && tools.includes("sync_memory");

// A new token, as every registration and rotation makes one: returned once, stored only as the hex
// SHA-256 of its UTF-8 bytes. An approval code: 12 characters of Crockford's base32 from 60 random
// bits, shown in three groups of four, and the hash of the 12 characters, which alone is stored.
export function approvalCode(): { code: string; hash: string } {
  const code = [...randomBytes(APPROVAL_LENGTH)].map((byte) => APPROVAL_ALPHABET[byte & 31] ?? "").join("");
  return {
    code: code.match(/.{4}/g)?.join("-") ?? code,
    hash: createHash("sha256").update(code, "utf8").digest("hex"),
  };
}

export type ClientRow = {
  id: ClientId;
  name: ClientName;
  kind: ClientKind;
  status: "active" | "revoked";
  runtime: ClientRuntime;
  vendorRetention: VendorRetention;
  compartments: PersonalCompartment[];
  views: PersonalView[];
  tools: PersonalTool[];
  // The roles the owner gave it.
  roles: string[];
  // Whether it has a work-notice address; never the address or its secret.
  webhook: boolean;
  createdAt: Timestamp;
  revokedAt: Timestamp | null;
  lastCallAt: Timestamp | null;
};

export type StoredClient = {
  id: string;
  name: string;
  kind: ClientKind;
  status: "active" | "revoked";
  runtime: ClientRuntime;
  vendor_retention: VendorRetention;
  compartments: PersonalCompartment[];
  views: PersonalView[];
  tools: PersonalTool[];
  roles?: string[];
  webhook: boolean;
  created_at: Date;
  revoked_at: Date | null;
  last_call_at: Date | null;
};

// Never the token hash.
export const CLIENTS = `
  select c.id, c.name, c.kind, c.status, c.runtime, c.vendor_retention, c.compartments, c.views, c.tools, c.roles, c.created_at, c.revoked_at,
    exists (select 1 from policy.client_webhooks w where w.client_id = c.id) as webhook,
    (select max(k.at) from policy.calls k where k.client_id = c.id) as last_call_at
  from policy.clients c order by c.name collate "C"`;

// An OAuth registration not yet bound to a client, as `pi oauth approve` lists it for the owner
// to match with the consent page: its fingerprint, the name it gave itself and where it returns.
type PendingRegistration = {
  fingerprint: string;
  clientName: string | null;
  redirectHosts: string[];
  createdAt: Timestamp;
};

// Newest first. At most 100 are held.
export async function pendingRegistrations(admin: AdminContext): Promise<PendingRegistration[]> {
  const rows = await admin.transaction((query) =>
    query<{ id: string; client_name: string | null; redirect_uris: string[]; created_at: Date }>(
      "select id, client_name, redirect_uris, created_at from policy.oauth_registrations where client_id is null order by created_at desc, id",
    ),
  );
  return rows.map((row) => ({
    fingerprint: registrationFingerprint(row.id),
    clientName: row.client_name,
    redirectHosts: [...new Set(row.redirect_uris.map((uri) => new URL(uri).hostname))].sort(),
    createdAt: stamp(row.created_at),
  }));
}

// The one registration held whose fingerprint is `typed`. Throws AdminError "unknown_registration"
// for text that is no fingerprint, and for none or more than one match: the owner then starts the
// flow again, which makes a registration of its own.
async function registrationNamed(query: Query, typed: string): Promise<string> {
  const wanted = fingerprintText(typed);
  if (wanted === null) throw new AdminError("unknown_registration");
  const ids = (await query<{ id: string }>("select id from policy.oauth_registrations order by id")).map(
    (row) => row.id,
  );
  const matched = ids.filter((id) => registrationFingerprint(id) === wanted);
  if (matched.length !== 1) throw new AdminError("unknown_registration");
  return matched[0] as string;
}

// An agent marked as one that shares (policy.clients.shares): an agent registered `--broad`.
export async function markShares(query: Query, client: string): Promise<void> {
  await query("update policy.clients set shares = true where id = $1 and kind = 'agent'", [client]);
}

// The approval code for `client`, valid for the registration `typed` names alone.
export async function insertApproval(query: Query, client: string, typed: string, hash: string): Promise<void> {
  const registration = await registrationNamed(query, typed);
  await query("insert into policy.oauth_approvals (code_hash, client_id, registration) values ($1, $2, $3)", [
    hash,
    client,
    registration,
  ]);
}

// `pi oauth code`: a new one-time approval code for a client already registered and active, so a
// flow that failed or lapsed does not cost the client its name, valid for the one registration the
// owner names. Throws AdminError "not_found" for a revoked or unknown name, "device_fixed" for
// either client of a Lens device: neither is ever given an OAuth token, and "unknown_registration"
// as registrationNamed does.
export async function oauthCode(admin: AdminContext, name: string, registration: string): Promise<{ code: string }> {
  const { code, hash } = approvalCode();
  const answer = await admin.transaction(async (query) => {
    const [row] = await query<{ id: string; device: boolean }>(
      `select c.id, (c.kind = 'device' or exists (select 1 from policy.lens_devices d where c.id in (d.capture_client_id, d.mirror_client_id))) as device
       from policy.clients c where c.name = $1 and c.status = 'active' for update of c`,
      [name],
    );
    if (row === undefined) return "not_found" as const;
    if (row.device) return "device_fixed" as const;
    await insertApproval(query, row.id, registration, hash);
    return "ok" as const;
  });
  if (answer !== "ok") throw new AdminError(answer);
  return { code };
}

export async function register(
  admin: AdminContext,
  registration: ClientRegistration,
  also?: (query: Query, client: string) => Promise<void>,
): Promise<string> {
  if (registration.kind === "device") throw new AdminError("device_fixed");
  const parsed = ClientRegistration.safeParse(registration);
  if (parsed.success && unbuilt(parsed.data.tools)) throw new AdminError("not_built");
  if (
    !parsed.success ||
    !servedTools(parsed.data.tools, parsed.data.kind) ||
    memoryForReasoner(parsed.data.tools, parsed.data.kind)
  )
    throw new AdminError("invalid_registration");
  const { name, runtime, vendorRetention, views, tools } = parsed.data;
  const kind = parsed.data.kind ?? "agent";
  // The read budgets given, or the kind's defaults.
  const quota = parsed.data.quota ?? QUOTA_DEFAULTS[kind];
  const compartments = labelled(admin, name, parsed.data.compartments, tools);
  if (tools.includes(RESEARCH_TOOL)) throw new AdminError("not_built");
  const { token, hash } = newToken();
  const created = admin.now();
  await admin.transaction(async (query) => {
    if (
      kind === "reasoner" &&
      (await query("select 1 from policy.clients where kind = 'reasoner' and status = 'active'")).length > 0
    )
      throw new AdminError("invalid_registration");
    const inserted = await query(
      `insert into policy.clients (id, name, token_hash, vendor_retention, runtime, compartments, views, tools, created_at, kind,
         max_items_day, max_chars_day, max_rows_day, max_calls_minute)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (name) do nothing returning id`,
      [
        newId("cli"),
        name,
        hash,
        vendorRetention,
        runtime,
        compartments,
        views,
        tools,
        stamp(created),
        kind,
        ...quotaValues(quota),
      ],
    );
    if (inserted.length === 0) throw new AdminError("duplicate_name");
    if (tools.includes("record")) await agentAccount(query, name);
    // A reasoner's compartments change by nothing else (setTools keeps them).
    const [client] = inserted as { id: string }[];
    if (kind === "reasoner" && client !== undefined) {
      const granted = [...new Set(compartments)].sort();
      await grantDecision(
        query,
        { kind: "combining_grant", target: { kind: "client", id: client.id }, details: { compartments: granted } },
        created,
      );
    }
    if (also !== undefined && client !== undefined) await also(query, client.id);
  });
  return token;
}

// An active client's tools, validated as a registration's are; its token is not touched. Adding
// record does what addClient does, the same checks included; removing it leaves the compartment and
// the account. A Lens device's mirror client takes read tools alone, with sync_mirror: it writes
// nothing. Throws AdminError "not_found" for a revoked or unknown name, "device_fixed" for a Lens
// device client and for a write or work tool given to a device's mirror client, and the codes
// addClient throws for its checks.
export function setTools(admin: AdminContext, name: string, tools: PersonalTool[]): Promise<void> {
  return admin.transaction(async (query) => {
    const [row] = await query<StoredClient & { mirror: boolean; lens: boolean }>(
      `select c.kind, c.runtime, c.vendor_retention, c.compartments, c.views,
         ('sync_mirror' = any (c.tools) and exists (select 1 from policy.lens_devices d where d.mirror_client_id = c.id)) as mirror,
         exists (select 1 from policy.lens_devices d where d.mirror_client_id = c.id) as lens
       from policy.clients c where c.name = $1 and c.status = 'active' for update of c`,
      [name],
    );
    if (row === undefined) throw new AdminError("not_found");
    if (row.kind === "device") throw new AdminError("device_fixed");
    if (row.lens && !tools.every((tool) => PersonalReadTool.safeParse(tool).success))
      throw new AdminError("device_fixed");
    // Checked under the client's own kind, so a reasoner keeps a reasoner's limits.
    const parsed = ClientRegistration.safeParse({
      name,
      runtime: row.runtime,
      vendorRetention: row.vendor_retention,
      kind: row.kind,
      compartments: row.compartments,
      views: row.views,
      tools,
    });
    if (parsed.success && unbuilt(parsed.data.tools, row.mirror)) throw new AdminError("not_built");
    if (!parsed.success || !servedTools(parsed.data.tools, row.kind) || memoryForReasoner(parsed.data.tools, row.kind))
      throw new AdminError("invalid_registration");
    const compartments = labelled(admin, name, row.compartments, parsed.data.tools);
    if (parsed.data.tools.includes(RESEARCH_TOOL)) throw new AdminError("not_built");
    await query("update policy.clients set tools = $2, compartments = $3 where name = $1", [
      name,
      parsed.data.tools,
      compartments,
    ]);
    if (parsed.data.tools.includes("record")) await agentAccount(query, name);
  });
}

// `pi clients set-compartments`: an active client's compartments, replaced by a set that keeps every one it holds, so a registration still
// never narrows in place. Narrowing stays refused because two records are read from the clearance a client holds now, as if it had always
// held it: the latest handoff a pack serves, and the list of clients that may have read a declassified copy. Revoking and registering a new
// name keeps both true. Checked as a registration's are, each one a compartment the key file holds; a change is the owner's combining_grant
// decision in the same transaction, and the same set writes nothing. Its token, tools and views are kept. Throws AdminError "not_found" for
// a revoked or unknown name, "device_fixed" for a Lens device client, "would_narrow", "invalid_registration", "unknown_compartment" or
// "too_many_compartments".
export function setCompartments(admin: AdminContext, name: string, compartments: string[]): Promise<void> {
  return admin.transaction(async (query) => {
    const [row] = await query<StoredClient>(
      "select id, kind, runtime, vendor_retention, compartments, views, tools from policy.clients where name = $1 and status = 'active' for update",
      [name],
    );
    if (row === undefined) throw new AdminError("not_found");
    if (row.kind === "device") throw new AdminError("device_fixed");
    const parsed = ClientRegistration.safeParse({
      name,
      runtime: row.runtime,
      vendorRetention: row.vendor_retention,
      kind: row.kind,
      compartments,
      views: row.views,
      tools: row.tools,
    });
    if (!parsed.success) throw new AdminError("invalid_registration");
    const wanted = capped([...new Set(parsed.data.compartments)].sort());
    if (!row.compartments.every((held) => wanted.includes(held))) throw new AdminError("would_narrow");
    if (!wanted.every((compartment) => admin.keys.compartments.has(compartment)))
      throw new AdminError("unknown_compartment");
    if (wanted.length === new Set(row.compartments).size) return;
    await query("update policy.clients set compartments = $2 where id = $1", [row.id, wanted]);
    await grantDecision(
      query,
      {
        kind: "combining_grant",
        target: { kind: "client", id: row.id },
        details: { compartments: wanted },
      },
      admin.now(),
    );
  });
}

// An agent brought to the owner's defaults in one transaction, only ever adding. `work`: a
// harness grant for every stage an agent may be cleared for (AGENT_STAGES) and a goal-free intent
// over every kind an intent may list (INTENT_KINDS), each when the agent has none; `share`: the
// agent is marked as one that shares (policy.clients.shares), its own agent compartment is added
// to every other active agent that shares and to the reasoner, and theirs to it, each change a
// combining_grant. An agent registered with an explicit list, or bare, shares with no one and is
// never widened here. Counts what it added. Throws AdminError "not_found" for a name that is no
// active agent, and what a registration's compartments throw.
export function agentDefaults(
  admin: AdminContext,
  name: string,
  options: { work: boolean; share: boolean },
): Promise<AgentDefaults> {
  return admin.transaction(async (query) => {
    const fields = "id, name, kind, runtime, vendor_retention, compartments, views, tools";
    const [row] = await query<StoredClient>(
      `select ${fields} from policy.clients where name = $1 and status = 'active' and kind = 'agent' for update`,
      [name],
    );
    if (row === undefined) throw new AdminError("not_found");
    const now = admin.now();
    const added: AgentDefaults = { grants: 0, intents: 0, shared: 0 };
    if (options.work) {
      const held = await query<{ opportunity_kind: string; stage: string }>(
        "select opportunity_kind, stage from policy.harness_modes where client_id = $1 and revoked_at is null and mode = 'act'",
        [row.id],
      );
      for (const [kind, stage] of AGENT_STAGES) {
        if (held.some((one) => one.opportunity_kind === kind && one.stage === stage)) continue;
        const id = newId("hrn") as HarnessModeId;
        await grantDecision(query, { kind: "harness_grant", target: { kind: "harness_mode", id } }, now);
        await query(
          "insert into policy.harness_modes (id, client_id, opportunity_kind, stage, mode, granted_at) values ($1, $2, $3, $4, 'act', $5)",
          [id, row.id, kind, stage, stamp(now)],
        );
        added.grants += 1;
      }
      const kinds = [...INTENT_KINDS];
      const covered = await query(
        "select 1 from policy.intents where $1 = any (client_ids) and goal_id is null and revoked_at is null and confirmed_at is not null and opportunity_kinds @> $2::text[]",
        [row.id, kinds],
      );
      if (covered.length === 0) {
        const id = newId("int") as IntentId;
        await grantDecision(query, { kind: "intent_confirm", target: { kind: "intent", id } }, now);
        await query(
          "insert into policy.intents (id, goal_id, opportunity_kinds, client_ids, mode, max_open, confirmed_at) values ($1, null, $2, $3, 'owner_decides', 5, $4)",
          [id, kinds, [row.id], stamp(now)],
        );
        added.intents = 1;
      }
    }
    if (options.share) {
      await markShares(query, row.id);
      const others = await query<StoredClient>(
        `select ${fields} from policy.clients
         where status = 'active' and (kind = 'reasoner' or (kind = 'agent' and shares)) and id <> $1 order by name for update`,
        [row.id],
      );
      // A client's compartments widened to `wanted`, checked as setCompartments checks them.
      const widen = async (client: StoredClient, wanted: string[]): Promise<void> => {
        const parsed = ClientRegistration.safeParse({
          name: client.name,
          runtime: client.runtime,
          vendorRetention: client.vendor_retention,
          kind: client.kind,
          compartments: wanted,
          views: client.views,
          tools: client.tools,
        });
        if (!parsed.success) throw new AdminError("invalid_registration");
        const sorted = capped([...new Set(parsed.data.compartments)].sort());
        if (!sorted.every((compartment) => admin.keys.compartments.has(compartment)))
          throw new AdminError("unknown_compartment");
        if (sorted.length === new Set(client.compartments).size) return;
        await query("update policy.clients set compartments = $2 where id = $1", [client.id, sorted]);
        await grantDecision(
          query,
          {
            kind: "combining_grant",
            target: { kind: "client", id: client.id },
            details: { compartments: sorted },
          },
          now,
        );
        added.shared += 1;
      };
      const own = `agent:${name}`;
      if (row.compartments.includes(own)) {
        for (const other of others) await widen(other, [...other.compartments, own]);
      }
      const theirs = others
        .filter((other) => other.kind === "agent")
        .flatMap((other) => other.compartments.filter((compartment) => compartment.startsWith("agent:")));
      await widen(row, [...row.compartments, ...theirs]);
    }
    return added;
  });
}

// A client's compartments: with record, `agent:<name>` is added when absent, the deployment
// must allow record, and the keys must hold every compartment of the label it will write
// under, or the client could read and never record.
function labelled(admin: AdminContext, name: string, compartments: string[], tools: PersonalTool[]): string[] {
  if (!tools.includes("record")) return capped(compartments);
  if (admin.recordEnabled !== true) throw new AdminError("record_disabled");
  const own = `agent:${name}`;
  const label = compartments.includes(own) ? compartments : [...compartments, own];
  if (!label.every((compartment) => admin.keys.compartments.has(compartment)))
    throw new AdminError("unknown_compartment");
  return capped(label);
}

// The agent compartments of every active agent that shares, sorted: what `pi clients add NAME
// --broad` clears a new agent for beside `own` and its own.
export async function sharedCompartments(admin: AdminContext): Promise<string[]> {
  const rows = await admin.transaction((query) =>
    query<{ compartment: string }>(
      `select distinct c.compartment from policy.clients k, unnest(k.compartments) as c (compartment)
       where k.status = 'active' and k.kind = 'agent' and k.shares and starts_with(c.compartment, 'agent:')
       order by 1`,
    ),
  );
  return rows.map((row) => row.compartment);
}

// By name.
export async function listClients(admin: AdminContext): Promise<ClientRow[]> {
  const rows = await admin.transaction((query) => query<StoredClient>(CLIENTS));
  return rows.map((row) => ({
    id: row.id as ClientId,
    name: row.name,
    kind: row.kind,
    status: row.status,
    runtime: row.runtime,
    vendorRetention: row.vendor_retention,
    compartments: row.compartments,
    views: row.views,
    tools: row.tools,
    roles: row.roles ?? [],
    webhook: row.webhook,
    createdAt: stamp(row.created_at),
    revokedAt: stampOrNull(row.revoked_at),
    lastCallAt: stampOrNull(row.last_call_at),
  }));
}

// Each active client's compartments, count of tools and whether it is served the measures
// (client-access.ts), by name.
export async function listClientAccess(admin: AdminContext): Promise<ClientAccess[]> {
  const rows = await admin.transaction((query) => query<StoredClient>(CLIENTS));
  return clientAccess(rows, unrestrictedOf(admin.keys));
}

// False for an unknown name. A client already revoked stays as it was. Its work-notice address
// goes with it, in the same transaction.
export function revokeClient(admin: AdminContext, name: string): Promise<boolean> {
  return admin.transaction(async (query) => {
    const revoked = await query(
      "update policy.clients set status = 'revoked', revoked_at = $2 where name = $1 and status = 'active' returning id",
      [name, stamp(admin.now())],
    );
    if (revoked.length > 0) await removeWebhook(query, name, admin.now(), { revoked: true });
    // Parked work outlives no client: its leases lapse, and the tick returns the work to the board.
    for (const row of revoked as { id: string }[]) await query("select ledger.lapse_client_leases($1)", [row.id]);
    if (revoked.length > 0) return true;
    return (await query("select id from policy.clients where name = $1", [name])).length > 0;
  });
}

// A client's agent source account: its label `agent:<name>`, which no Google label can equal, its
// one compartment, and no address. Made once.
async function agentAccount(query: Query, name: string): Promise<void> {
  const label = `agent:${name}`;
  await query(
    `insert into vault.source_accounts (id, label, connector, source_kind, compartments, address_fp, address_enc)
     values ($1, $2, 'agent', 'agent_record', $3, null, null)
     on conflict (label, connector) do nothing`,
    [newId("acc"), label, [label]],
  );
}

// The token is returned once and stored only as the hex SHA-256 of its UTF-8 bytes. A client with
// record also holds `agent:<name>` and has its agent source account, made in the same transaction.
// Its kind is stored, and a second active reasoner is refused. Throws AdminError with code
// "invalid_registration", "duplicate_name", "record_disabled", "unknown_compartment" or
// "too_many_compartments", and "not_built" for request_research after the checks. Kind device is
// "device_fixed": only addDevice makes one. `shares`: an agent registered `--broad`, which takes
// part in agents' sharing (policy.clients.shares, agentDefaults).
export async function addClient(
  admin: AdminContext,
  registration: ClientRegistration,
  options: { shares?: boolean } = {},
): Promise<{ token: string }> {
  // A `canary-` name is the standing check's, whose compartments the owner's reads leave out.
  if (isCanaryClient(registration.name)) throw new AdminError("invalid_registration");
  return { token: await register(admin, registration, options.shares === true ? markShares : undefined) };
}

// `pi oauth approve`: the client registered exactly as addClient does, the same checks and refusals,
// and in the same transaction its one-time approval code, stored only as its hash, valid ten minutes
// and only for the OAuth registration whose fingerprint `oauthRegistration` names. The client's own
// token is made and never returned, so the client is reached only through the OAuth tokens the code
// leads to. Returns the code in three groups of four. Throws, besides addClient's codes,
// "unknown_registration" when the fingerprint names no registration held, or more than one; nothing
// is registered then.
export async function approveOAuth(
  admin: AdminContext,
  registration: ClientRegistration,
  oauthRegistration: string,
  options: { shares?: boolean } = {},
): Promise<{ code: string }> {
  // A `canary-` name is the standing check's, as in addClient.
  if (isCanaryClient(registration.name)) throw new AdminError("invalid_registration");
  const { code, hash } = approvalCode();
  await register(admin, registration, async (query, client) => {
    await insertApproval(query, client, oauthRegistration, hash);
    if (options.shares === true) await markShares(query, client);
  });
  return { code };
}

// A new token for an active client, in place of its old one: nothing else of the row changes, so its
// id, compartments, agent records and audience stay its own. Throws AdminError "not_found" for a
// revoked or unknown name.
export async function rotateToken(query: Query, name: string): Promise<{ token: string }> {
  const token = await rotated(query, name);
  if (token === null) throw new AdminError("not_found");
  return { token };
}

// An active agent's work-notice address, checked by the caller, and its removal; each the owner's
// decision. Throws `not_found` for a name that is no such client.
