import { randomBytes } from "node:crypto";
import {
  AgentWriteKind,
  ClientName,
  type CoverageRow,
  PASSKEY_CATEGORIES,
  RESTRICTED_PREFIX,
  RestrictedCategory,
  type Tier,
} from "@intelligence/contracts/personal";
import type { RuledTier } from "@intelligence/personal-core/views";
import { EXTRACT_GENERATION } from "@intelligence/personal-extract";
import {
  buildAuthUrl,
  createGoogleHttp,
  driveAbout,
  exchangeCode,
  listenForCode,
  pkcePair,
  tokenSource,
} from "@intelligence/personal-google";
import type { RecordFilter } from "@intelligence/personal-store";
import {
  addCompartmentKey,
  applyMigrations,
  BASELINE,
  DRIVE_CEILING_BYTES,
  ensureRoles,
  exportOwnerData,
  generateKeyFile,
  googleSecretName,
  importOwnerData,
  KeyFileRefused,
  pendingMigrations,
  RECORD_STATES,
  unattendedMigration,
  validRestatementFilter,
  wrapRestrictedFile,
} from "@intelligence/personal-store";
import { statusBox } from "./agents/box-facts.ts";
import { captureCeilingOf, driveNumberOf } from "./box/env-numbers.ts";
import { storageAlarm } from "./box/storage-alarm.ts";
import { agentWeeksOf, coverageOptionsOf } from "./command-args.ts";
import type { CommandContext } from "./command-types.ts";
import { deployedCommit } from "./deployed-commit.ts";
import { checkRequired, checkRole, checkUrls, found, refusal, restrictedKeyFile } from "./env.ts";
import type { GoogleClient } from "./intake/sync-google.ts";
import { clientOf, connectedLabels } from "./intake/sync-google.ts";
import { compartments, list, print, printJson, variable, withAdmin } from "./owner/owner-kit.ts";
import { DATABASE_ROLES } from "./switches.ts";

// The owner commands' bodies: each a thin call into the store or the Google
// package. `run` has checked the environment before any of them, so a required variable is set.
// Every export but `coverageSilentLine` is a command's body: `command-kit.ts` loads them by name.

type Value = CommandContext["values"][string];

export async function keysInit({ values, env }: CommandContext): Promise<0> {
  await generateKeyFile(variable(env, "PI_KEY_FILE"), compartments(list(values.compartments, ["own"])));
  return 0;
}

// A restricted category goes to the restricted key file, then,
// as pi_admin, into policy.restricted_categories: the key first, so a category the table names
// always has its key. The admin role's checks are made before the key is written, as every owner
// command makes them. A key already there is taken as the first half of an add that stopped, and
// the row is written. A lock is named by the restricted file's own path.
export async function keysAddCompartment(context: CommandContext): Promise<0> {
  const { positionals, env } = context;
  const [compartment] = compartments(positionals);
  if (compartment === undefined) throw refusal("usage");
  if (!compartment.startsWith(RESTRICTED_PREFIX)) {
    await addCompartmentKey(variable(env, "PI_KEY_FILE"), compartment);
    return 0;
  }
  checkRole("admin", env);
  checkRequired(["PI_DATABASE_URL_ADMIN"], env);
  checkUrls(["PI_DATABASE_URL_ADMIN"], env);
  const category = RestrictedCategory.parse(compartment.slice(RESTRICTED_PREFIX.length));
  const restricted = restrictedKeyFile(env);
  try {
    await addCompartmentKey(variable(env, "PI_KEY_FILE"), compartment, restricted);
  } catch (error) {
    if (error instanceof KeyFileRefused && error.code === "locked")
      throw refusal("key_file_refused", `remove ${restricted}.lock if no add is running`);
    if (!(error instanceof KeyFileRefused && error.code === "exists")) throw error;
  }
  return withAdmin(context, (admin) => admin.restricted.addRestrictedCategory(category));
}

