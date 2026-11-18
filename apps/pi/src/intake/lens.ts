import { createInterface } from "node:readline";
import { DateOnly } from "@intelligence/contracts";
import {
  AGENT_HOSTS,
  CaptureAccountId,
  CaptureExcludeId,
  type CaptureScopeRule,
  CaptureScopeRuleId,
  ClientName,
  isCoded,
  MomentSource,
  PersonalCompartment,
  PersonalView,
  SIGN_IN_HOST_WORDS,
  SIGN_IN_WORDS,
} from "@intelligence/contracts/personal";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";
import { print, printJson, withAdmin } from "../owner/owner-kit.ts";

// `pi lens add`, `list`, `rotate` and `revoke`, and `pi lens scope add`, `list` and `remove` on the
// store's admin functions, as pi_admin. `add` and `rotate` print tokens, and `run` lets them print
// only to a terminal; `scope list --show` prints values, to a terminal only.

type Value = CommandContext["values"][string];

// A comma-separated list of names of the schema's form, or the default when the option is absent.
// Anything else is a usage error, before any connection.
function namesOf<T extends string>(
  value: Value,
  fallback: T[],
  schema: { safeParse(value: unknown): { success: boolean } },
): T[] {
  if (value === undefined) return fallback;
  const entries = typeof value === "string" ? value.split(",") : [];
  if (entries.length === 0 || !entries.every((entry) => schema.safeParse(entry).success)) throw refusal("usage");
  return entries as T[];
}

function deviceName(context: CommandContext): string {
  const name = context.positionals[0];
  if (!ClientName.safeParse(name).success) throw refusal("usage");
  return name as string;
}

// The capture token, once, as one JSON line, `{"capture":"pit_..."}`. Only its hash
// is stored. The mirror client is registered with no token anyone holds; `pi lens rotate NAME
// --mirror` gives it its first, so no mirror token is live before the owner asks for one.
export async function lensAdd(context: CommandContext): Promise<0> {
  const name = deviceName(context);
  const compartments = namesOf<PersonalCompartment>(context.values.compartments, ["own"], PersonalCompartment);
  const views = namesOf<PersonalView>(context.values.views, ["self", "people", "work"], PersonalView);
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.lens.addDevice(name, { compartments, views }));
  });
}

// Each device as LensDeviceView, one JSON document.
export async function lensList(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.lens.devices());
  });
}

// One channel's new token, printed once. The old one answers unauthorized.
export async function lensRotate(context: CommandContext): Promise<0> {
  const name = deviceName(context);
  const channel = context.values.capture === true ? "capture" : "mirror";
  return withAdmin(context, async (admin) => {
    print(context, await admin.lens.rotateDevice(name, channel));
  });
}

// Both clients revoked in one transaction. Prints nothing.
export async function lensRevoke(context: CommandContext): Promise<0> {
  const name = deviceName(context);
  return withAdmin(context, async (admin) => {
    await admin.lens.revokeDevice(name);
  });
}

// Work time: `pi lens tasks NAME on|off`, the device's switch for its
// task items, off by default. Prints nothing; `not_found` for no such device.
export async function lensTasks(context: CommandContext): Promise<0> {
  const name = deviceName(context);
  const state = context.positionals[1];
  if (state !== "on" && state !== "off") throw refusal("usage");
  return withAdmin(context, async (admin) => {
    await admin.lens.setDeviceTasks(name, state === "on");
  });
}

// `pi lens contacts NAME [on|off]`, the device's switch for the Mac
// contacts Lens sends, off by default. Prints the device's MacContactsView (counts and codes
// only) as one JSON document, after the change when one is given. `off` asks nothing and removes
// every Mac contact of the device; each logs `mac_contacts_switched` (`off` with the count removed) and, in a terminal, says the Mac's step.
// `not_found` for no such device, `sync_running` for `off` while a sync runs.
const MAC_CONTACTS_NEXT = {
  on: "Lens sends the Mac contacts again at its next weekly revisions, or at once with Send again in its Settings",
  off: "Turn off sending contacts in Lens's Settings on the Mac too, or Lens sends them again",
} as const;

