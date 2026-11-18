import {
  dayIn,
  type OpenItemEnding,
  OWNER_OPEN_ITEMS_MOST,
  type OwnerOpenItems,
  owedWords,
  type RulingId,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { ownerAudience } from "../../core/audience.ts";
import { stamp } from "../../core/db.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { ownerZoneOf } from "../../core/zone.ts";
import { type OpenRead, readOpenItems, servedOpenItems } from "../../read/read-open-items.ts";
import { ownerWithheld } from "../admin-owner.ts";
import { ownerCtx } from "../owner-ctx.ts";
import { ownerCommitments } from "./admin-commitments.ts";

// So the page and an agent show the same item. The owner's Done or Drop is a decision, read back
// through the definer an agent's read calls too.

export async function ownerRead(admin: AdminContext): Promise<OpenRead> {
  const { commitments } = await ownerCommitments(admin, { state: "open" }, { whole: true });
  const now = admin.now();
  return admin.transaction(async (query) => {
    const audience = await ownerAudience(query);
    if (audience.length === 0) throw new AdminError("rebuilding");
    const ctx = ownerCtx(query, admin.keys, admin.log);
    return readOpenItems(
      ctx,
      {
        audience,
        findings: [
          ...new Set([...audience, ...[...admin.keys.compartments.keys()].filter((one) => one.startsWith("agent:"))]),
        ],
        withheld: [...(await ownerWithheld(query))],
        self: true,
        work: true,
        people: true,
      },
      now,
      { items: commitments.map((one) => one.item), more: false },
    );
  });
}

// The page's list: each item the owner acts on with its verb and the rest of its words, read by
// code from its own wording.
export async function ownerOpenItems(admin: AdminContext): Promise<OwnerOpenItems> {
  const { items, more } = servedOpenItems(await ownerRead(admin), OWNER_OPEN_ITEMS_MOST).value;
  return { items: items.map((one) => (one.whoActs.kind === "owner" ? { ...one, ...owedWords(one.what) } : one)), more };
}

// The outcome report's counts: open now, and lapsed since. A commitment's lapse is its read's, by
// the closed list's `lapsed`; every other item's is this read's. Ids stay here.
export async function openItemTally(
  admin: AdminContext,
  since: Date,
  within: readonly string[],
): Promise<{ count: { value: number; parts: { people: number } }; lapsed: number }> {
  const read = await ownerRead(admin);
  const { commitments } = await ownerCommitments(admin, { state: "closed" }, { whole: true, within });
  const zone = await admin.transaction(ownerZoneOf);
  const from = dayIn(since, zone);
  return {
    count: {
      value: read.items.length,
      parts: { people: read.items.filter((one) => read.fromPeople.has(one.source.id)).length },
    },
    lapsed:
      read.lapsed.filter((one) => one.at >= since.getTime()).length +
      commitments.filter(({ item }) => item.lapsed !== undefined && item.lapsed >= from).length,
  };
}

// The label of what a key names: every claim of the fact, or the event's.
const FACT_LABEL = `select ledger.label(array(select x from knowledge.claims c cross join unnest(c.compartments) as x where c.fact_key_fp = $1)) as compartments`;
const EVENT_LABEL = "select v.compartments, v.evidence_id from knowledge.events v where v.id = $1";

// A close is of an item open now, whose read gives its fact, its words' match and its date.
export async function closeOpenItem(
  admin: AdminContext,
  item: { source: "next_step" | "plan" | "calendar"; key: string; ending: OpenItemEnding },
  options: { requestId: string },
): Promise<{ decision: RulingId }> {
  const read = await ownerRead(admin);
  const open = read.items.find((one) => one.source.id === item.key && one.source.kind === item.source);
  const rest = read.rests.get(item.key);
  if (open === undefined || rest === undefined) throw new AdminError("not_found");
  return admin.transaction(async (query) => {
    const [label] = await query<{ compartments: string[] | null; evidence_id?: string }>(
      rest.fact === null ? EVENT_LABEL : FACT_LABEL,
      [rest.fact ?? item.key],
    );
    if (label?.compartments == null || label.compartments.length === 0) throw new AdminError("not_found");
    const decision = await ownerDecision(
      query,
      {
        requestId: options.requestId,
        kind: "open_item_close",
        answer: item.ending,
        details: {
          key: item.key,
          match: rest.match,
          due: open.due ?? open.remindAt ?? null,
          source: item.source,
          at: stamp(admin.now()),
        },
        compartments: label.compartments, // What an erasure reaches it by: the fact, or an event's item, which no fact key names.
        subjectFps: rest.fact === null ? (label.evidence_id === undefined ? [] : [label.evidence_id]) : [rest.fact],
      },
      admin.now(),
    );
    return { decision };
  });
}

const CLOSE_IN_FORCE = "select decision_id from policy.open_item_closes($1::text[])";

export async function reopenOpenItem(
  admin: AdminContext,
  key: string,
  options: { requestId: string },
): Promise<{ decision: RulingId }> {
  return admin.transaction(async (query) => {
    const [repeat] = await query<{ id: RulingId }>(
      "select id from knowledge.owner_decisions where request_id = $1 and kind = 'open_item_reopen'",
      [options.requestId],
    );
    if (repeat !== undefined) return { decision: repeat.id };
    const [close] = await query<{ decision_id: string }>(CLOSE_IN_FORCE, [[key]]);
    if (close === undefined) throw new AdminError("not_closed");
    const [label] = await query<{ compartments: string[]; subject_fps: string[] }>(
      "select compartments, subject_fps from knowledge.owner_decisions where id = $1",
      [close.decision_id],
    );
    const decision = await ownerDecision(
      query,
      {
        requestId: options.requestId,
        kind: "open_item_reopen",
        details: { key, at: stamp(admin.now()) },
        compartments: label?.compartments ?? [], // Its key names what the close named, so an erasure takes both.
        subjectFps: label?.subject_fps ?? [],
      },
      admin.now(),
    );
    return { decision };
  });
}
