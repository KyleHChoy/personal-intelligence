import { CommitmentEnding, OpenItemEnding } from "@intelligence/contracts/personal";
import { AdminError } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";
import { print, printJson, requestId, withAdmin } from "./owner-kit.ts";

// The owner's commands on commitments, each a thin call into the Admin through
// `withAdmin`. Arguments are checked before the key file is read. `list` and `closed` print a
// commitment's words or an agent's note, to a terminal alone (commands.ts refuses any other stdout).

const FACT = /^[0-9a-f]{64}$/;

function factOf(context: CommandContext): string {
  const fact = context.positionals[0];
  if (fact === undefined || !FACT.test(fact)) throw refusal("usage");
  return fact;
}

// `pi commitments list [--open]`: the commitments read the page uses, open ones first, then without
// --open the closed ones: each one's fact, direction, other party, due date, status, how late,
// `stale` (7 days past due, or undated and 30 days old) and, marked as from its source, its words
// (get_commitments' `what`: the latest claim's, a close's included). While the owner's audience is
// being rebuilt it lists none and says so.
export async function commitmentsList(context: CommandContext): Promise<0> {
  const states = context.values.open === true ? (["open"] as const) : (["open", "closed"] as const);
  return withAdmin(context, async (admin) => {
    let printed = 0;
    for (const state of states) {
      let page: Awaited<ReturnType<typeof admin.commitments.list>>;
      try {
        page = await admin.commitments.list({ state }, { whole: true });
      } catch (error) {
        if (!(error instanceof AdminError) || error.code !== "rebuilding") throw error;
        print(context, "0 commitments: the owner's audience is being rebuilt");
        return;
      }
      for (const { item, lateDays, stale } of page.commitments) {
        const late = lateDays === null ? "" : ` late:${lateDays}d`;
        print(
          context,
          `${item.belief.fact} ${item.direction} ${item.counterparty?.id ?? "-"} ${item.due ?? "undated"} ${item.belief.status}${late}${stale ? " stale" : ""} source: ${JSON.stringify(item.what?.untrusted ?? "")}`,
        );
      }
      printed += page.commitments.length;
    }
    print(context, `${printed} ${printed === 1 ? "commitment" : "commitments"}`);
  });
}

// `pi commitments close FACT --done|--cancelled|--released [--at TIME]`: the owner's close, their word.
export async function commitmentsClose(context: CommandContext): Promise<0> {
  const fact = factOf(context);
  const endings = CommitmentEnding.options.filter((ending) => context.values[ending] === true);
  const [ending] = endings;
  if (endings.length !== 1 || ending === undefined) throw refusal("usage");
  const given = context.values.at;
  const at = typeof given === "string" ? new Date(given) : undefined;
  if (at !== undefined && Number.isNaN(at.getTime())) throw refusal("usage");
  return withAdmin(context, async (admin) =>
    printJson(
      context,
      await admin.commitments.closeCommitment(fact, ending, {
        ...(at === undefined ? {} : { at }),
        requestId: requestId(),
      }),
    ),
  );
}

// `pi open-items list`: the read the page and every agent read, its words to a terminal alone.
export async function openItemsList(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    const { items } = await admin.openItems.list();
    for (const one of items)
      print(
        context,
        `${one.due ?? "undated"} ${one.overdue ? "overdue " : ""}${one.source.kind} ${one.source.id} ${one.what?.untrusted ?? ""}`,
      );
    print(context, `${items.length} open ${items.length === 1 ? "item" : "items"}`);
  });
}

const ITEM_SOURCES = ["next_step", "plan", "calendar"] as const;
const ITEM_KEY = /^(?:[0-9a-f]{64}|evt_[0-9A-HJKMNP-TV-Z]{26})$/;

// `pi open-items close SOURCE KEY --done|--dropped`: the owner's Done or Drop on an item that is no commitment.
export async function openItemsClose(context: CommandContext): Promise<0> {
  const [source, key] = context.positionals;
  const named = ITEM_SOURCES.find((one) => one === source);
  const endings = OpenItemEnding.options.filter((ending) => context.values[ending] === true);
  const [ending] = endings;
  if (named === undefined || key === undefined || !ITEM_KEY.test(key) || endings.length !== 1 || ending === undefined)
    throw refusal("usage");
  return withAdmin(context, async (admin) =>
    printJson(context, await admin.openItems.close({ source: named, key, ending }, { requestId: requestId() })),
  );
}

// `pi open-items reopen KEY`: their close ends, and the item is open again if nothing else closed it.
export async function openItemsReopen(context: CommandContext): Promise<0> {
  const key = context.positionals[0];
  if (key === undefined || !ITEM_KEY.test(key)) throw refusal("usage");
  return withAdmin(context, async (admin) =>
    printJson(context, await admin.openItems.reopen(key, { requestId: requestId() })),
  );
}

// `pi commitments reopen FACT`: every close of it in force ends, and agents must cite something newer.
export async function commitmentsReopen(context: CommandContext): Promise<0> {
  const fact = factOf(context);
  return withAdmin(context, async (admin) =>
    printJson(context, await admin.commitments.reopenCommitment(fact, { requestId: requestId() })),
  );
}

// `pi commitments closed [--by-agents] [--since DATE]`: every close, newest first.
export async function commitmentsClosed(context: CommandContext): Promise<0> {
  const given = context.values.since;
  const since = typeof given === "string" ? new Date(given) : undefined;
  if (since !== undefined && Number.isNaN(since.getTime())) throw refusal("usage");
  const byAgents = context.values["by-agents"] === true;
  return withAdmin(context, async (admin) => {
    const rows = await admin.commitments.listCloses({ byAgents, ...(since === undefined ? {} : { since }) });
    for (const row of rows) {
      print(
        context,
        `${row.at} ${row.close} ${row.fact} ${row.by} ${row.ending} ${row.state} evidence:${row.evidence.join(",") || "-"}`,
      );
      if (row.note !== null) print(context, `   agent: ${JSON.stringify(row.note)}`);
    }
    print(context, `${rows.length} ${rows.length === 1 ? "close" : "closes"}`);
  });
}

// `pia commitments agent-closes on|off`: the owner's standing release, which lets an agent's close take
// the commitment's own label so that it joins the commitment's belief.
export async function commitmentsAgentCloses(context: CommandContext): Promise<0> {
  const value = context.positionals[0];
  if (value !== "on" && value !== "off") throw refusal("usage");
  return withAdmin(context, async (admin) =>
    printJson(context, { ruling: await admin.commitments.setAgentCloses(value === "on", { requestId: requestId() }) }),
  );
}
