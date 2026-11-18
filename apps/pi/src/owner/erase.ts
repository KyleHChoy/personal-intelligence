import {
  CaptureId,
  DocumentId,
  EntityId,
  ErasureId,
  EventId,
  FactId,
  GoalId,
  MessageId,
} from "@intelligence/contracts/personal";
import { withJobRun } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { codeOf, found, refusal } from "../env.ts";
import { printJson, requestId, withAdmin } from "./owner-kit.ts";

// An erasure walks every row it could touch, the standing check's among them, so it holds every key.
const walking: typeof withAdmin = (context, fn, options = {}) => withAdmin(context, fn, { ...options, everyKey: true });

// The owner's erasure: `pi erase item`, `person`, `list`,
// `lift` and `replay`, each a thin call into the Admin through `withAdmin`. Each prints ids,
// kinds, counts and times only. `replay` is the one owner command that runs while the journal
// and the database differ.

const dryRun = (context: CommandContext): boolean => context.values["dry-run"] === true;
const positional = (context: CommandContext): string => context.positionals[0] ?? "";

// An item by its `msg_`, `evt_` or `doc_` id, a capture item's `cap_`, a goal's `gol_`, or a note's
// id; any other id is a usage error.
export const eraseItem = (context: CommandContext): Promise<0> => {
  const id = positional(context);
  const ref = MessageId.safeParse(id).success
    ? ({ kind: "message", id: id as MessageId } as const)
    : EventId.safeParse(id).success
      ? ({ kind: "event", id: id as EventId } as const)
      : DocumentId.safeParse(id).success
        ? ({ kind: "document", id: id as DocumentId } as const)
        : CaptureId.safeParse(id).success
          ? ({ kind: "capture", id: id as CaptureId } as const)
          : null;
  // A goal the owner set, by its `gol_` id: its owner_command items.
  if (ref === null && GoalId.safeParse(id).success)
    return walking(context, async (admin) =>
      printJson(
        context,
        await admin.erasure.eraseGoal(id as GoalId, { requestId: requestId(12), dryRun: dryRun(context) }),
      ),
    );
  // An owner_command item by a claim of it, a note's id.
  if (ref === null && FactId.safeParse(id).success)
    return walking(context, async (admin) =>
      printJson(
        context,
        await admin.erasure.eraseOwnerItem(id as FactId, { requestId: requestId(12), dryRun: dryRun(context) }),
      ),
    );
  if (ref === null) throw refusal("usage");
  return walking(context, async (admin) =>
    printJson(context, await admin.erasure.eraseItem(ref, { requestId: requestId(12), dryRun: dryRun(context) })),
  );
};

export const erasePerson = (context: CommandContext): Promise<0> => {
  const parsed = EntityId.safeParse(positional(context));
  if (!parsed.success) throw refusal("usage");
  return walking(context, async (admin) =>
    printJson(
      context,
      await admin.erasure.erasePerson(parsed.data, { requestId: requestId(12), dryRun: dryRun(context) }),
    ),
  );
};

export const eraseList = (context: CommandContext): Promise<0> =>
  walking(context, async (admin) => printJson(context, await admin.erasure.listErasures()));

// Prints nothing. An id that is no erasure, or one already lifted, is `not_found`.
export const eraseLift = (context: CommandContext): Promise<0> => {
  const parsed = ErasureId.safeParse(positional(context));
  if (!parsed.success) throw refusal("usage");
  return walking(context, async (admin) => {
    found(await admin.erasure.liftErasure(parsed.data, { requestId: requestId(12) }));
  });
};

export const eraseReplay = (context: CommandContext): Promise<0> =>
  walking(context, async (admin) => printJson(context, await admin.erasure.replayErasures()), {
    level: "skip",
    everyKey: true,
  });

// Lens: `pi erase settle [--limit N]`, the forgets from a Mac applied as
// erasures of kind device_forget, at most N (1 to 500, 50 when unset), printing the counts
// settled, already removed and failed. While a sync holds its lock it answers `sync_running`.
//
// One ledger.job_runs row at its end, whatever its outcome, as
// pi_admin; a usage error is no run. A row that cannot be written is logged by its code.
export const eraseSettle = async (context: CommandContext): Promise<0> => {
  const { limit } = context.values;
  if (limit !== undefined && !(typeof limit === "string" && /^[1-9]\d{0,2}$/.test(limit) && Number(limit) <= 500))
    throw refusal("usage");
  return withJobRun(
    { url: context.env.PI_DATABASE_URL_ADMIN ?? "", log: context.log },
    { job: "erase_settle" },
    () =>
      walking(context, async (admin) =>
        printJson(context, await admin.lens.settleForgets(limit === undefined ? 50 : Number(limit))),
      ),
    { ofError: codeOf },
  );
};
