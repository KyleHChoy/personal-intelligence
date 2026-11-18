import { TrustGroupId } from "@intelligence/contracts";
import {
  ClientName,
  CodedError,
  EntityId,
  IgnoreTarget,
  MentionBindingId,
  type MentionCandidate,
  MentionId,
  RulingId,
} from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import { completeKeyedWithReplay, createDecideClient } from "@intelligence/personal-models";
import {
  type Admin,
  createWriter,
  DECIDE_IDENTITY,
  IDENTITY_DECIDE_ON,
  IDENTITY_POINTS,
  type IdentityDecideModel,
  journalPath,
  loadKeys,
  type Writer,
} from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { type Env, found, refusal, restrictedKeyFile } from "../env.ts";
import { decideModelOf, pseudonymised, retainedResendOf } from "../extract/extract-config.ts";
import { printJson, requestId, withAdmin, withNamed } from "./owner-kit.ts";

// Each takes entity ids or a ruling id, never an address, so nothing of a person is in a shell's
// history; and each prints ids, verdicts, counts and times only. `role`, `person` and `ignore add`
// also take an address or a domain, for a mailbox that has no person to name.

// An entity id, or a usage error: an address given where an id is wanted is one.
function entity(value: string | undefined): EntityId {
  const parsed = EntityId.safeParse(value);
  if (!parsed.success) throw refusal("usage");
  return parsed.data;
}

// Prints the ruling a command wrote, or, for one already in force, `already_settled` with the
// ids of the rulings that settle it, writing nothing.
async function printRuling(context: CommandContext, write: () => Promise<string>): Promise<void> {
  try {
    printJson(context, { ruling: await write() });
  } catch (error) {
    const { code, rulings } = error as { code?: unknown; rulings?: unknown };
    if (code !== "already_settled" || !Array.isArray(rulings)) throw error;
    printJson(context, { code, rulings });
  }
}

// A `same` or `different` ruling between two people.
const link = (verdict: "same" | "different") => (context: CommandContext) => {
  const [a, b] = [entity(context.positionals[0]), entity(context.positionals[1])];
  return withAdmin(context, (admin) =>
    printRuling(context, () => admin.identity.linkPeople(a, b, verdict, { requestId: requestId(12) })),
  );
};

export const identityLink = link("same");
export const identityDiffer = link("different");

export const identityShare = (context: CommandContext): Promise<0> => {
  const id = entity(context.positionals[0]);
  return withAdmin(context, (admin) =>
    printRuling(context, () => admin.identity.markShared(id, { requestId: requestId(12) })),
  );
};

export const identityList = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => printJson(context, await admin.identity.listIdentity()));

// The owner's mark that an address is a function's
// mailbox (`role`) or one person's (`person`), deciding over the pinned list. It takes a person's
// id, as `share` does, or the address itself, since a role address has no person;
// it prints the ruling's id alone.
function markTarget(value: string | undefined): { entity: EntityId } | { address: string } {
  const id = EntityId.safeParse(value);
  if (id.success) return { entity: id.data };
  if (value === undefined || !value.includes("@")) throw refusal("usage");
  return { address: value };
}

const mark = (verdict: "role" | "person") => (context: CommandContext) => {
  const target = markTarget(context.positionals[0]);
  return withAdmin(context, (admin) =>
    printRuling(context, () => admin.identity.markAddress(target, verdict, { requestId: requestId(12) })),
  );
};

export const identityRole = mark("role");
export const identityPerson = mark("person");

// Counts of what the list and the marks change in the stored accounts; `--dry-run` writes
// nothing. Claims are never edited: a person left with no person's account is withheld.
export const identityReclassify = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) =>
    printJson(context, await admin.identity.reclassifyAccounts({ dryRun: context.values["dry-run"] === true })),
  );

// The owner's ignore list. `add` takes `account ADDRESS`, `entity ENT` or
// `domain DOMAIN`; `list` and `lift` print ids, counts and times only.
export const ignoreAdd = (context: CommandContext): Promise<0> => {
  const target = IgnoreTarget.safeParse(context.positionals[0]);
  const value = context.positionals[1];
  if (!target.success || value === undefined || value === "") throw refusal("usage");
  return withAdmin(context, (admin) =>
    printRuling(context, () => admin.ignores.addIgnore(target.data, value, { requestId: requestId(12) })),
  );
};

export const ignoreList = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => printJson(context, await admin.ignores.listIgnore()));

export const ignoreLift = (context: CommandContext): Promise<0> => {
  return withNamed(context, RulingId, async (admin, id) => {
    found(await admin.ignores.liftIgnore(id, { requestId: requestId(12) }));
    printJson(context, { lifted: id });
  });
};

