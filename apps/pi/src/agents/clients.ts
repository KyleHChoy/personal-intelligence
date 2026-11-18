import {
  ClientName,
  ClientRegistration,
  PersonalReadTool,
  PersonalTool,
  RESTRICTED_PREFIX,
  RoleName,
} from "@intelligence/contracts/personal";
import type { Admin } from "@intelligence/personal-store";
import {
  addCompartmentKey,
  DEFAULT_AGENT_TOOLS,
  DEFAULT_AGENT_VIEWS,
  loadKeys,
  MAX_COMPARTMENTS,
} from "@intelligence/personal-store";
import { quotaChanges } from "../command-args.ts";
import type { Body, CommandContext } from "../command-types.ts";
import type { Env } from "../env.ts";
import { found, refusal } from "../env.ts";
import {
  compartments,
  list,
  parsed,
  print,
  printJson,
  recordEnabled,
  variable,
  withAdmin,
  withNamed,
} from "../owner/owner-kit.ts";
import { ownFlag, warnRestrictedOff } from "../restricted-warning.ts";

// The owner's read quota commands, as pi_admin.
// No tool tells a client its budgets; these tell the owner, in counts only.

// The budgets named replace the client's, the rest are kept. Prints nothing.
export async function clientsQuota(context: CommandContext): Promise<0> {
  const changes = quotaChanges(context.values);
  return withAdmin(context, async (admin) => {
    await admin.clients.setQuota(context.positionals[0] ?? "", changes);
  });
}

// Each client's use of its budgets in the last 24 hours and minute, and its rate_limited calls,
// as one JSON document; or one client's, `not_found` for a name with none.
export async function clientsUsage(context: CommandContext): Promise<0> {
  const name = context.positionals[0];
  return withAdmin(context, async (admin) => {
    const rows = await admin.clients.usage(name);
    if (name !== undefined && rows.length === 0) throw refusal("not_found");
    printJson(context, rows);
  });
}

// Registration, its token and its clearance.
// A client given record writes under `agent:<name>`: its key goes into the key file first, when
// absent, so a run that stopped between the key and the registration is simply run again. A bare
// registration (`also`: `public`) writes under `public` too, so that key is made the same way.
async function agentKey({ env }: CommandContext, name: string, tools: string[], also: string[] = []): Promise<void> {
  if (!tools.includes("record")) return;
  if (!recordEnabled(env)) throw refusal("record_disabled");
  const path = variable(env, "PI_KEY_FILE");
  for (const compartment of [`agent:${name}`, ...also])
    if (!(await loadKeys(path)).compartments.has(compartment)) await addCompartmentKey(path, compartment);
}

// Kind device is refused device_fixed, before the registration is checked and before
// any key is added, whatever else is given: only `pi lens add` makes one. The store's addClient
// refuses it the same way.
export async function clientsAdd(context: CommandContext): Promise<0> {
  if (context.values.kind === "device") throw refusal("device_fixed");
  const registration = await registrationOf(context);
  return withAdmin(context, async (admin) => {
    // The token, once. Only its hash is stored.
    print(context, (await admin.clients.addClient(registration, { shares: context.values.broad === true })).token);
    await withDefaults(context, admin, registration);
    await restrictedOff(context, admin, registration.compartments);
  });
}

// The warning of restricted-warning.ts, for a client now cleared for `own`.
async function restrictedOff(context: CommandContext, admin: Admin, compartments: readonly string[]): Promise<void> {
  if (compartments.includes("own")) warnRestrictedOff(context, compartments, (await admin.restricted.counts()).length);
}

// An agent registered with no --views, --tools or --compartments gets the rest of the owner's
// defaults after its registration: its work unless --no-work, and with --broad two-way sharing with
// the agents that share and the reasoner (with a list named, others are widened to it only by
// `pi clients defaults NAME --broad`). A failure here leaves the registration; that command finishes it.
async function withDefaults(context: CommandContext, admin: Admin, registration: ClientRegistration): Promise<void> {
  const { values } = context;
  if (
    registration.kind === "reasoner" ||
    values.views !== undefined ||
    values.tools !== undefined ||
    values.compartments !== undefined
  )
    return;
  await admin.clients.agentDefaults(registration.name, {
    work: context.values["no-work"] !== true,
    share: context.values.broad === true,
  });
}