export async function lensContacts(context: CommandContext): Promise<0> {
  const name = deviceName(context);
  const state = context.positionals[1];
  if (state !== undefined && state !== "on" && state !== "off") throw refusal("usage");
  return withAdmin(context, async (admin) => {
    if (state !== undefined) {
      const { removed } = await admin.lens.setDeviceContacts(name, state === "on");
      // stderr is JSON lines only. The owner's next step on the Mac follows the JSON on stdout,
      // and only in a terminal, so a script still reads one JSON document.
      context.log.info(
        state === "on"
          ? { event: "mac_contacts_switched", code: "on" }
          : { event: "mac_contacts_switched", code: "off", counts: { removed } },
      );
    }
    printJson(context, await admin.lens.deviceContacts(name));
    if (state !== undefined && context.io.stdoutIsTTY) context.io.stdout.write(`${MAC_CONTACTS_NEXT[state]}\n`);
  });
}

// `pi lens backfill vouch NAME`, the owner's one vouch for the device's
// first backfill of source moments. Prints the window and how many stored moments it vouched,
// as one JSON document; `already_settled` the second time, and
// `not_found` for no such device or none pushed yet.
export async function lensBackfillVouch(context: CommandContext): Promise<0> {
  const name = deviceName(context);
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.lens.vouchBackfill(name));
  });
}

type ScopeKind = CaptureScopeRule["kinds"][number];
const SCOPE_KINDS: ScopeKind[] = ["meeting", "moment", "block"];
const AGENT_APP_KINDS: ScopeKind[] = ["moment", "block"];

// One rule, a bundle id or a host, for a compartment and the kinds given (all three
// by default). The store checks the value's form and the compartment, and refuses
// `account_required` and `browser_bundle`, printed as their codes. Prints the rule's id.
// `--agent-app` marks the rule an agent app's, its kinds moment and block by default and
// never meeting (`agent_app_meeting`); `--client NAME`, only with it, names the agent client that
// runs in the app, whose clearance labels its moments (`not_found` for no active agent of that
// name). `--source imessage` marks a source rule, admitting that
// source's moments alone: a bundle rule, of kind moment (the default with it), with no account and
// not `--agent-app`; anything else with it is a usage error, and a bundle that is not the source's
// app is refused `source_bundle`.
export async function lensScopeAdd(context: CommandContext): Promise<0> {
  const { bundle, host, account, compartment, kinds, client, source } = context.values;
  const agentApp = context.values["agent-app"] === true;
  if ((typeof bundle === "string") === (typeof host === "string")) throw refusal("usage");
  if (
    source !== undefined &&
    (!MomentSource.safeParse(source).success || typeof bundle !== "string" || agentApp || account !== undefined)
  )
    throw refusal("usage");
  if (account !== undefined && typeof account !== "string") throw refusal("usage");
  if (!PersonalCompartment.safeParse(compartment).success) throw refusal("usage");
  if (client !== undefined && (!agentApp || !ClientName.safeParse(client).success)) throw refusal("usage");
  const chosen = namesOf<ScopeKind>(
    kinds,
    source !== undefined ? ["moment"] : agentApp ? AGENT_APP_KINDS : SCOPE_KINDS,
    { safeParse: (value) => ({ success: (SCOPE_KINDS as unknown[]).includes(value) }) },
  );
  if (new Set(chosen).size !== chosen.length) throw refusal("usage");
  if (source !== undefined && (chosen.length !== 1 || chosen[0] !== "moment")) throw refusal("usage");
  const rule = {
    match: typeof bundle === "string" ? ("bundle" as const) : ("host" as const),
    value: (typeof bundle === "string" ? bundle : host) as string,
    ...(account === undefined ? {} : { account }),
    compartment: compartment as PersonalCompartment,
    kinds: chosen,
    ...(agentApp ? { agentApp } : {}),
    ...(typeof client === "string" ? { client } : {}),
    ...(source === undefined ? {} : { source: source as MomentSource }),
  };
  return withAdmin(context, async (admin) => {
    try {
      print(context, await admin.lens.addScope(rule));
    } catch (error) {
      // The account map holds the account with another compartment.
      if (!isCoded(error, "rule_conflict")) throw error;
      throw refusal(
        "rule_conflict",
        "the account map gives the account another compartment: see pi lens browsing account list --show (pia on the box)",
      );
    }
  });
}

