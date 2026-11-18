import {
  CANARY_COMPARTMENT,
  CaptureScopeRule,
  HOST_FORM,
  MOMENT_SOURCE_BUNDLES,
  MomentSource,
  ownLabel,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { stamp } from "../../core/db.ts";
import { fingerprint, scopeNormal } from "../../core/fingerprint.ts";
import { newId } from "../../core/ids.ts";
import { SCOPED_KINDS } from "../../core/lanes.ts";
import { CAPTURE_ACCOUNTS_LOCK } from "../../core/locks.ts";
import { open, type Sealed, sealUnder } from "../../core/seal.ts";
import { isBrowserBundle, isMultiAccount } from "../../lens/capture-push.ts";
import { mappedCompartment, removeById } from "./lens-browsing.ts";

// The owner's capture scope, run as pi_admin for `pi lens scope add`,
// `list` and `remove`. A rule's value (a bundle id or a host) and its account are normalized,
// fingerprinted under `capture_scope` and sealed under `own`; neither is returned but by
// `scopeValue`, for `pi lens scope list --show` on a terminal. Its compartment labels what it
// admits, and is `own` or an employer the key file holds.

// A rule of the owner's capture scope as `pi lens scope add` gives it. `client`, the name of the
// agent client the owner says runs in it, only with it.
export type ScopeRuleInput = {
  match: CaptureScopeRule["match"];
  value: string;
  account?: string;
  compartment: CaptureScopeRule["compartment"];
  kinds: CaptureScopeRule["kinds"];
  agentApp?: boolean;
  client?: string;
  source?: MomentSource;
};

// The forms an item carries (contracts' CaptureApp bundle and host), and an account's bound.
const BUNDLE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;
const ACCOUNT_MOST = 320;
// The migration's form of a rule's compartment other than `own`.
const EMPLOYER = /^employer:[a-z][a-z0-9-]{1,39}$/;

const at = (id: string, column: "value_enc" | "account_enc") => ({ table: "policy.capture_scope", id, column });

const formed = ({ match, value, account, kinds }: ScopeRuleInput): boolean =>
  (match === "bundle" ? BUNDLE.test(value) : match === "host" && value.length <= 253 && HOST_FORM.test(value)) &&
  (account === undefined ||
    ([...account].length >= 1 && [...account].length <= ACCOUNT_MOST && !/\p{Cc}/u.test(account))) &&
  Array.isArray(kinds) &&
  kinds.length >= 1 &&
  kinds.every((kind) => SCOPED_KINDS.some((one) => one === kind));

// Refused: `invalid_argument` for a malformed rule or a compartment that is not `own` or an
// employer's (public, restricted); `unknown_compartment` for an employer the key file lacks;
// `browser_bundle` for a bundle on BROWSER_BUNDLES; `account_required` for a value on
// MULTI_ACCOUNT_SURFACES with no account, whatever the kinds; `duplicate_name` for a rule of the
// same match, value and account. Returns the rule's id.
export async function addScope(admin: AdminContext, rule: ScopeRuleInput): Promise<string> {
  const { match, value, account, compartment } = rule;
  const agentApp = rule.agentApp === true;
  if (!formed(rule)) throw new AdminError("invalid_argument");
  if (rule.client !== undefined && !agentApp) throw new AdminError("invalid_argument");
  const { source } = rule;
  if (source !== undefined) {
    if (
      !MomentSource.safeParse(source).success ||
      match !== "bundle" ||
      agentApp ||
      account !== undefined ||
      rule.kinds.length !== 1 ||
      rule.kinds[0] !== "moment"
    )
      throw new AdminError("invalid_argument");
    if (scopeNormal(value) !== scopeNormal(MOMENT_SOURCE_BUNDLES[source])) throw new AdminError("source_bundle");
  }
  // `canary` is the check's own rule, for the check's own app (`pia canary setup`).
  if (
    compartment !== "own" &&
    compartment !== CANARY_COMPARTMENT &&
    !(EMPLOYER.test(compartment) && !compartment.endsWith("-released"))
  )
    throw new AdminError("invalid_argument");
  if (!admin.keys.compartments.has(compartment)) throw new AdminError("unknown_compartment");
  if (match === "bundle" && isBrowserBundle(value)) throw new AdminError("browser_bundle");
  if (account === undefined && isMultiAccount(match === "bundle" ? { bundle: value } : { host: value }))
    throw new AdminError("account_required");
  if (agentApp && (rule.kinds as readonly string[]).includes("meeting")) throw new AdminError("agent_app_meeting");

  const id = newId("csr");
  const kinds = SCOPED_KINDS.filter((kind) => (rule.kinds as readonly string[]).includes(kind));
  const accountFp = account === undefined ? null : fingerprint(admin.keys, "capture_scope", account);
  const values = [
    id,
    match,
    fingerprint(admin.keys, "capture_scope", value),
    sealUnder(admin.keys, ["own"], at(id, "value_enc"), scopeNormal(value)),
    accountFp,
    account === undefined ? null : sealUnder(admin.keys, ["own"], at(id, "account_enc"), scopeNormal(account)),
    compartment,
    kinds,
    stamp(admin.now()),
  ];
  const [made] = await admin.transaction(async (query) => {
    if (accountFp !== null) {
      await query(CAPTURE_ACCOUNTS_LOCK);
      const mapped = await mappedCompartment(query, accountFp);
      if (mapped !== undefined && mapped !== compartment) throw new AdminError("rule_conflict");
    }
    let client: string | null = null;
    if (rule.client !== undefined) {
      const [found] = await query<{ id: string }>(
        "select id from policy.clients where name = $1 and kind = 'agent' and status = 'active'",
        [rule.client],
      );
      if (found === undefined) throw new AdminError("not_found");
      client = found.id;
    }
    return query<{ id: string }>(
      `insert into policy.capture_scope (id, match, value_fp, value_enc, account_fp, account_enc, compartment, kinds, created_at, agent_app, client_id, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict on constraint capture_scope_rule do nothing returning id`,
      [...values, agentApp, client, source ?? null],
    );
  });
  if (made === undefined) throw new AdminError("duplicate_name");
  return made.id;
}

// Every rule, oldest first: its id, match, compartment, kinds, whether it names an account, and
// whether it is an agent app's and the client it names, and its
// source, absent for a rule with none. No value and no account.
export async function scope(admin: AdminContext): Promise<CaptureScopeRule[]> {
  const rows = await admin.transaction((query) =>
    query<{
      id: string;
      match: string;
      account: boolean;
      compartment: string;
      kinds: string[];
      agentApp: boolean;
      client: string | null;
      source: string | null;
    }>(
      `select id, match, account_fp is not null as account, compartment, kinds, agent_app as "agentApp", client_id as client, source
       from policy.capture_scope order by created_at, id`,
    ),
  );
  return rows.map(({ source, ...row }) => CaptureScopeRule.parse({ ...row, ...(source === null ? {} : { source }) }));
}

// `pi lens scope list --show`: one rule's value and account as stored (normalized), opened under
// `own`; null for an id that names none.
export async function scopeValue(
  admin: AdminContext,
  id: string,
): Promise<{ value: string; account: string | null } | null> {
  const [row] = await admin.transaction((query) =>
    query<{ value_enc: Sealed; account_enc: Sealed | null }>(
      "select value_enc, account_enc from policy.capture_scope where id = $1",
      [id],
    ),
  );
  if (row === undefined) return null;
  return {
    value: open(
      admin.keys,
      { id, compartments: ownLabel(), value_enc: row.value_enc },
      "policy.capture_scope.value_enc",
      "throw",
    ),
    account:
      row.account_enc === null
        ? null
        : open(
            admin.keys,
            { id, compartments: ownLabel(), account_enc: row.account_enc },
            "policy.capture_scope.account_enc",
            "throw",
          ),
  };
}

// Removes a rule; `not_found` for an id that names none. What it admitted stays stored: the
// owner erases it with `pi erase`.
export function removeScope(admin: AdminContext, id: string): Promise<void> {
  return removeById(admin, "delete from policy.capture_scope where id = $1 returning id", id);
}
