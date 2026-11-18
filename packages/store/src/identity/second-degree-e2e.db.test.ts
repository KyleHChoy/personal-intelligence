import type { Claim } from "@intelligence/contracts";
import {
  type ClaimRecord,
  ContextPack,
  DECISION_POINT_PINS,
  type DecisionPointCall,
  type EntityId,
  EventId,
  FiledMention,
  type GoalId,
  type OpportunityId,
  type SecondDegreeLine,
} from "@intelligence/contracts/personal";
import { namedKey } from "@intelligence/personal-core";
import type { CalendarPerson } from "@intelligence/personal-core/items";
import { planGapFlags } from "@intelligence/personal-core/planner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { createWork, type Work } from "../agent-work/work.ts";
import { openUnder } from "../core/seal.ts";
import { createPipeline, type Pipeline } from "../pipeline/pipeline.ts";
import { Reader } from "../read/read.ts";
import { type Accounts, connect, OWNER, type Who } from "../test-support/cast.ts";
import { ALL_TOOLS, request, sha256Hex, testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { event, ingestEvent, type MailFixture, mail } from "../test-support/items.ts";
import { batchOf, claimRecord, stored } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { AGENT_WORK_TOOLS, insertWorkClient, type WorkClient } from "../test-support/work-clients.ts";
import { ok } from "../test-support/work-test-world.ts";
import { createDispatch } from "../work/dispatch.ts";
import { namedScope } from "../write/named-binding.ts";

// The second degree end to end on the synthetic world. The owner names their goal's target with `pia goal
// target --name`; Ada, whom the owner mails both ways, writes that Ada will introduce the owner to that
// person; the extraction run files the name (committed here as the pipeline commits it: no model is called);
// the sync binds it; the replay commits Ada's claim; then the path, the meeting_prep line, the intro_path
// task the tick raises on the board, and an agent's `introduction` proposal reaching the owner's card. Then
// the same name under two labels, the owner's goal under `own` and Wren's mail under `employer:example`: two
// named people, and the identity sweep's same-person card, the known cross-label limit. The tick's steps are
// the store's own calls, in tick.ts's order; the decision step's escalated call is written out, since the
// ladder is the app's (an `introduction` is always carded: no intent may list it). Synthetic people only.

const NOW = new Date("2026-10-01T09:00:00Z");
const OWN = ["own"];
const WORK = ["employer:example"];
const TOOLS = [...ALL_TOOLS, ...AGENT_WORK_TOOLS, "find_paths", "build_context_pack", "list_goals"];

const ME: Who = { address: OWNER.personal, name: OWNER.name };
const ME_AT_WORK: Who = { address: OWNER.work, name: OWNER.name };
const ADA: Who = { address: "ada.fenn@second-degree-e2e.test", name: "Ada Fenn" };
const WREN: Who = { address: "wren.oak@second-degree-e2e-work.test", name: "Wren Oak" };

let store: TestStore;
let pipeline: Pipeline;
let accounts: Accounts;
let reader: Reader;
let work: Work;
let scout: WorkClient;
let meeting: string;
let ada: string;

let letters = 0;
const letter = (from: Who, to: Who[], labels: string[] = ["INBOX"]): MailFixture => {
  letters += 1;
  const n = String(letters).padStart(4, "0");
  return mail({
    id: `gm-sd6e-${n}`,
    threadId: `thread-sd6e-${n}`,
    messageId: `sd6e-${n}@second-degree-e2e.test`,
    at: "2026-09-20T09:00:00Z",
    from,
    to,
    subject: "A note",
    labels,
  });
};

const addressFp = (address: string): string => fingerprint(store.db.keys, "address", address);
const nameFp = (name: string): string => fingerprint(store.db.keys, "name", name);
const keyFpOf = (name: string, label: string[]): string =>
  addressFp(namedKey(fingerprint(store.db.keys, "source_id", namedScope(nameFp(name), label, null))) ?? "");
const holderOf = async (fp: string): Promise<string | undefined> =>
  (
    await queryAs<{ entity_id: string }>(
      store.db.urls.admin,
      "select entity_id from knowledge.accounts where value_fp = $1 limit 1",
      [fp],
    )
  )[0]?.entity_id;
const targetOf = async (goal: string): Promise<string | null> =>
  one(
    await queryAs<{ target: string | null }>(
      store.db.urls.admin,
      "select target_entity_id as target from projections.goal_state where goal_id = $1",
      [goal],
    ),
  ).target;

// The extraction run's filing: a first-hand relation in the speaker's letter naming `name`, as
// the pipeline commits it before anyone is bound. The letter's evidence id.
async function filedLetter(speaker: Who, name: string, work = false): Promise<string> {
  const evidence = await stored(
    store.writer,
    work ? accounts.workMail : accounts.personalMail,
    letter(speaker, [work ? ME_AT_WORK : ME]),
  );
  const mention = FiledMention.parse({
    name,
    type: "intro_offer",
    field: "person",
    firstHand: true,
    subjectFp: addressFp(speaker.address),
    speakerFp: addressFp(speaker.address),
  });
  expect(await pipeline.commit(batchOf(evidence, [], { unresolved: 1, mentions: [mention] }))).toBe("committed");
  return evidence;
}

// The replay: the same item's intro_offer claim, its person now bound, committed again.
async function replayed(evidence: string, by: string, person: string, label: string[]): Promise<string> {
  const base = claimRecord(evidence, label, by, {
    n: 1,
    type: "intro_offer",
    factKey: `sd6e intro_offer ${evidence}`,
    validFrom: "2026-09-20T09:00:00.000Z",
    entities: [by, person],
  });
  const record = {
    ...base,
    claim: {
      ...base.claim,
      assertedBy: by,
      basis: "explicit_self",
      content: { ...base.claim.content, type: "intro_offer", subject: by, fields: { person, offer: "offered" } },
    } as unknown as Claim,
    subjectKind: "person",
    fieldKinds: { person: "entity", offer: "enum" },
  } as ClaimRecord;
  expect(await pipeline.commit(batchOf(evidence, [record]))).toBe("committed");
  return fingerprint(store.db.keys, "claim", record.claim.id);
}

// The tick's step 3b, as tick.ts runs it: close, then raise.
async function gapStep(): Promise<void> {
  const dispatch = createDispatch({ url: store.db.urls.work, log: recordingLogger().log, journal: "" });
  try {
    const flags = await dispatch.gapFlags(NOW);
    const plan = planGapFlags({
      candidates: await dispatch.gapCandidates(NOW),
      open: flags.open,
      history: flags.history,
    });
    for (const id of plan.close) await dispatch.closeGapFlag(id, NOW);
    for (const { gap, card } of plan.raise) await dispatch.raiseGapFlag(gap, !card);
  } finally {
    await dispatch.close();
  }
}

// The tick's step 6 for an opportunity the ladder escalates: its card for the owner.
const ESCALATED: DecisionPointCall = {
  point: "opportunity_go",
  version: 1,
  definitionHash: DECISION_POINT_PINS["opportunity_go@1"] ?? "",
  rung: 4,
  inputHash: sha256Hex("opportunity_go:escalated"),
  output: null,
  effect: null,
  effectClass: null,
  escalated: true,
};
async function decisionStep(): Promise<string[]> {
  const dispatch = createDispatch({ url: store.db.urls.work, log: recordingLogger().log, journal: "" });
  try {
    const cards: string[] = [];
    for (const listed of await dispatch.proposedOpportunities(NOW)) {
      const item = await dispatch.opportunityToDecide(listed.id, NOW);
      if (item === null) continue;
      const card = await dispatch.raiseDecisionCard(item.id, ESCALATED, NOW);
      if (card !== null) cards.push(card);
    }
    return cards;
  } finally {
    await dispatch.close();
  }
}

const attendee = (who: Who): CalendarPerson => ({
  email: who.address,
  ...(who.name === undefined ? {} : { displayName: who.name }),
  responseStatus: "accepted",
});
const MEETING_TITLE = "Coffee with Ada";

beforeAll(async () => {
  store = await openStore({ now: NOW, compartments: ["own", "employer:example"] });
  pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  accounts = await connect(store.writer);
  reader = new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => NOW });
  work = createWork({ reader, log: store.log });
  // Ada: mail both ways, an own tie. Wren: the owner's colleague, both ways, at work.
  await stored(store.writer, accounts.personalMail, letter(ME, [ADA], ["SENT"]));
  await stored(store.writer, accounts.personalMail, letter(ADA, [ME]));
  await stored(store.writer, accounts.workMail, letter(ME_AT_WORK, [WREN], ["SENT"]));
  await stored(store.writer, accounts.workMail, letter(WREN, [ME_AT_WORK]));
  ada = (await holderOf(addressFp(ADA.address))) ?? "";
  // A meeting with Ada tomorrow.
  await ingestEvent(
    store.writer,
    accounts.personalCalendar,
    event({
      event: {
        id: "evsd6e2e0001",
        status: "confirmed",
        etag: '"etag-sd6e-1"',
        updated: "2026-09-25T08:00:00Z",
        summary: MEETING_TITLE,
        start: { dateTime: "2026-10-02T15:00:00Z" },
        end: { dateTime: "2026-10-02T16:00:00Z" },
        organizer: { email: OWNER.personal, self: true },
        attendees: [
          { email: OWNER.personal, displayName: OWNER.name, responseStatus: "accepted", self: true },
          attendee(ADA),
        ],
      },
      title: MEETING_TITLE,
      startsAt: "2026-10-02T15:00:00.000Z",
      endsAt: "2026-10-02T16:00:00.000Z",
      allDay: false,
    }),
  );
  const events = await queryAs<{ id: string; compartments: string[]; title_enc: unknown }>(
    store.db.urls.admin,
    "select event_id as id, compartments, title_enc from knowledge.event_details order by event_id",
  );
  meeting =
    events.find(
      (row) =>
        row.title_enc !== null &&
        openUnder(
          store.db.keys,
          row.compartments,
          { table: "knowledge.event_details", id: row.id, column: "title_enc" },
          row.title_enc as never,
        ) === MEETING_TITLE,
    )?.id ?? "";
  // An agent of `own` that takes research tasks, and the owner's task tier on.
  scout = await insertWorkClient(store.db, "scout-sd6e", OWN, { tools: TOOLS });
  await queryAs(
    store.db.urls.admin,
    "insert into policy.harness_modes (id, client_id, opportunity_kind, stage, mode, granted_at) values ($1, $2, 'research', 'investigate', 'act', now())",
    [testId("hrn"), scout.id],
  );
  await session(store.db.urls.admin, (query) => setTaskTier(query, true, NOW));
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await pipeline?.close();
  await store?.close();
}, SLOW_DB_TEST_TIMEOUT);