// The passkey lock: the restricted key file
// wrapped, with a key for each of health, money and legal, and the keys a plain file there held;
// the recovery secret printed to the terminal alone, once; then each category turned on, as
// pi_admin, after its key is there. A file already wrapped prints nothing and turns the categories
// on, so an init stopped between the two is run again.
export async function keysRestrictedInit(context: CommandContext): Promise<0> {
  const path = variable(context.env, "PI_RESTRICTED_KEY_FILE");
  try {
    const recovery = await wrapRestrictedFile(
      path,
      PASSKEY_CATEGORIES.map((category) => `${RESTRICTED_PREFIX}${category}`),
    );
    print(context, recovery);
  } catch (error) {
    if (error instanceof KeyFileRefused && error.code === "locked")
      throw refusal("key_file_refused", `remove ${path}.lock if no init is running`);
    if (!(error instanceof KeyFileRefused && error.code === "exists")) throw error;
  }
  return withAdmin(context, async (admin) => {
    for (const category of PASSKEY_CATEGORIES) await admin.restricted.addRestrictedCategory(category);
  });
}

// The password in a role's URL. `run` has refused a URL that does not parse or names none.
const passwordOf = (url: string): string => decodeURIComponent(new URL(url).password);

// The restricted role's password is the owner's to set, so its URL is optional: with none the role
// is made with no password and no one can log in as it. A URL that is set has been checked by
// `run`.
const optionalPasswordOf = (url: string): string | undefined => (url === "" ? undefined : passwordOf(url));

// `pi db migrate --auto`: the box's unattended run, with the migrator's URL as
// the bootstrap URL. It makes and alters no role and sets no password: it applies the files as
// pi_owner, and one that needs more is `needs_superuser`, left to the owner's run.
// `pi db pending`: one word, `pending` or `none`, as pi_admin, which reads the ledger and no more.
// With `--deploy`, the host's pre-deploy step's word: `none`, `unattended` when a file waits and the
// box's start applies it by itself, or `owner` when only the owner's `pi-migrate` would.
export async function dbPending(context: CommandContext): Promise<0> {
  const url = variable(context.env, DATABASE_ROLES.admin.url);
  const pending = await pendingMigrations(url);
  if (pending.length === 0) print(context, "none");
  else if (context.values.deploy !== true) print(context, "pending");
  else print(context, (await unattendedMigration(url)) ? "unattended" : "owner");
  return 0;
}

// `pi db export DIR` and `pi db import DIR`: the owner's claims, entities, rulings and
// the evidence they cite, as JSON Lines under DIR, and back into an empty database at the same
// migration, as pi_owner from the bootstrap's URL. Each prints the migration and each table's rows.
const exported = (manifest: { migration: string | null; tables: { name: string; rows: number }[] }) => ({
  migration: manifest.migration,
  tables: manifest.tables.map(({ name, rows }) => ({ name, rows })),
});
export async function dbExport(context: CommandContext): Promise<0> {
  const manifest = await exportOwnerData(
    variable(context.env, DATABASE_ROLES.bootstrap.url),
    context.positionals[0] ?? "",
  );
  printJson(context, exported(manifest));
  return 0;
}
export async function dbImport(context: CommandContext): Promise<0> {
  const manifest = await importOwnerData(
    variable(context.env, DATABASE_ROLES.bootstrap.url),
    context.positionals[0] ?? "",
  );
  printJson(context, exported(manifest));
  return 0;
}

export async function dbMigrate({ env, values }: CommandContext): Promise<0> {
  if (values.auto === true) {
    await applyMigrations(variable(env, DATABASE_ROLES.bootstrap.url), undefined, undefined, "migrator");
    return 0;
  }
  // Every role whose password the migration sets from its URL, by the role table.
  const passwords = Object.fromEntries(
    Object.entries(DATABASE_ROLES).flatMap(([role, { url, migrate }]) =>
      migrate === "password"
        ? [[role, passwordOf(variable(env, url))]]
        : migrate === "optional password"
          ? [[role, optionalPasswordOf(variable(env, url))]]
          : [],
    ),
  ) as Parameters<typeof ensureRoles>[1];
  const bootstrap = variable(env, DATABASE_ROLES.bootstrap.url);
  await ensureRoles(bootstrap, passwords);
  // A new database starts from the baseline; one with a ledger keeps its history.
  await applyMigrations(bootstrap, undefined, undefined, "bootstrap", BASELINE);
  return 0;
}

// An account label. One that is not in the ClientName form is a usage error.
function labelOf(value: Value): string {
  if (typeof value !== "string" || !ClientName.safeParse(value).success) throw refusal("usage");
  return value;
}

// A source's compartment is `own` or `employer:<slug>` and nothing else, so a released
// compartment never holds an account's raw items.
function sourceCompartment(value: Value): string {
  const [name] = compartments([typeof value === "string" ? value : "own"]);
  if (name === undefined || !(name === "own" || (name.startsWith("employer:") && !name.endsWith("-released"))))
    throw refusal("usage");
  return name;
}