// `pi clients defaults NAME [--no-work] [--broad]`: an agent registered before, brought to the
// defaults a new one gets: the default tools added to its own, then its work, and with --broad the
// sharing of an agent registered --broad. Its compartments are otherwise kept: a bare agent stays on
// `public`, and --own (or --isolated), accepted, changes nothing (registrationOf). Never narrows. Prints nothing.
export async function clientsDefaults(context: CommandContext): Promise<0> {
  const name = context.positionals[0] ?? "";
  let current: { tools: string[]; compartments: string[] } | undefined;
  await withAdmin(context, async (admin) => {
    current = (await admin.clients.listClients()).find(
      (client) => client.name === name && client.status === "active" && client.kind === "agent",
    );
  });
  if (current === undefined) throw refusal("not_found");
  const tools = [...new Set([...current.tools, ...defaultAgentTools(context.env, current.compartments)])];
  await agentKey(context, name, tools);
  return withAdmin(context, async (admin) => {
    if (tools.length > current!.tools.length) await admin.clients.setTools(name, tools as PersonalTool[]);
    await admin.clients.agentDefaults(name, {
      work: context.values["no-work"] !== true,
      share: context.values.broad === true,
    });
  });
}

// With no --registration, the registrations waiting, as JSON, and the refusal
// that asks for the fingerprint the consent page shows. Nothing is registered and no code is made.
async function oauthRegistration(context: CommandContext): Promise<string> {
  const named = context.values.registration;
  if (typeof named === "string" && named !== "") return named;
  await withAdmin(context, async (admin) => {
    printJson(context, await admin.clients.pendingRegistrations());
  });
  throw refusal("registration_needed");
}

// `pi oauth approve`: the client registered exactly as `clients add`
// registers it, and in place of its token the one-time approval code the owner types on the
// OAuth consent page, for the registration --registration names alone. Only its hash is stored.
export async function oauthApprove(context: CommandContext): Promise<0> {
  const named = await oauthRegistration(context);
  const registration = await registrationOf(context);
  return withAdmin(context, async (admin) => {
    print(
      context,
      (await admin.clients.approveOAuth(registration, named, { shares: context.values.broad === true })).code,
    );
    await withDefaults(context, admin, registration);
    await restrictedOff(context, admin, registration.compartments);
  });
}

// `pi oauth code`: a new approval code for a client already registered.
export async function oauthCode(context: CommandContext): Promise<0> {
  const named = await oauthRegistration(context);
  return withAdmin(context, async (admin) => {
    print(context, (await admin.clients.oauthCode(context.positionals[0] ?? "", named)).code);
  });
}

// An agent's compartments with --broad: own and its own first, then by name every agent compartment
// the active agents that share hold; never a restricted one. More than the store's cap on a
// clearance (MAX_COMPARTMENTS) is refused too_many_compartments, never cut short.
async function broadAgentCompartments(context: CommandContext, name: string, records: boolean): Promise<string[]> {
  let active: string[] = [];
  await withAdmin(context, async (admin) => {
    active = await admin.clients.sharedCompartments();
  });
  const first = ["own", ...(records ? [`agent:${name}`] : [])];
  const others = [...new Set(active)].filter((one) => !first.includes(one)).sort();
  const all = [...first, ...others];
  if (all.length > MAX_COMPARTMENTS) throw refusal("too_many_compartments");
  return all;
}

// The default tools: the broad list, less the record family when the host has record off, and read
// tools only beside a restricted compartment, which takes no other.
const RECORD_FAMILY: readonly string[] = [
  "record",
  "propose_about_you",
  "import_memory",
  "answer_owner_question",
  "propose_person",
  "close_commitment",
  "reopen_commitment",
];
function defaultAgentTools(env: Env, compartments: string[] | undefined): string[] {
  const records = recordEnabled(env);
  const restricted = (compartments ?? []).some((one) => one.startsWith(RESTRICTED_PREFIX));
  return DEFAULT_AGENT_TOOLS.filter(
    (tool) => (records || !RECORD_FAMILY.includes(tool)) && (!restricted || PersonalReadTool.safeParse(tool).success),
  );
}

// A registration from `clients add`'s flags, checked, with its agent keys made. An agent given no
// views or tools gets the defaults; a reasoner never does. Its compartments when none are named:
// bare, `public` (and `agent:<name>`, which the store adds to a client that records); --own (or
// its old name --isolated), `own`; --broad, `own` and every sharing agent's.
async function registrationOf(context: CommandContext): Promise<ClientRegistration> {
  const { values, positionals } = context;
  const agent = values.kind !== "reasoner";
  const name = positionals[0] ?? "";
  const named = values.compartments === undefined ? undefined : list(values.compartments);
  const tools = list(values.tools, agent ? defaultAgentTools(context.env, named) : undefined);
  const records = tools.includes("record");
  const own = ownFlag(context);
  const bare = agent && named === undefined && !own && values.broad !== true;
  const preset = !agent || own ? ["own"] : bare ? ["public"] : undefined;
  const registration = ClientRegistration.safeParse({
    name: positionals[0],
    runtime: values.runtime ?? "local",
    vendorRetention: values.retention ?? "unknown",
    ...(values.kind === undefined ? {} : { kind: values.kind }),
    compartments: named ?? preset ?? (await broadAgentCompartments(context, name, records)),
    views: list(values.views, agent ? [...DEFAULT_AGENT_VIEWS] : undefined),
    tools,
  });
  if (!registration.success) throw refusal("invalid_registration");
  await agentKey(context, registration.data.name, registration.data.tools, bare ? ["public"] : []);
  return registration.data;
}