// Each rule's id, match, compartment, kinds and whether it names an account, and its source when
// it has one, as one JSON document. `--show` adds each one's value and account (`value`,
// `accountValue`, null for none), to a terminal only.
export async function lensScopeList(context: CommandContext): Promise<0> {
  const show = context.values.show === true;
  if (show && !context.io.stdoutIsTTY)
    throw refusal("not_a_terminal", "scope list --show prints each rule's value: run it in a terminal");
  return withAdmin(context, async (admin) => {
    const rules = [];
    for (const rule of await admin.lens.scope()) {
      const opened = show ? await admin.lens.scopeValue(rule.id) : null;
      rules.push(opened === null ? rule : { ...rule, value: opened.value, accountValue: opened.account });
    }
    printJson(context, rules);
  });
}

// Removes one rule. What it admitted stays stored, for `pi erase`. Prints nothing.
export async function lensScopeRemove(context: CommandContext): Promise<0> {
  const id = context.positionals[0];
  if (!CaptureScopeRuleId.safeParse(id).success) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    await admin.lens.removeScope(id as string);
  });
}

// The owner's time by activity category for each local day from `--from` to `--to`
// (dates; by default the seven days to today in the owner's zone), one JSON document of
// ActivityDay: categories, minutes and the table's version, no app, host, title or path.
export async function lensTime(context: CommandContext): Promise<0> {
  const { from, to } = context.values;
  const range = { ...(typeof from === "string" ? { from } : {}), ...(typeof to === "string" ? { to } : {}) };
  if (
    Object.values(range).some((day) => !DateOnly.safeParse(day).success) ||
    (range.from !== undefined && range.to !== undefined && range.from > range.to)
  )
    throw refusal("usage");
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.lens.activity(range));
  });
}

// `pi lens browsing NAME [allow | deny]`. Bare, the device's
// LensBrowsingView (its mode and the sizes of the two lists, no value), one JSON document. `allow`
// turns the deny-list off at once. `deny`, to a terminal only, first prints every exclusion's
// value, every mapped account with its compartment, the hosts never admitted by default and that
// apps, moments and meetings stay on the allow-list, then asks, and only `yes` turns it on. Either
// prints the view after. `not_found` for no such device.
export async function lensBrowsing(context: CommandContext): Promise<0> {
  const name = deviceName(context);
  const mode = context.positionals[1];
  if (mode !== undefined && mode !== "allow" && mode !== "deny") throw refusal("usage");
  // The answer is read from the input, so a piped input is refused too.
  if (mode === "deny" && (!context.io.stdoutIsTTY || context.io.stdinIsTTY === false))
    throw refusal(
      "not_a_terminal",
      "lens browsing deny prints the exclude list and the account map and asks: run it in a terminal",
    );
  return withAdmin(context, async (admin) => {
    if (mode === "allow") await admin.lens.setBrowsing(name, "allow");
    if (mode === "deny") {
      await admin.lens.browsing(name);
      const excludes = await admin.lens.captureExcludes();
      print(context, `exclude list (${excludes.length}), never stored from any device:`);
      for (const one of excludes) print(context, `  ${one.id}  ${(await admin.lens.excludeValue(one.id)) ?? ""}`);
      const accounts = await admin.lens.captureAccounts();
      print(context, `account map (${accounts.length}), the only accounts admitted on a multi-account surface:`);
      for (const one of accounts)
        print(context, `  ${one.id}  ${(await admin.lens.accountValue(one.id)) ?? ""}  ${one.compartment}`);
      print(context, "never admitted by default (a rule you name still admits one):");
      print(context, `  a host whose first label is one of: ${[...SIGN_IN_WORDS, ...SIGN_IN_HOST_WORDS].join(", ")}`);
      print(context, `  a page whose path holds one of: ${SIGN_IN_WORDS.join(", ")}`);
      print(context, `  an agent's web page, on or under: ${AGENT_HOSTS.join(", ")}`);
      print(context, "  the box's own host and every host under it");
      print(context, "apps, moments and meetings stay on the allow-list: only a rule admits them");
      context.io.stdout.write(`turn on the deny-list for ${name}? (yes or no): `);
      if ((await firstLine(context)) === "yes") await admin.lens.setBrowsing(name, "deny");
    }
    printJson(context, await admin.lens.browsing(name));
  });
}