function portOf(value: Value): number | undefined {
  if (value === undefined) return undefined;
  const port = typeof value === "string" && /^\d{1,5}$/.test(value) ? Number(value) : 0;
  if (port < 1 || port > 65535) throw refusal("usage");
  return port;
}

// GD: `--drive` runs the loopback flow for the Drive grant with the label's stored client. The
// label must be connected and synced, so its address is known (`not_found`). The token must belong
// to that address: another is `account_mismatch`, and nothing is stored.
async function googleConnectDrive(context: CommandContext, label: string, port: number | undefined): Promise<0> {
  const { deps } = context;
  return withAdmin(context, async (admin) => {
    const client = clientOf(await admin.secrets.secret(googleSecretName(label, "client")));
    const mail = (await admin.accounts.listSourceAccounts()).find(
      (account) => account.label === label && account.connector === "google_mail",
    );
    if (client === null || mail?.address === null || mail === undefined) throw refusal("not_found");
    const state = randomBytes(32).toString("base64url");
    const { verifier, challenge } = pkcePair();
    const { redirectUri, code } = await listenForCode(
      state,
      port,
      deps.listenTimeoutMs === undefined ? {} : { timeoutMs: deps.listenTimeoutMs },
    );
    print(
      context,
      buildAuthUrl({ grant: "drive", clientId: client.clientId, redirectUri, state, codeChallenge: challenge }),
    );
    const { refreshToken } = await exchangeCode(
      {
        grant: "drive",
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        code: await code,
        redirectUri,
        codeVerifier: verifier,
      },
      deps.google,
    );
    const google = deps.google ?? {};
    const http = createGoogleHttp({
      tokens: tokenSource(
        { grant: "drive", clientId: client.clientId, clientSecret: client.clientSecret, refreshToken },
        google,
      ),
      deps: google,
    });
    const { address } = await driveAbout(http, google);
    if (address.trim().toLowerCase() !== (mail.address ?? "").trim().toLowerCase()) throw refusal("account_mismatch");
    await admin.secrets.setSecret(googleSecretName(label, "drive_refresh_token"), refreshToken);
  });
}

export async function googleConnect(context: CommandContext): Promise<0> {
  const { values, env } = context;
  const label = labelOf(values.account);
  const port = portOf(values.port);
  if (values.drive === true && values.contacts === true) throw refusal("usage");
  if (values.drive === true) {
    if (values.compartment !== undefined) throw refusal("usage");
    return googleConnectDrive(context, label, port);
  }
  if (values.contacts === true) {
    // The contacts grant takes the label's stored compartment with its client.
    if (values.compartment !== undefined) throw refusal("usage");
    return connectContacts(context, label, port);
  }
  checkRequired(["PI_GOOGLE_CLIENT_ID", "PI_GOOGLE_CLIENT_SECRET"], env);
  const compartment = sourceCompartment(values.compartment);
  return withAdmin(context, async (admin, keys) => {
    if (!keys.compartments.has(compartment)) throw refusal("unknown_compartment");
    const accounts = (await admin.accounts.listSourceAccounts()).filter((account) => account.label === label);
    if (accounts.some((account) => account.compartment !== compartment)) throw refusal("compartment_mismatch");

    const client: GoogleClient = {
      clientId: variable(env, "PI_GOOGLE_CLIENT_ID"),
      clientSecret: variable(env, "PI_GOOGLE_CLIENT_SECRET"),
      compartment,
    };
    const refreshToken = await consent(context, { grant: "mail", client, port });
    await admin.secrets.setSecret(googleSecretName(label, "client"), JSON.stringify(client));
    await admin.secrets.setSecret(googleSecretName(label, "refresh_token"), refreshToken);
  });
}

