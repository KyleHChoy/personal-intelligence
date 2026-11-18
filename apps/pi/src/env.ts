import { type HttpStatus, isCoded, PersonalLogEvent } from "@intelligence/contracts/personal";
import { DATABASE_ROLES, type Held, type Role, SWITCHES, type SwitchName } from "./switches.ts";

export type { Role };

// What a command may find in its environment, and the refusals every command shares. Nothing here
// reads a variable's value: a check only asks whether it is set.

export type Env = Readonly<Record<string, string | undefined>>;

// The restricted key root's path, when the environment names one.
export const restrictedKeyFile = (env: Env): string | undefined =>
  (env.PI_RESTRICTED_KEY_FILE ?? "") === "" ? undefined : env.PI_RESTRICTED_KEY_FILE;

// A refusal with one of pi's codes. `run` logs the code, prints the hint, and exits 1, or 2
// for "usage". A hint is pi's own text: a variable's name or the key file's path, never a
// value from the environment, a secret or evidence.
export class Refusal extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  // A vendor's refusal status, such as http_402, logged beside the code.
  readonly status: HttpStatus | undefined;

  constructor(code: string, hint?: string, status?: HttpStatus) {
    super(code);
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

export const refusal = (code: string, hint?: string): Refusal => new Refusal(code, hint);

// What a lookup found, or a write's `true`: `null` or `false`, nothing there, is refused with `not_found`.
export function found<T extends object | string | true>(value: T | null | false): T {
  if (value === null || value === false) throw refusal("not_found");
  return value;
}

// The code a thrown error carries: a package's, or one of pi's. Anything else, a database
// error's SQLSTATE included, is "unavailable".
export function codeOf(error: unknown): string {
  const code = isCoded(error) ? error.code : undefined;
  return typeof code === "string" && PersonalLogEvent.shape.code.safeParse(code).success ? code : "unavailable";
}

// An empty variable is an unset one.
const isSet = (env: Env, name: string): boolean => (env[name] ?? "") !== "";

// Who may hold each variable the switch table names a list of roles for.
const HELD: readonly (readonly [string, readonly Role[]])[] = Object.entries(SWITCHES).flatMap(
  ([name, { held }]: [string, { held: Held }]) => (typeof held === "string" ? [] : [[name, held] as const]),
);

// The roles that hold one URL and refuse any other by its prefix, a URL no table names among them:
// the work tick, the send proxy, the notice sender, and the memory adapter, which holds none.
const ONE_URL: ReadonlySet<Role> = new Set<Role>(["work", "proxy", "notify", "adapter"]);

// So a secret added to the table with its holders is refused everywhere else by that row alone, and
// the only other rule is the importer's: the one command that stores the OpenRouter key may hold
// it, whatever its role (`modelKey`).
export function checkRole(role: Role, env: Env, { modelKey = false }: { modelKey?: boolean } = {}): void {
  const own: string | undefined = role === "none" || role === "adapter" ? undefined : DATABASE_ROLES[role].url;
  const refused =
    HELD.some(
      ([name, held]) => isSet(env, name) && !held.includes(role) && !(modelKey && name === "PI_OPENROUTER_KEY"),
    ) ||
    (ONE_URL.has(role) &&
      Object.keys(env).some((name) => name.startsWith("PI_DATABASE_URL_") && name !== own && isSet(env, name)));
  if (refused) throw refusal("wrong_role_url");
}

// A database URL names its role and its password itself. One that does not parse, or names no
// user or no password, is refused before any connection: the driver would fill either from
// PGUSER and PGPASSWORD, and connect as whoever they name. So is one whose query carries a
// parameter that changes who connects or where, which the driver lets override the URL's own.
// The refusal carries nothing of the URL.
const OVERRIDES = new Set([
  "user",
  "password",
  "host",
  "hostaddr",
  "port",
  "dbname",
  "database",
  "db",
  "service",
  "options",
  "passfile",
]);

export function checkUrls(names: readonly SwitchName[], env: Env): void {
  for (const name of names.filter((one) => one.startsWith("PI_DATABASE_URL_"))) {
    let named = false;
    try {
      const url = new URL(env[name] ?? "");
      const scheme = url.protocol === "postgres:" || url.protocol === "postgresql:";
      named =
        scheme &&
        url.username !== "" &&
        decodeURIComponent(url.password) !== "" &&
        ![...url.searchParams.keys()].some((key) => OVERRIDES.has(key));
    } catch {
      // Refused below, without the URL: the error Node raises for one carries the whole of it.
    }
    if (!named) throw refusal("bad_url");
  }
}

// The hint names the first required variable that is unset.
export function checkRequired(names: readonly SwitchName[], env: Env): void {
  const missing = names.find((name) => !isSet(env, name));
  if (missing !== undefined) throw refusal("missing_env", `set ${missing}`);
}
