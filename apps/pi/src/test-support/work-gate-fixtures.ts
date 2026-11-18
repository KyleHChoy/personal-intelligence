import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventId, MessageId } from "@intelligence/contracts/personal";
import { repoRoot } from "@intelligence/personal-core";
import type { GmailMessage } from "@intelligence/personal-core/items";
import { afterAll, expect } from "vitest";
import {
  copyHarness,
  type Harness,
  type HarnessOptions,
  HOUR,
  type Outcome,
  type Result,
  value,
  workHarness,
} from "./work-harness.ts";

// What the work-gate-*.db.test.ts files share.
//
// Durable work's gate tests W1 to W8 and W10 to W15, each from the state the sequence of
// work.e2e.db.test.ts builds, through the shared harness, with one thing changed. The real `pi`
// process, the agent API behind each client's wrapper (pi mcp's, served with no deadline waits),
// and the reasoner's runOnce with a recorded model. Ticks run as the real process, or in this
// process when the test moves the tick's clock.

export const LONG = 600_000;
export const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
export const REASONER_MAIN = join(repoRoot(), "apps/reasoner/src/main.ts");
export const NOT_PERMITTED: Outcome = { ok: false, code: "not_permitted" };
export const NOT_FOUND: Outcome = { ok: false, code: "not_found" };
export const HANDED_LINE =
  "no registered agent can carry this out before the send item is built; go means you will do it yourself";

// The gate tests are about what work does, not when the agent API answers: their clients' wrappers
// start the stand-in for pi mcp that waits no reply deadline (mcp-fixtures.ts). The sequence's own
// test, work.e2e.db.test.ts, keeps the real pi mcp.
//
// A file runs the sequence once for each set of options, and each test gets a copy of where it
// ended (copyHarness): the same rows, ids and tokens, a database and folder of its own. A test
// whose options change the world before the first sync (`prepare`) runs the sequence itself. The
// templates are dropped when the file ends.
const templates = new Map<string, Promise<Harness>>();
afterAll(async () => {
  const all = [...templates.values()];
  templates.clear();
  for (const one of await Promise.allSettled(all)) if (one.status === "fulfilled") await one.value.cleanup();
});

async function harnessFor(options: HarnessOptions): Promise<Harness> {
  if (options.prepare !== undefined) return workHarness(options);
  const which = JSON.stringify(options);
  let template = templates.get(which);
  if (template === undefined) {
    template = workHarness(options).then(async (h) => {
      await h.release();
      return h;
    });
    templates.set(which, template);
    template.catch(() => templates.delete(which));
  }
  return copyHarness(await template);
}

export async function withHarness<T>(options: HarnessOptions, fn: (h: Harness) => Promise<T>): Promise<T> {
  const h = await harnessFor({ atOnce: true, ...options });
  try {
    return await fn(h);
  } finally {
    await h.cleanup();
  }
}