// The loopback flow for one grant: the owner opens the URL, Google sends the code to the
// listener, and the code is exchanged for a refresh token. Nothing is stored here.
async function consent(
  context: CommandContext,
  {
    grant,
    client,
    port,
    address,
  }: { grant: "mail" | "contacts"; client: GoogleClient; port: number | undefined; address?: string },
): Promise<string> {
  const { deps } = context;
  const state = randomBytes(32).toString("base64url");
  const { verifier, challenge } = pkcePair();
  const { redirectUri, code } = await listenForCode(
    state,
    port,
    deps.listenTimeoutMs === undefined ? {} : { timeoutMs: deps.listenTimeoutMs },
  );
  print(
    context,
    buildAuthUrl({
      grant,
      clientId: client.clientId,
      redirectUri,
      state,
      codeChallenge: challenge,
      ...(address === undefined ? {} : { loginHint: address }),
    }),
  );
  const exchange = {
    grant,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    code: await code,
    redirectUri,
    codeVerifier: verifier,
  };
  const { refreshToken } = await exchangeCode(
    address === undefined ? exchange : { ...exchange, expectedAddress: address },
    deps.google,
  );
  return refreshToken;
}

// The `contacts` grant, with the label's stored read client and its
// stored address as the login hint and as the address the consent must come from. Only the
// contacts token is written, so a refusal leaves a stored one as it was, and the mail token and
// the client are never touched. A label with no stored client or no stored address (one never
// synced) is not connected: `not_found`, as `google disconnect` answers.
function connectContacts(context: CommandContext, label: string, port: number | undefined): Promise<0> {
  return withAdmin(context, async (admin) => {
    const client = clientOf(await admin.secrets.secret(googleSecretName(label, "client")));
    const address =
      (await admin.accounts.listSourceAccounts()).find((account) => account.label === label && account.address !== null)
        ?.address ?? null;
    if (client === null || address === null) throw refusal("not_found");
    const refreshToken = await consent(context, { grant: "contacts", client, port, address });
    await admin.secrets.setSecret(googleSecretName(label, "contacts_refresh_token"), refreshToken);
  });
}

// Each connected label: its compartment, from its sealed client, so it shows before the first
// sync; its source accounts and their last sync; when its refresh token was stored; and whether
// its contacts token exists and when it was stored (contacts and identity, "Commands").
export async function googleList(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    const accounts = await admin.accounts.listSourceAccounts();
    const { googleTokens } = await admin.accounts.status();
    const labels = [];
    for (const label of connectedLabels(await admin.secrets.listSecretNames("google/"))) {
      const client = clientOf(await admin.secrets.secret(googleSecretName(label, "client")));
      const contactsAt = await admin.secrets.updatedAt(googleSecretName(label, "contacts_refresh_token"));
      labels.push({
        label,
        compartment: client?.compartment ?? null,
        accounts: accounts
          .filter((account) => account.label === label)
          .map(({ connector, lastSyncAt, lastOutcome }) => ({ connector, lastSyncAt, lastOutcome })),
        refreshTokenUpdatedAt: googleTokens.find((token) => token.label === label)?.updatedAt ?? null,
        contacts: contactsAt !== null,
        contactsTokenUpdatedAt: contactsAt,
        drive: (await admin.secrets.secret(googleSecretName(label, "drive_refresh_token"))) !== null,
      });
    }
    printJson(context, labels);
  });
}

// `--contacts` deletes the label's contacts token alone, and `--drive` its Drive token alone
// (GD). With neither, the Drive token goes first, then the contacts token, then the mail token,
// then the client: if a later delete fails, the label still reads as connected and the command
// can be run again, and neither its documents nor its contacts are left on with the mail token
// gone.
export async function googleDisconnect(context: CommandContext): Promise<0> {
  const label = labelOf(context.positionals[0]);
  const contactsOnly = context.values.contacts === true;
  const driveOnly = context.values.drive === true;
  if (contactsOnly && driveOnly) throw refusal("usage");
  const drive = googleSecretName(label, "drive_refresh_token");
  return withAdmin(context, async (admin) => {
    const stored = await admin.secrets.listSecretNames(`google/${label}/`);
    // GD: `--drive` deletes the Drive token alone, and is not_found when there is none.
    if (driveOnly) {
      if (!stored.includes(drive)) throw refusal("not_found");
      await admin.secrets.deleteSecret(drive);
      return;
    }
    const names = contactsOnly
      ? [googleSecretName(label, "contacts_refresh_token")]
      : [
          drive,
          googleSecretName(label, "contacts_refresh_token"),
          googleSecretName(label, "refresh_token"),
          googleSecretName(label, "client"),
        ];
    // A mistyped label must not look like success while the real one keeps syncing. Without
    // a flag, a label is connected while its mail token or its client is stored.
    const connected = contactsOnly ? names : names.slice(2);
    if (!connected.some((name) => stored.includes(name))) throw refusal("not_found");
    for (const name of names) await admin.secrets.deleteSecret(name);
  });
}

