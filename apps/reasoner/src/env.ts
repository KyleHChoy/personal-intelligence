// What pi-reasoner may find in its environment. Values are read only to
// refuse a Postgres connection URL and by requireEnv, which returns the values it was asked for;
// a refusal names a variable, never what it holds.
import { microUsdOf } from "@intelligence/personal-models";

export type Env = Readonly<Record<string, string | undefined>>;

// A refusal with a code and, at most, the name of a variable.
export class Refusal extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, hint?: string) {
    super(code);
    this.code = code;
    this.hint = hint;
  }
}

// An empty variable is an unset one.
const isSet = (env: Env, name: string): boolean => (env[name] ?? "") !== "";

const REFUSED = new Set([
  "DATABASE_URL",
  "PI_KEY_FILE",
  "PI_ERASURE_JOURNAL",
  "PI_GOOGLE_CLIENT_SECRET",
  "PI_CLIENT_TOKEN",
]);
const refused = (name: string): boolean =>
  name.startsWith("PG") || name.startsWith("PI_DATABASE_URL_") || REFUSED.has(name);
const POSTGRES_URL = /^\s*postgres(?:ql)?:\/\//i;

// The reasoner holds no database setting, no key file, no journal path, no Google secret, no
// client token and no Postgres connection URL under any name: its one way to the store is the
// agent API.
export function assertNoDataAccess(env: Env): void {
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === "") continue;
    if (refused(name) || POSTGRES_URL.test(value)) throw new Refusal("wrong_role_url");
  }
}

// The values of the named variables, or a refusal naming the first that is unset.
export function requireEnv<Name extends string>(env: Env, names: readonly Name[]): Record<Name, string> {
  const missing = names.find((name) => !isSet(env, name));
  if (missing !== undefined) throw new Refusal("missing_env", `set ${missing}`);
  return Object.fromEntries(names.map((name) => [name, env[name] as string])) as Record<Name, string>;
}

// A ceiling in dollars as whole micro-dollars (microUsdOf): unset or empty is the default.
// Anything else is refused, naming the variable.
export function usdCeiling(env: Env, name: string, fallbackMicroUsd: number): number {
  const value = env[name] ?? "";
  if (value === "") return fallbackMicroUsd;
  const micro = microUsdOf(value);
  if (micro === null) throw new Refusal("bad_env", `set ${name}`);
  return micro;
}