export const ok = (result: Result, what = "command"): Result => {
  expect(result, what).toMatchObject({ exit: 0 });
  return result;
};
export const count = async (h: Harness, table: string, where = "true", values: unknown[] = []): Promise<number> =>
  (await h.rows<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`, values))[0]?.n ?? 0;
export const cardsOn = (
  h: Harness,
  target: string,
): Promise<{ id: string; kind: string; author: string; state: string }[]> =>
  h.rows(
    `select c.id, c.kind, c.created_by as author,
       (select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) as state
     from ledger.cards c where c.target_id = $1 order by c.created_at, c.id`,
    [target],
  );
export const decisionsOf = (
  h: Harness,
  opportunity: string,
): Promise<{ decision: string; decided_by: string; reason: string }[]> =>
  h.rows(
    "select decision, decided_by, reason from ledger.opportunity_decisions where opportunity_id = $1 order by id",
    [opportunity],
  );
export const ruleOf = async (h: Harness, card: string, answerWith: string): Promise<void> => {
  ok(await h.owner(["decide", card, "--answer", answerWith]), `decide ${answerWith}`);
};
export const caseOf = async (h: Harness, opportunity: string): Promise<string> =>
  (await h.rows<{ case_id: string }>("select case_id from ledger.opportunities where id = $1", [opportunity]))[0]
    ?.case_id ?? "";

// A proposal of one kind about one ref, resting on refs, as a recorded model writes it.
export type Ref = { kind: string; id: string };
export const propose = (
  kind: string,
  about: Ref | { kind: "owner" },
  basis: Ref[],
  summary = `A ${kind} worth doing`,
) => ({ do: "propose", kind, about, summary, basis });
export const msg = (id: MessageId | string): Ref => ({ kind: "message", id });
export const evt = (id: EventId | string): Ref => ({ kind: "event", id });

// A message of the test's own, on reserved domains, `hoursAgo` before the world's now.
export function mail(
  h: { worldNow: Date },
  id: string,
  more: {
    from: string;
    to: string;
    subject: string;
    hoursAgo: number;
    labels?: string[];
    threadId?: string;
    headers?: { name: string; value: string }[];
  },
): GmailMessage {
  const internalDate = Math.floor(h.worldNow.getTime() / 1000) * 1000 - more.hoursAgo * HOUR;
  return {
    id,
    threadId: more.threadId ?? id,
    internalDate,
    labelIds: more.labels ?? ["INBOX"],
    headers: [
      { name: "From", value: more.from },
      { name: "To", value: more.to },
      { name: "Date", value: new Date(internalDate - 60_000).toUTCString().replace("GMT", "+0000") },
      { name: "Subject", value: more.subject },
      { name: "Message-ID", value: `<${id}@id.example.com>` },
      ...(more.headers ?? []),
    ],
    text: "A short note.\r\n",
  };
}

export const header = (message: GmailMessage, name: string): string =>
  message.headers.find((one) => one.name === name)?.value ?? "";
// The world's stranger: an inbound message in a thread of its own, which the owner never answered.
export const isRecipe = (one: GmailMessage): boolean => header(one, "Subject") === "Recipe";
// The owner's own sent messages to one person each, but the one the sequence cites.
export const ownerSent = (h: Harness): GmailMessage[] =>
  h.w.accounts[0]?.messages.filter(
    (one) =>
      one.labelIds.length === 1 &&
      one.labelIds[0] === "SENT" &&
      !header(one, "To").includes(",") &&
      one.id !== h.ids.citedGmail,
  ) ?? [];

// The owner-backed events of `own` but the sequence's meeting, by id.
export const otherEvents = async (h: Harness): Promise<EventId[]> =>
  (
    await h.rows<{ id: EventId }>(
      "select e.id from knowledge.events e where e.compartments = '{own}' and ledger.owner_backed('event', e.id) and e.id <> $1 order by e.id collate \"C\"",
      [h.ids.event],
    )
  ).map((row) => row.id);

// The worker's answers about one opportunity id, for a comparison with another.
export async function answersAbout(
  worker: Awaited<ReturnType<Harness["client"]>>,
  id: string,
  dueAt: string,
  tag: string,
): Promise<unknown[]> {
  return [
    await worker.tool("claim_opportunity", { id, requestId: `${tag}-claim` }),
    await worker.tool("plan_move", { opportunity: id, stage: "prepare", requestId: `${tag}-plan` }),
    await worker.tool("release_opportunity", { id, requestId: `${tag}-release` }),
    await worker.tool("set_intention", { opportunity: id, kind: "check_back", dueAt, requestId: `${tag}-intention` }),
  ];
}

export const listed = async (
  worker: Awaited<ReturnType<Harness["client"]>>,
  scope: "open" | "mine" = "open",
): Promise<string[]> =>
  (
    (value(await worker.tool("list_opportunities", { scope })) as { opportunities: { id: string }[] }).opportunities ??
    []
  ).map((one) => one.id);