// The verified send-as aliases the latest sync read that are not yet
// owner addresses, each with its label and compartment, to add with `pi owner add-address`.
// Addresses, so terminal only (commands.ts).
export async function ownerAliases(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.accounts.sendAsAliases());
  });
}

// The owner's time zone, checked before any connection (commands.ts); prints the
// name stored, in its canonical form.
export async function ownerTimezone(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    print(context, await admin.accounts.setTimeZone(context.positionals[0] ?? ""));
  });
}

// `--kind`, `--state` and `--limit`, each a usage error when it is none of its own.
function recordFilter(values: CommandContext["values"]): RecordFilter {
  const { client, kind, state, limit } = values;
  if (kind !== undefined && !AgentWriteKind.safeParse(kind).success) throw refusal("usage");
  if (state !== undefined && !(RECORD_STATES as readonly unknown[]).includes(state)) throw refusal("usage");
  if (limit !== undefined && !(typeof limit === "string" && /^[1-9]\d{0,2}$/.test(limit) && Number(limit) <= 200))
    throw refusal("usage");
  return {
    ...(typeof client === "string" ? { client } : {}),
    ...(typeof kind === "string" ? { kind } : {}),
    ...(typeof state === "string" ? { state } : {}),
    ...(typeof limit === "string" ? { limit: Number(limit) } : {}),
  };
}

// `pia agents record`: each agent's bets, questions and answers taken back by ISO
// week. Names, dates and counts: it prints without a terminal.
export async function agentsRecord(context: CommandContext): Promise<0> {
  const weeks = agentWeeksOf(context.values);
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.agents.weeks(weeks));
  });
}

// Ids, names, kinds, times, labels, states and flags: no content.
export async function agentRecordsList(context: CommandContext): Promise<0> {
  const filter = recordFilter(context.values);
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.agents.listRecords(filter));
  });
}

// One agent record with its body, to a terminal only.
export async function agentRecordsShow(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    const view = found(await admin.agents.record(context.positionals[0] ?? ""));
    printJson(context, view);
  });
}

// That one agent record removed, and how many were.
export async function agentRecordsRm(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    const removed = found(await admin.agents.removeRecord(context.positionals[0] ?? ""));
    printJson(context, removed);
  });
}

// The restatement marks, ids, names, answers and times only; and
// one cleared, its record extracted again by the next `pi extract`.
export async function restatementsList(context: CommandContext): Promise<0> {
  const { client, answer, limit } = context.values;
  if (client !== undefined && !ClientName.safeParse(client).success) throw refusal("usage");
  if (limit !== undefined && !(typeof limit === "string" && /^\d{1,4}$/.test(limit))) throw refusal("usage");
  const filter = {
    ...(typeof client === "string" ? { client } : {}),
    ...(typeof answer === "string" ? { answer } : {}),
    ...(typeof limit === "string" ? { limit: Number(limit) } : {}),
  };
  // The store's own test of an answer and a limit, before any connection.
  if (!validRestatementFilter(filter)) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.agents.listRestatements(filter));
  });
}

export async function restatementsClear(context: CommandContext): Promise<0> {
  const id = context.positionals[0] ?? "";
  if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    printJson(context, {
      cleared: Number(id),
      decision: await admin.agents.clearRestatement(Number(id), {
        requestId: `rc_${randomBytes(12).toString("base64url")}`,
      }),
    });
  });
}

export async function inspect(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    const view = found(await admin.accounts.inspect(context.positionals[0] ?? ""));
    printJson(context, view);
  });
}

// The owner's whole view (the widest built audience) in tier order, then warmth, and
// one person's stored row with every part the build wrote. Read-only; printed as one JSON document.
export async function peopleTiers(context: CommandContext): Promise<0> {
  const { tier, dormant, limit, ruled } = context.values;
  return withAdmin(context, async (admin) => {
    // The owner's rulings in force, each with the people who hold it.
    if (ruled === true) return printJson(context, await admin.tiers.listTiers());
    printJson(
      context,
      await admin.tiers.peopleTiers({
        ...(typeof tier === "string" ? { tier: tier as Tier } : {}),
        ...(dormant === true ? { dormant: true } : {}),
        ...(typeof limit === "string" ? { limit: Number(limit) } : {}),
      }),
    );
  });
}