// The first line of the command's input, trimmed and in lower case; empty when the input ends.
async function firstLine(context: CommandContext): Promise<string> {
  const reader = createInterface({ input: context.io.stdin, crlfDelay: Infinity });
  try {
    const next = await reader[Symbol.asyncIterator]().next();
    return next.done === true ? "" : next.value.trim().toLowerCase();
  } finally {
    reader.close();
  }
}

// `pi lens browsing exclude add HOST`, `list [--show]` and `remove ID`. `add`
// prints the id; the store refuses a host that is no registrable domain or under one
// `invalid_argument`, and one on the list `duplicate_name`. `list` prints each exclusion's id and
// time as one JSON document, and `--show` adds its host (`value`), to a terminal only.
export async function lensBrowsingExclude(context: CommandContext): Promise<0> {
  const [verb, argument] = context.positionals;
  const show = context.values.show === true;
  if (show && verb !== "list") throw refusal("usage");
  if (verb === "add" && typeof argument === "string")
    return withAdmin(context, async (admin) => print(context, await admin.lens.addExclude(argument)));
  if (verb === "list" && argument === undefined) {
    if (show && !context.io.stdoutIsTTY)
      throw refusal("not_a_terminal", "exclude list --show prints each excluded host: run it in a terminal");
    return withAdmin(context, async (admin) => {
      const rows = [];
      for (const one of await admin.lens.captureExcludes())
        rows.push(show ? { ...one, value: await admin.lens.excludeValue(one.id) } : one);
      printJson(context, rows);
    });
  }
  if (verb === "remove" && CaptureExcludeId.safeParse(argument).success)
    return withAdmin(context, async (admin) => admin.lens.removeExclude(argument as string));
  throw refusal("usage");
}

// `pi lens browsing account add ACCOUNT --compartment C`, `list [--show]` and
// `remove ID`. `add` prints the id; the store refuses a malformed account or a compartment that is
// not `own` or an employer's `invalid_argument`, an employer the key file lacks
// `unknown_compartment`, an account a scope rule names with another compartment `rule_conflict`
// (the hint names the rules), and one already mapped `duplicate_name`. `list` prints each mapped
// account's id, compartment and time as one JSON document, and `--show` adds the account
// (`value`), to a terminal only.
export async function lensBrowsingAccount(context: CommandContext): Promise<0> {
  const [verb, argument] = context.positionals;
  const { compartment } = context.values;
  const show = context.values.show === true;
  if ((show && verb !== "list") || (compartment !== undefined && verb !== "add")) throw refusal("usage");
  if (verb === "add" && typeof argument === "string") {
    if (!PersonalCompartment.safeParse(compartment).success) throw refusal("usage");
    return withAdmin(context, async (admin) => {
      try {
        print(context, await admin.lens.addAccount(argument, compartment as string));
      } catch (error) {
        const { code, rules } = error as { code?: unknown; rules?: unknown };
        if (code !== "rule_conflict" || !Array.isArray(rules)) throw error;
        throw refusal(
          "rule_conflict",
          `scope rules name the account with another compartment: ${rules.join(", ")}; remove them with pi lens scope remove ID (pia on the box), or map it to theirs`,
        );
      }
    });
  }
  if (verb === "list" && argument === undefined) {
    if (show && !context.io.stdoutIsTTY)
      throw refusal("not_a_terminal", "account list --show prints each mapped account: run it in a terminal");
    return withAdmin(context, async (admin) => {
      const rows = [];
      for (const one of await admin.lens.captureAccounts())
        rows.push(show ? { ...one, value: await admin.lens.accountValue(one.id) } : one);
      printJson(context, rows);
    });
  }
  if (verb === "remove" && CaptureAccountId.safeParse(argument).success)
    return withAdmin(context, async (admin) => admin.lens.removeAccount(argument as string));
  throw refusal("usage");
}