// A registered client's tools, replaced; its token is kept. Prints nothing.
export async function clientsSetTools(context: CommandContext): Promise<0> {
  const name = context.positionals[0] ?? "";
  const tools = list(context.values.tools);
  if (!tools.every((tool) => PersonalTool.safeParse(tool).success)) throw refusal("usage");
  // A key is added only for a client that is there to take it: a mistyped or revoked name
  // leaves the key file as it was.
  if (tools.includes("record")) {
    await withAdmin(context, async (admin) => {
      found((await admin.clients.listClients()).some((client) => client.name === name && client.status === "active"));
    });
  }
  await agentKey(context, name, tools);
  return withAdmin(context, async (admin) => {
    await admin.clients.setTools(name, tools as PersonalTool[]);
  });
}

// A client's compartments, widened only (narrowed, it would see an older handoff as the latest and
// leave a declassified copy's readers); token, tools and views kept. Prints nothing.
export async function clientsSetCompartments(context: CommandContext): Promise<0> {
  const given = compartments(list(context.values.compartments));
  const name = context.positionals[0] ?? "";
  return withAdmin(context, async (admin) => {
    const held = (await admin.clients.listClients()).find((client) => client.name === name)?.compartments ?? [];
    await admin.clients.setCompartments(name, given);
    // Warned when `own` is new to it: a client that held it was warned when it was given it.
    if (!held.includes("own")) await restrictedOff(context, admin, given);
  });
}

// A new token for a registered client, printed once. The old one answers unauthorized. A Lens
// device's capture client is refused device_fixed: `pi lens rotate` prints its token, and only
// to a terminal.
export async function clientsRotate(context: CommandContext): Promise<0> {
  const name = context.positionals[0] ?? "";
  return withAdmin(context, async (admin) => {
    if ((await admin.clients.listClients()).some((client) => client.name === name && client.kind === "device")) {
      throw refusal(
        "device_fixed",
        "a Lens device's capture token: run pi lens rotate DEVICE --capture in a terminal (pia on the box)",
      );
    }
    const { token } = await admin.clients.rotateToken(name);
    print(context, token);
    context.log.info({ event: "client_rotated", ids: { client: name } });
  });
}

export async function clientsList(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    // Each active client with what it is served: a count of its tools and whether get_health
    // serves it the measures, with the compartments it lacks for them.
    const access = new Map((await admin.clients.listClientAccess()).map((one) => [one.client, one]));
    printJson(
      context,
      (await admin.clients.listClients()).map((client) => {
        const served = access.get(client.name);
        return served === undefined
          ? client
          : { ...client, access: { tools: served.tools, measures: served.measures, missing: served.missing } };
      }),
    );
  });
}

export async function clientsRevoke(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    found(await admin.clients.revokeClient(context.positionals[0] ?? ""));
  });
}

// `clients webhook set NAME URL`. The address is checked before anything is written: https, a host
// name, no credentials, and a host that resolves to no loopback, private, link-local or
// carrier-grade address (`bad_address`). Prints the client's id, for the wrapper's secret step;
// never an address or a secret.
export const clientsWebhookSet: Body = async (context) => {
  const name = parsed(ClientName, context.positionals[0]);
  const { checkAddress, resolveChecked } = await import("../work/notify.ts");
  const url = checkAddress(context.positionals[1] ?? "");
  if (url === null) throw refusal("bad_address");
  const resolved = await resolveChecked(url.hostname);
  if (resolved === "refused") throw refusal("bad_address");
  if (resolved === "unreachable") throw refusal("unreachable");
  return withAdmin(context, async (admin) => {
    printJson(context, { client: await admin.clients.setWebhook(name, url.href) });
  });
};

export const clientsWebhookRm: Body = async (context) => {
  return withNamed(context, ClientName, async (admin, name) => {
    printJson(context, await admin.clients.removeWebhook(name));
  });
};

// An agent's roles, replaced; `--set ""` clears them. Prints the roles held.
export const clientsRoles: Body = (context) => {
  const given = context.values.set;
  if (typeof given !== "string") throw refusal("usage");
  const roles = given === "" ? [] : list(given).map((role) => parsed(RoleName, role));
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.work.setClientRoles(context.positionals[0] ?? "", roles));
  });
};
