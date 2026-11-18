import type { AdminContext } from "../../core/admin-context.ts";
import { removeWebhook, setWebhook } from "../../work/notices.ts";
import { bound, boundNow, boundQuery, boundTx } from "../admin-bound.ts";
import * as accounts from "./admin-accounts.ts";
import * as clients from "./admin-clients.ts";
import { setQuota, usage } from "./admin-quota.ts";
import * as roots from "./admin-roots.ts";

// The owner's addresses and source accounts, the owner's time zone and the box's status reads
// (admin-accounts.ts), as `Admin.accounts`.
export const accountsAdmin = (context: AdminContext) =>
  bound(context, {
    // The owner's accounts, secrets and the box's reads, in admin-accounts.ts.
    addOwnerAddress: accounts.addOwnerAddress,
    sendAsAliases: accounts.sendAsAliases,
    setTimeZone: accounts.setTimeZone,
    listSourceAccounts: accounts.listSourceAccounts,
    databaseBytes: accounts.databaseBytes,
    inspect: accounts.inspect,
    status: accounts.status,
  });

// Agent clients: registration, OAuth approval, tools, compartments, budgets, tokens and work-notice
// addresses (admin-clients.ts, admin-quota.ts, work/notices.ts), as `Admin.clients`.
export const clientsAdmin = (context: AdminContext) => ({
  ...bound(context, {
    addClient: clients.addClient,
    approveOAuth: clients.approveOAuth,
    // Client registration and tool policy, in admin-clients.ts.
    oauthCode: clients.oauthCode,
    // The OAuth registrations bound to no client yet, newest first, for the owner to match with the
    // consent page's fingerprint.
    pendingRegistrations: clients.pendingRegistrations,
    // The agent compartments of the active agents that share, for `pi clients add NAME --broad`.
    sharedCompartments: clients.sharedCompartments,
    setCompartments: clients.setCompartments,
    agentDefaults: clients.agentDefaults,
    listClients: clients.listClients,
    // What each active client is served: its compartments, a count of its tools, and whether
    // get_health serves it the measures.
    listClientAccess: clients.listClientAccess,
    revokeClient: clients.revokeClient,
    setTools: clients.setTools,
  }),
  ...boundQuery(context, {
    // An active client's read budgets: those given replace the stored ones, the rest are kept. Throws AdminError
    // "not_found" for a revoked or unknown name, "device_fixed" for a Lens device client, and "invalid_argument"
    // for a value outside ClientQuota's bounds.
    setQuota: setQuota,
    // Each client's use of its read budgets in the last 24 hours and minute, and its rate_limited
    // calls, by name; or one client's, none for an unknown name. Counts only.
    usage: usage,
    rotateToken: clients.rotateToken,
  }),
  ...boundNow(context, { setWebhook }),
  ...boundTx(context, { removeWebhook: ({ query, now }, name: string) => removeWebhook(query, name, now) }),
});

// The Drive roots the owner sets (admin-roots.ts), as `Admin.drive`:. A root is a folder id, `my-drive`
// or `shared-with-me`; adding one a label already has is refused with `duplicate_name`. Setting a mode
// and removing a root take the sync lock first and refuse with `sync_running` while a sync holds it,
// and `not_found` for an id that names no root. Setting a mode is also refused with `extract_running`
// while a run holds the extract lock.
export const driveAdmin = (context: AdminContext) => ({
  ...boundQuery(context, { roots: roots.roots }),
  ...boundTx(context, {
    addRoot: roots.addRoot,
    rootValue: roots.rootValue,
    setRootMode: roots.setRootMode,
    removeRoot: roots.removeRoot,
  }),
});

// The box's stored secrets (admin-accounts.ts), as `Admin.secrets`.
export const secretsAdmin = (context: AdminContext) =>
  bound(context, {
    setSecret: accounts.setSecret,
    deleteSecret: accounts.deleteSecret,
    listSecretNames: accounts.listSecretNames,
    updatedAt: accounts.secretUpdatedAt,
    secret: accounts.secret,
  });