describe("the second degree end to end", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("the owner's goal names Theo Marsh; Ada's offer to introduce the owner is filed, bound, replayed, walked, prepped, tasked and proposed to the owner's card", async () => {
    expect(meeting).not.toBe("");
    // The owner's goal, its target by name: nobody holds it yet.
    const goal = await store.admin.work.addGoal("Meet a landscape architect.", "own", {
      requestId: request(),
      domain: "career",
    });
    expect(await store.admin.work.targetGoalByName(goal, "Theo Marsh", { requestId: request() })).toEqual({
      kind: "pending",
    });

    // Ada's mail: the run files "Theo Marsh", said by Ada, first-hand.
    const evidence = await filedLetter(ADA, "Theo Marsh");

    // The sync: the owner's command makes the named person, and Ada's mention binds to the same one.
    expect(await store.writer.bindNamed(NOW)).toMatchObject({ commanded: 1, created: 1, bound: 2, failed: 0 });
    const theo = (await holderOf(keyFpOf("Theo Marsh", OWN))) ?? "";
    expect(theo).not.toBe("");
    expect(await targetOf(goal)).toBe(theo);
    expect(
      one(
        await queryAs<{ address_fp: string }>(
          store.db.urls.admin,
          "select address_fp from knowledge.mention_bindings where evidence_id = $1",
          [evidence],
        ),
      ).address_fp,
    ).toBe(keyFpOf("Theo Marsh", OWN));
    // Ada's item is due again with nothing bought: the replay commits Ada's claim.
    expect(
      one(
        await queryAs<{ g: number }>(
          store.db.urls.admin,
          "select extractor_generation as g from vault.pipeline_items where evidence_id = $1",
          [evidence],
        ),
      ).g,
    ).toBe(0);
    const offer = await replayed(evidence, ada, theo, OWN);

    // The path: from Ada, the owner's own tie, to Theo, by Ada's offer.
    const paths = outcomeValue(await reader.findPaths(scout.token, { target: theo as EntityId }));
    expect(paths.paths.length).toBeGreaterThan(0);
    expect(JSON.stringify(paths.paths[0])).toContain(ada);
    expect(JSON.stringify(paths.paths[0])).toContain(offer);

    // meeting_prep for the meeting with Ada: Theo, first, with the cite and the goal.
    const pack = ContextPack.parse(
      outcomeValue(
        await reader.buildContextPack(scout.token, { purpose: "meeting_prep", event: EventId.parse(meeting) }),
      ),
    );
    const lines = pack.items.flatMap((item): SecondDegreeLine[] => (item.kind === "second_degree" ? [item.line] : []));
    expect(lines[0]).toMatchObject({
      through: { id: ada },
      person: { id: theo, nameOnly: true },
      offer: "offered",
      fact: offer,
      goal: { id: goal },
    });

    // The tick raises one intro_path task on the board, about Theo, for the goal.
    await gapStep();
    const [flag, ...more] = await queryAs<{ id: string; about_id: string; goal_id: string; tier: string }>(
      store.db.urls.admin,
      "select id, about_id, goal_id, tier from ledger.opportunities where gap_trigger = 'intro_path'",
    );
    expect(more).toEqual([]);
    expect(flag).toMatchObject({ about_id: theo, goal_id: goal, tier: "task" });

    // The agent claims it: the brief names Ada and the goal.
    const claimed = ok(
      await work.claimOpportunity(scout.token, { id: flag?.id as OpportunityId, requestId: request() }),
    );
    expect(claimed.brief?.introPath?.introducers).toEqual([ada]);
    expect(claimed.brief?.introPath?.goals).toEqual([goal]);

    // It proposes the introduction, citing Ada's message; the tick's decision step cards it.
    const [message] = await queryAs<{ id: string }>(
      store.db.urls.admin,
      "select id from knowledge.messages where evidence_id = $1",
      [evidence],
    );
    const proposed = ok(
      await work.proposeOpportunity(scout.token, {
        kind: "introduction",
        about: { kind: "entity", id: theo as EntityId },
        summary: "Ask Ada to introduce the owner to Theo Marsh.",
        basis: [{ kind: "message", id: message?.id as never }],
        requestId: request(),
      }),
    );
    const cards = await decisionStep();
    const [card] = await queryAs<{
      id: string;
      kind: string;
      target_kind: string;
      target_id: string;
      compartments: string[];
    }>(
      store.db.urls.admin,
      "select id, kind, target_kind, target_id, compartments from ledger.cards where target_id = $1",
      [proposed.opportunity],
    );
    expect(card).toMatchObject({ kind: "opportunity_decision", target_kind: "opportunity", compartments: OWN });
    expect(cards).toContain(card?.id);
  });

  it("the known cross-label limit: the owner's goal under own and Wren's mail under employer:example make two named people, and the identity sweep cards the pair", async () => {
    const goal: GoalId = await store.admin.work.addGoal("Meet a structural engineer.", "own", {
      requestId: request(),
      domain: "career",
    });
    expect(await store.admin.work.targetGoalByName(goal, "Juno Pike", { requestId: request() })).toEqual({
      kind: "pending",
    });
    const evidence = await filedLetter(WREN, "Juno Pike", true);
    expect(await store.writer.bindNamed(NOW)).toMatchObject({ commanded: 1, created: 2, failed: 0 });
    const mine = (await holderOf(keyFpOf("Juno Pike", OWN))) ?? "";
    const theirs = (await holderOf(keyFpOf("Juno Pike", WORK))) ?? "";
    expect(mine).not.toBe("");
    expect(theirs).not.toBe("");
    expect(theirs).not.toBe(mine);
    expect(await targetOf(goal)).toBe(mine);
    expect(
      one(
        await queryAs<{ address_fp: string }>(
          store.db.urls.admin,
          "select address_fp from knowledge.mention_bindings where evidence_id = $1",
          [evidence],
        ),
      ).address_fp,
    ).toBe(keyFpOf("Juno Pike", WORK));

    // The sweep's same-person question on the shared full name: a card, not a merge, since a named
    // person is not established.
    await store.writer.proposeIdentity(NOW);
    const pairs = await queryAs<{ kind: string; created_by: string }>(
      store.db.urls.admin,
      `select c.kind, c.created_by from ledger.cards c where c.kind = 'same_person' and c.created_by = 'system:identity'
         and exists (select 1 from ledger.basis b where b.row_kind = 'card' and b.row_id = c.id and b.ref_id = $1)
         and exists (select 1 from ledger.basis b where b.row_kind = 'card' and b.row_id = c.id and b.ref_id = $2)`,
      [mine, theirs],
    );
    expect(pairs).toEqual([{ kind: "same_person", created_by: "system:identity" }]);
    // Not merged: two people still.
    expect(
      await queryAs(
        store.db.urls.admin,
        "select 1 from knowledge.identity_rulings where lifted_at is null and verdict = 'same'",
      ),
    ).toEqual([]);
  });
});