// An id that is no identity ruling, or one already lifted, is `not_found`.
export const identityLift = (context: CommandContext): Promise<0> => {
  return withNamed(context, RulingId, async (admin, id) => {
    found(await admin.identity.liftIdentity(id, { requestId: requestId(12) }));
    printJson(context, { lifted: id });
  });
};

// `PI_DECIDE_MODEL`, as `pi extract` reads
// it, and `PI_IDENTITY_MAX_CALLS`, live calls in one sweep, 1 to 500, default 50. Each is checked
// before any connection, whether the ranking is on or not.
function maxCallsOf(env: Env): number {
  const value = env.PI_IDENTITY_MAX_CALLS ?? "";
  if (value === "") return 50;
  if (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > 500) throw refusal("usage");
  return Number(value);
}

const MODEL_KEY = "openrouter/key";
const RANK = IDENTITY_POINTS[0];

// The sweep's decide model, on the sealed key, or the test's client: each pair through
// completeKeyedWithReplay over vault.decision_calls. With `mayCall` false the client is never
// reached, so only a saved answer comes back. A call that reached the vendor and failed, a
// rejection among them, is no answer and counts against the cap; any other failure is the sweep's.
// Its usage and exposure are not recorded: its call rows, its exposure and a spend line must be
// built before IDENTITY_DECIDE_ON is turned on, and no call is
// made before it.
async function sweepDecideModel(
  context: CommandContext,
  admin: Admin,
  modelId: string,
  maxCalls: number,
): Promise<IdentityDecideModel> {
  const { deps } = context;
  let client = deps.decideModel;
  if (client === undefined) {
    const apiKey = await admin.secrets.secret(MODEL_KEY);
    if (apiKey === null || apiKey === "") throw refusal("no_model_key");
    client = createDecideClient({
      apiKey,
      model: modelId,
      registry: [DECIDE_IDENTITY],
      onUsage: async () => {},
      ...retainedResendOf(context),
      deps: { ...(deps.modelFetch === undefined ? {} : { fetch: deps.modelFetch }), ...pseudonymised(context.env) },
    });
  }
  const decideClient = client;
  const store = admin.calibration.decisionCalls();
  return {
    maxCalls,
    async ask(pair, mayCall) {
      let live = false;
      const gated: typeof decideClient = {
        ...decideClient,
        complete: (request) => {
          if (!mayCall) return Promise.reject(new CodedError("no_live_call"));
          live = true;
          return decideClient.complete(request);
        },
      };
      try {
        const response = await completeKeyedWithReplay(
          gated,
          store,
          {
            promptId: DECIDE_IDENTITY.id,
            promptVersion: DECIDE_IDENTITY.version,
            data: { pair: pair.pair },
            label: { compartments: pair.compartments, readers: [THE_OWNER] },
            trustGroup: TrustGroupId.parse("personal-openrouter"),
          },
          {
            point: RANK?.id ?? "identity_rank",
            version: RANK?.version ?? 1,
            subject: pair.subject,
            refs: pair.refs,
            modelId,
          },
          pair.compartments,
          [DECIDE_IDENTITY],
        );
        return { p: (response.output as { same_person: number }).same_person, live };
      } catch (error) {
        if (live) return { p: undefined, live };
        throw error;
      }
    },
  };
}

// The sweep proposes and never decides. It refuses with
// `sync_running` while a sync holds the lock, and writes nothing then. The decide model's ranking is passed only
// when IDENTITY_DECIDE_ON. `--dry-run` prints what a sweep would
// merge and card, by basis and exception, with each pair's people, and writes nothing, whatever the
// switch says.
export const identitySweep = (context: CommandContext): Promise<0> => {
  if (context.values["dry-run"] === true)
    return withAdmin(context, async (admin) => printJson(context, await admin.identity.dryRunIdentity()));
  const decideModelId = decideModelOf(context.env);
  const maxCalls = maxCallsOf(context.env);
  return withAdmin(context, async (admin) => {
    const decideModel =
      IDENTITY_DECIDE_ON && decideModelId !== undefined
        ? await sweepDecideModel(context, admin, decideModelId, maxCalls)
        : undefined;
    printJson(
      context,
      await admin.identity.proposeIdentity({ now: new Date(), ...(decideModel === undefined ? {} : { decideModel }) }),
    );
  });
};

// `pi identity dream-merges`: the dream pass's merge candidates, as the sweep weighs them, run by the
// timer after each pass so no merge waits on a hand-run sweep. Counts only.
export const identityDreamMerges = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => printJson(context, await admin.identity.dreamMerges()));