// `pia people tier PERSON TIER` writes the owner's ruling
// and prints its id (or `already_settled` with the ruling in force, writing nothing); `--clear`
// lifts the ruling in force, `not_found` when there is none. Ids only: the person is never echoed.
export async function peopleTier(context: CommandContext): Promise<0> {
  const [person = "", tier] = context.positionals;
  const requestId = randomBytes(12).toString("base64url");
  return withAdmin(context, async (admin) => {
    if (context.values.clear === true) {
      found(await admin.tiers.clearTier(person, { requestId }));
      return printJson(context, { cleared: true });
    }
    try {
      printJson(context, { ruling: await admin.tiers.setTier(person, tier as RuledTier, { requestId }) });
    } catch (error) {
      const { code, rulings } = error as { code?: unknown; rulings?: unknown };
      if (code !== "already_settled" || !Array.isArray(rulings)) throw error;
      printJson(context, { code, rulings });
    }
  });
}

export async function peopleWarmth(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.tiers.personWarmth(context.positionals[0] ?? ""));
  });
}

// The one line `--record` prints for a row that entered `silent`, which the box's timer copies to
// its own output: the row's kind and id, and its rule's code. Ids and a code only.
export const coverageSilentLine = (row: CoverageRow): string =>
  JSON.stringify({ event: "coverage_silent", ids: { [row.kind]: row.id }, code: row.code ?? "silent" });

// With `--coverage [--days N]`, `Admin.coverage` printed as one JSON
// document, `{ days, rows }`; with `--record` too, the states recorded and, for each row that
// entered `silent`, one fixed line (`coverageSilentLine`), and nothing else.
export async function status(context: CommandContext): Promise<0> {
  const coverage = coverageOptionsOf(context.values);
  return withAdmin(
    context,
    async (admin) => {
      if (coverage !== null) {
        const rows = await admin.box.coverage(coverage.days, { generation: EXTRACT_GENERATION });
        if (!coverage.record) return printJson(context, { days: coverage.days, rows });
        for (const row of await admin.box.recordCoverage(rows)) print(context, coverageSilentLine(row));
        return;
      }
      // The capture ceiling, its own variable at the same default as Drive's.
      const captureCeiling = captureCeilingOf(context.env) ?? DRIVE_CEILING_BYTES;
      if (context.values.storage === true) {
        print(context, storageAlarm(await admin.accounts.databaseBytes(), captureCeiling));
        return;
      }
      // The ceiling the host sets for sync, read as sync reads it: a
      // value that is no whole number is the usage error sync answers, never the default shown as
      // healthy.
      const ceiling = driveNumberOf(context.env.PI_DRIVE_STORAGE_CEILING_BYTES);
      // Said before the database is read: while the box waits for its migration the code is ahead
      // of the schema, and a read below may fail for that reason alone.
      const box = statusBox();
      if (box.waiting !== undefined) context.log.warn({ event: "box_waiting", code: "migrate_wait" });
      const view = await admin.accounts.status(ceiling === undefined ? {} : { driveCeilingBytes: ceiling });
      const bytes = view.drive.databaseBytes;
      const alarm = storageAlarm(bytes, captureCeiling);
      printJson(context, {
        // The commit the image was built from, beside `migration`, the latest the database holds.
        commit: deployedCommit(),
        // The hold files that stand, by code, and `waiting: "migration"` while the box waits for
        // the owner's `pi-migrate`.
        ...box,
        ...view,
        capture: { databaseBytes: bytes, ceilingBytes: captureCeiling, alarm },
        devices: await admin.lens.devices(),
        // What each active client is served: its compartments, a count of its tools, and whether
        // get_health serves it the measures, with the measures' compartments it lacks.
        access: await admin.clients.listClientAccess(),
      });
      if (alarm !== "ok") context.log.warn({ event: "capture_storage", code: alarm });
    },
    { level: "skip" },
  );
}

// The hold on account-recovery mail, provisional with it. How many messages are
// held and the newest of them, by id and time: nothing a message says.
export async function messagesHeld(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.held.messages());
  });
}

// One held message by its id, or every one older than `N` days. `run` has checked the form.
export async function messagesRelease(context: CommandContext): Promise<0> {
  const { values, positionals } = context;
  const age = values["older-than"];
  const which = typeof age === "string" ? { olderThanDays: Number(age.slice(0, -1)) } : { id: positionals[0] ?? "" };
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.held.releaseHeld(which));
  });
}
export { ownerAddAddress } from "./owner/address.ts";