// `pi identity merges on|off` sets the owner's switch for automatic
// merges; `pi identity merges --auto [--lifted]` lists the policy's merges in force, or every one,
// each with its ruling id, people, basis and time.
export const identityMerges = (context: CommandContext): Promise<0> => {
  const [value] = context.positionals;
  const listing = context.values.auto === true;
  if (
    listing === (value !== undefined) ||
    (value !== undefined && value !== "on" && value !== "off") ||
    (!listing && context.values.lifted === true)
  )
    throw refusal("usage");
  return withAdmin(context, async (admin) => {
    if (value === "on" || value === "off") {
      await admin.identity.setIdentityMerges(value);
      printJson(context, { identityMerges: value });
      return;
    }
    printJson(context, await admin.identity.listIdentity({ policy: { lifted: context.values.lifted === true } }));
  });
};

// `pi identity agents on|off` sets the owner's switch for agents answering same-person pairs; with no
// value it lists their answers: who said what, citing what, the ruling and whether it stands.
export const identityAgents = (context: CommandContext): Promise<0> => {
  const [value] = context.positionals;
  if (value !== undefined && value !== "on" && value !== "off") throw refusal("usage");
  return withAdmin(context, async (admin) => {
    if (value === "on" || value === "off") {
      await admin.identity.setIdentityAgents(value);
      printJson(context, { identityAgents: value });
      return;
    }
    printJson(context, await admin.identity.listIdentityAnswers());
  });
};

// `pi rules list`: every rule proposed from the owner's answers; `pi rules lift ID`: one stops at once.
// It prints the cards the rule stopped, which stay stopped until `pi cards reopen CARD`.
export const rulesList = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => printJson(context, await admin.identity.listQuestionRules()));
export const rulesLift = (context: CommandContext): Promise<0> => {
  const [id] = context.positionals;
  if (id === undefined) throw refusal("usage");
  return withAdmin(context, async (admin) => printJson(context, await admin.identity.liftQuestionRule(id)));
};

// `pi identity thin`: the live joins that rest on little, each with its ruling id, people, who
// made it, basis and why it is thin. Nothing changes.
export const identityThin = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => printJson(context, await admin.identity.listThinMerges()));

// `pi identity local-names-backfill`, as pi_writer under the sync lock: the local-part name
// fingerprints of every account that has none. Counts only; a rerun changes nothing.
export async function identityLocalNamesBackfill(context: CommandContext): Promise<0> {
  const { env, log } = context;
  const keyFile = env.PI_KEY_FILE ?? "";
  const keys = await loadKeys(keyFile, restrictedKeyFile(env));
  const writer = createWriter({ url: env.PI_DATABASE_URL_WRITER ?? "", keys, log, journal: journalPath(keyFile) });
  try {
    if ((await writer.erasureLevel()) === "behind") throw refusal("erasure_replay_needed");
    const done = await writer.withSyncLock(() => writer.backfillLocalNames());
    if (done === "already_running") throw refusal("sync_running");
    printJson(context, done);
    return 0;
  } finally {
    await writer.close();
  }
}

// `pi capture lines-backfill [--dry-run]`, run on the
// box as `pi-sync capture lines-backfill`: every stored source moment whose facts lack `lines`
// sealed again with them, from its stored item, and its lines_fp nulled, so the next sync derives
// its chat lines. Prints `{ moments, missing, filled, failed }`; a dry run fills nothing.
export async function captureLinesBackfill(context: CommandContext): Promise<0> {
  const { env, log, values } = context;
  const keyFile = env.PI_KEY_FILE ?? "";
  const keys = await loadKeys(keyFile, restrictedKeyFile(env));
  const writer = createWriter({ url: env.PI_DATABASE_URL_WRITER ?? "", keys, log, journal: journalPath(keyFile) });
  try {
    if ((await writer.erasureLevel()) === "behind") throw refusal("erasure_replay_needed");
    const done = await writer.withSyncLock(() => writer.backfillChatLines({ dryRun: values["dry-run"] === true }));
    if (done === "already_running") throw refusal("sync_running");
    printJson(context, done);
    return 0;
  } finally {
    await writer.close();
  }
}

// Refused with `contacts_connected` while the label's contacts token
// exists.
export const contactsRemove = (context: CommandContext): Promise<0> => {
  const label = context.positionals[0];
  if (!ClientName.safeParse(label).success) throw refusal("usage");
  return withAdmin(context, async (admin) =>
    printJson(context, await admin.identity.removeContacts(label ?? "", { requestId: requestId(12) })),
  );
};

// Ids, counts and code words only, but for a filed name, which `mentions` prints to a terminal and
// to nothing else.

// The candidates as printed: the name left out unless standard output is a terminal.
export function mentionLines(candidates: readonly MentionCandidate[], terminal: boolean): Record<string, unknown>[] {
  return candidates.map(({ name, ...rest }) => (terminal ? { ...rest, name: name.untrusted } : rest));
}

export const identityMentions = (context: CommandContext): Promise<0> => {
  // `--summary`, the filed rows' counts by type, field, has_speaker
  // and first_hand, no name, to the owner's terminal only.
  if (context.values.summary === true) {
    if (context.values.limit !== undefined) throw refusal("usage");
    if (!context.io.stdoutIsTTY) throw refusal("not_a_terminal");
    return withAdmin(context, async (admin) => printJson(context, await admin.mentions.summarizeMentions()));
  }
  const given = context.values.limit;
  const limit = typeof given === "string" ? Number(given) : undefined;
  if (limit !== undefined && (!/^[0-9]{1,2}$/.test(given as string) || limit < 1 || limit > 50)) throw refusal("usage");
  return withAdmin(context, async (admin) =>
    printJson(
      context,
      mentionLines(await admin.mentions.listMentions(limit === undefined ? {} : { limit }), context.io.stdoutIsTTY),
    ),
  );
};

// The binding, or, for a name bound in that item already, `already_settled` with
// the binding's id, writing nothing. An unknown mention or person is `not_found`.
export const identityBind = (context: CommandContext): Promise<0> => {
  const mention = MentionId.safeParse(context.positionals[0]);
  if (!mention.success) throw refusal("usage");
  const person = entity(context.positionals[1]);
  return withAdmin(context, async (admin) => {
    try {
      printJson(context, {
        binding: await admin.mentions.bindMention(mention.data, person, { requestId: requestId(12) }),
      });
    } catch (error) {
      const { code, rulings } = error as { code?: unknown; rulings?: unknown };
      if (code !== "already_settled" || !Array.isArray(rulings)) throw error;
      printJson(context, { code, bindings: rulings });
    }
  });
};

// The bindings the sync's participant step made, in force, ids alone.
export const identityBindings = (context: CommandContext): Promise<0> => {
  const given = context.values.limit;
  const limit = typeof given === "string" ? Number(given) : undefined;
  if (limit !== undefined && (!/^[0-9]{1,2}$/.test(given as string) || limit < 1 || limit > 50)) throw refusal("usage");
  return withAdmin(context, async (admin) =>
    printJson(context, await admin.mentions.listCodeBindings(limit === undefined ? {} : { limit })),
  );
};

// An id that names no binding in force is `not_found`.
export const identityUnbind = (context: CommandContext): Promise<0> => {
  return withNamed(context, MentionBindingId, async (admin, id) => {
    found(await admin.mentions.unbindMention(id, { requestId: requestId(12) }));
    printJson(context, { unbound: id });
  });
};

// Run once over a store extracted before mentions were filed; the next `pi extract`
// replays and files at no cost.
export const identityRefile = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => printJson(context, await admin.mentions.refileMentions()));

// The two contact commands: as pi_writer, under the sync lock, once the erasures made since a restore
// are applied. Prints counts only.
async function underSyncLock(context: CommandContext, run: (writer: Writer) => Promise<unknown>): Promise<0> {
  const { env, log } = context;
  const keyFile = env.PI_KEY_FILE ?? "";
  const keys = await loadKeys(keyFile, restrictedKeyFile(env));
  const writer = createWriter({ url: env.PI_DATABASE_URL_WRITER ?? "", keys, log, journal: journalPath(keyFile) });
  try {
    if ((await writer.erasureLevel()) === "behind") throw refusal("erasure_replay_needed");
    const done = await writer.withSyncLock(() => run(writer));
    if (done === "already_running") throw refusal("sync_running");
    printJson(context, done);
    return 0;
  } finally {
    await writer.close();
  }
}

// `pi contacts reclaim [--dry-run]`, as pi_writer: every
// stored contact's role and affiliation claims made again at the current contact-claims version,
// those of an older version removed with the beliefs they support, in one transaction under the
// sync lock. With `--dry-run` it counts and writes nothing. Prints counts only.
export const contactsReclaim = (context: CommandContext): Promise<0> =>
  underSyncLock(context, (writer) => writer.reclaimContacts({ dryRun: context.values["dry-run"] === true }));

// Idempotent: a second run files and binds nothing.
export const contactsFileOrgNames = (context: CommandContext): Promise<0> =>
  underSyncLock(context, (writer) => writer.fileContactOrgNames({ dryRun: context.values["dry-run"] === true }));
