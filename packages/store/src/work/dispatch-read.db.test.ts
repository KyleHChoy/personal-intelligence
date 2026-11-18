import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { queryAs } from "../test-support/database.ts";
import { namesSealed, recordingStatements } from "../test-support/recording.ts";
import { refusedWith } from "../test-support/values.ts";
import { type WorkWorld, withWorkWorld } from "../test-support/work-fixtures.ts";

// Every refusal has its positive control in the same test.

const TIMEOUT = 240_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

// The calendar keys of a dispatch's candidates.
const calendarKeys = async (world: WorkWorld, now: Date): Promise<string[]> =>
  (await world.dispatch().wakeCandidates(now)).filter((one) => one.source === "calendar").map((one) => one.wakeKey);
const keyOf = (event: string, startsAt: Date): string => `calendar:${event}:${startsAt.toISOString()}`;

// A trusted basis: the owner's sent message and an inbound one in the same thread.
async function trusted(world: WorkWorld): Promise<{ sent: string; inbound: string }> {
  const sent = await world.mail({ direction: "outbound", thread: "answered" });
  const inbound = await world.mail({ direction: "inbound", thread: "answered" });
  return { sent: sent.id, inbound: inbound.id };
}

describe("the dispatcher's reads", () => {
  it(
    "a dispatch opens no sealed column",
    () =>
      withWorkWorld(async (world) => {
        const now = new Date();
        await world.reasoner(["own"]);
        const { sent, inbound } = await trusted(world);
        const event = await world.event({ startsAt: at(now, 2 * HOUR) });
        await world.opportunity({
          refs: [
            ["event", event],
            ["message", sent],
            ["message", inbound],
          ],
        });
        await world.hypothesis({ refs: [["message", inbound]] });
        const dispatch = world.dispatch();
        const { statements } = await recordingStatements(async () => {
          await dispatch.erasureLevel();
          await dispatch.killSwitch();
          await dispatch.wakeCandidates(now);
          await dispatch.wakeFacts("daily_sweep", now);
          await dispatch.proposedOpportunities(now);
          await dispatch.vetoedOpen();
          await dispatch.ownerHypothesesWithoutCard(now);
          await dispatch.handedWithoutCard();
          await dispatch.reportsWithoutCard();
          await dispatch.expired(now);
          await dispatch.dueIntentions(now);
          await dispatch.failedRunStreak();
        });
        expect(statements.length).toBeGreaterThan(10);
        expect(
          statements.filter((statement) => namesSealed(statement.text)).map((statement) => statement.text),
        ).toEqual([]);
      }),
    TIMEOUT,
  );

  // The sweep's hour and day are the owner's once they set a zone.
  it(
    "the daily sweep is due from its hour of the owner's day, keyed by that day: UTC's until they set a zone",
    () =>
      withWorkWorld(async (world) => {
        await world.reasoner(["own"]);
        await world.admin("update policy.work_settings set sweep_hour_utc = 6");
        const sweep = async (now: Date) =>
          (await world.dispatch().wakeCandidates(now))
            .filter((one) => one.source === "daily_sweep")
            .map((one) => one.wakeKey);
        // 10:30 UTC is 05:30 in Chicago, which is UTC-5 in October; 03:00 UTC on the 9th is 22:00 on the 8th there.
        const morning = new Date("2026-10-08T10:30:00Z");
        const night = new Date("2026-10-09T03:00:00Z");
        expect(await sweep(morning)).toEqual(["sweep:2026-10-08"]);
        expect(await sweep(night)).toEqual([]);
        await world.admin("update policy.owner_settings set time_zone = 'America/Chicago'");
        expect(await sweep(morning)).toEqual([]);
        expect(await sweep(night)).toEqual(["sweep:2026-10-08"]);
      }),
    TIMEOUT,
  );

  it(
    "a calendar candidate is an event inside the lead time that is not cancelled and that the owner organized or accepted",
    () =>
      withWorkWorld(async (world) => {
        const now = new Date();
        await world.reasoner(["own"]);
        const accepted = at(now, 3 * HOUR);
        const organized = at(now, 5 * HOUR);
        const acceptedEvent = await world.event({ startsAt: accepted });
        const organizedEvent = await world.event({ startsAt: organized, response: null, organized: true });
        await world.event({ startsAt: at(now, 4 * HOUR), cancelled: true });
        await world.event({ startsAt: at(now, 30 * HOUR) });
        await world.event({ startsAt: at(now, 2 * HOUR), response: "declined" });
        await world.event({ startsAt: at(now, -HOUR) });
        expect((await calendarKeys(world, now)).sort()).toEqual(
          [keyOf(acceptedEvent, accepted), keyOf(organizedEvent, organized)].sort(),
        );
      }),
    TIMEOUT,
  );

  it(
    "an invitation the owner has not answered is no candidate",
    () =>
      withWorkWorld(async (world) => {
        const now = new Date();
        await world.reasoner(["own"]);
        await world.event({ startsAt: at(now, 3 * HOUR), response: "needsAction" });
        expect(await calendarKeys(world, now)).toEqual([]);
        // The positive control: the same invitation, accepted.
        const startsAt = at(now, 4 * HOUR);
        const answered = await world.event({ startsAt, response: "accepted" });
        expect(await calendarKeys(world, now)).toEqual([keyOf(answered, startsAt)]);
      }),
    TIMEOUT,
  );

  it(
    "an event with a vetoed participant is a candidate marked vetoed",
    () =>
      withWorkWorld(async (world) => {
        const now = new Date();
        await world.reasoner(["own"]);
        const person = await world.person();
        const other = await world.person();
        const vetoedEvent = await world.event({ startsAt: at(now, 2 * HOUR), participant: person.id });
        const plainEvent = await world.event({ startsAt: at(now, 3 * HOUR), participant: other.id });
        await world.veto("person", [person.fp]);
        const candidates = (await world.dispatch().wakeCandidates(now)).filter((one) => one.source === "calendar");
        expect(candidates.map((one) => [one.anchors[0]?.id, one.vetoed]).sort()).toEqual(
          [
            [plainEvent, false],
            [vetoedEvent, true],
          ].sort(),
        );
      }),
    TIMEOUT,
  );

  it(
    "an accepted event under employer:example is no candidate when the reasoner holds own, and is one when the reasoner holds both",
    () =>
      withWorkWorld(async (world) => {
        const now = new Date();
        const reasoner = await world.reasoner(["own"]);
        const startsAt = at(now, 2 * HOUR);
        const event = await world.event({ startsAt, compartments: ["employer:example"] });
        expect(await calendarKeys(world, now)).toEqual([]);
        await world.admin("update policy.clients set compartments = $2 where id = $1", [
          reasoner.id,
          ["employer:example", "own"],
        ]);
        const [candidate] = (await world.dispatch().wakeCandidates(now)).filter((one) => one.source === "calendar");
        expect(candidate).toMatchObject({
          source: "calendar",
          wakeKey: keyOf(event, startsAt),
          compartments: ["employer:example"],
        });
      }),
    TIMEOUT,
  );

  it(
    "a goal under a compartment the reasoner lacks is no candidate",
    () =>
      withWorkWorld(async (world) => {
        const now = new Date();
        await world.reasoner(["own"]);
        await world.goal({ compartments: ["employer:example"] });
        expect((await world.dispatch().wakeCandidates(now)).filter((one) => one.source === "goal_changed")).toEqual([]);
        // The positive control: a goal under own.
        const own = await world.goal({ compartments: ["own"] });
        expect(
          (await world.dispatch().wakeCandidates(now))
            .filter((one) => one.source === "goal_changed")
            .map((one) => one.wakeKey),
        ).toEqual([`goal:${own.ruling}`]);
      }),
    TIMEOUT,
  );

  it(
    "the sweep is a candidate from the sweep hour until its key is used up",
    () =>
      withWorkWorld(async (world) => {
        await world.reasoner(["own"]);
        const before = new Date("2026-10-04T10:59:00.000Z");
        const after = new Date("2026-10-04T11:00:00.000Z");
        const sweeps = async (now: Date) =>
          (await world.dispatch().wakeCandidates(now))
            .filter((one) => one.source === "daily_sweep")
            .map((one) => one.wakeKey);
        expect(await sweeps(before)).toEqual([]);
        expect(await sweeps(after)).toEqual(["sweep:2026-10-04"]);
        await world.work(
          `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
           values ('run_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'system:work', '{own}', 'daily_sweep', 'sweep:2026-10-04', 'run_outcome', 1, 'personal_run', '1')`,
        );
        expect(await sweeps(after)).toEqual([]);
        expect(await sweeps(new Date("2026-10-05T23:00:00.000Z"))).toEqual(["sweep:2026-10-05"]);
      }),
    TIMEOUT,
  );

  it(
    "wake facts count the reasoner's deferred cards and only the pending cards within its clearance",
    () =>
      withWorkWorld(async (world) => {
        const now = new Date();
        await world.reasoner(["own"]);
        await world.card({ author: "reasoner", state: "deferred" });
        await world.card({ author: "reasoner", state: "deferred" });
        await world.card({ author: "system:work", state: "deferred" });
        await world.card({ author: "reasoner", state: "pending" });
        await world.card({ author: "system:work", state: "pending" });
        await world.card({ author: "reasoner", state: "pending", compartments: ["employer:example"] });
        await world.card({ author: "reasoner", state: "pending", compartments: ["employer:example", "own"] });
        expect(await world.dispatch().wakeFacts("daily_sweep", now)).toMatchObject({
          source: "daily_sweep",
          killSwitch: false,
          reasonerRegistered: true,
          reasonerDeferredCards: 2,
          pendingCardsInClearance: 2,
          maxPendingCards: 30,
          runsToday: 0,
          maxRunsPerDay: 12,
          spentTodayMicroUsd: 0,
          maxMicroUsdPerDay: 5_000_000,
        });
      }),
    TIMEOUT,
  );

  it(
    "runs today are counted over the UTC day, whatever the session's time zone",
    () =>
      withWorkWorld(async (world) => {
        await queryAs(
          world.db.urls.bootstrap,
          `alter role pi_work in database "${world.db.name}" set timezone = 'Pacific/Kiritimati'`,
        );
        const insert = (id: string, key: string, createdAt: string) =>
          world.work(
            `insert into ledger.runs (id, request_id, created_at, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
             values ($1, $1, $2, 'system:work', '{own}', 'daily_sweep', $3, 'run_outcome', 1, 'personal_run', '1')`,
            [id, createdAt, key],
          );
        await insert("run_01ARZ3NDEKTSV4RRFFQ69G5FA1", "sweep:a", "2026-10-04T00:30:00Z");
        await insert("run_01ARZ3NDEKTSV4RRFFQ69G5FA2", "sweep:b", "2026-10-03T23:30:00Z");
        expect((await world.dispatch().wakeFacts("daily_sweep", new Date("2026-10-04T12:00:00Z"))).runsToday).toBe(1);
      }),
    TIMEOUT,
  );

  it(
    "opportunity facts carry each ref's class, owner-backed mark, flag, taint and thread fingerprint, and no text",
    () =>
      withWorkWorld(async (world) => {
        const now = new Date();
        const { sent, inbound } = await trusted(world);
        const system = await world.mail({ direction: "inbound", thread: "system", system: "answers" });
        const event = await world.event();
        const person = await world.person();
        const { id } = await world.opportunity({
          about: ["event", event],
          refs: [
            ["message", sent],
            ["message", inbound],
            ["message", system.id],
            ["event", event],
            ["entity", person.id],
          ],
        });
        await world.owner(
          "update ledger.basis set tainted_at = now() where row_kind = 'opportunity' and row_id = $1 and ref_id = $2",
          [id, person.id],
        );
        const [item] = await world.dispatch().proposedOpportunities(now);
        const thread = (
          await world.admin<{ fp: string }>("select thread_fp as fp from knowledge.messages where id = $1", [sent])
        )[0]?.fp;
        expect(item?.id).toBe(id);
        expect(item?.facts.basis).toEqual([
          {
            refKind: "message",
            sourceClass: "source",
            ownerBacked: true,
            flagged: false,
            tainted: false,
            threadFp: thread,
            isAbout: false,
          },
          {
            refKind: "message",
            sourceClass: "source",
            ownerBacked: false,
            flagged: false,
            tainted: false,
            threadFp: thread,
            isAbout: false,
          },
          {
            refKind: "message",
            sourceClass: "system",
            ownerBacked: false,
            flagged: false,
            tainted: false,
            threadFp: expect.stringMatching(/^[0-9a-f]{64}$/),
            isAbout: false,
          },
          {
            refKind: "event",
            sourceClass: "source",
            ownerBacked: true,
            flagged: false,
            tainted: false,
            threadFp: null,
            isAbout: true,
          },
          {
            refKind: "entity",
            sourceClass: "derived",
            ownerBacked: false,
            flagged: false,
            tainted: true,
            threadFp: null,
            isAbout: false,
          },
        ]);
        // Ids, kinds, counts, booleans and fingerprints: no string beyond those.
        const strings = JSON.stringify(item).match(/"[^"]*"/g) ?? [];
        expect(
          strings.every((one) => /^"([a-zA-Z_]+|[a-z]{3}_[0-9A-Z]{26}|[0-9a-f]{64}|own|employer:example)"$/.test(one)),
        ).toBe(true);
      }),
    TIMEOUT,
  );

  it(
    "a ref whose message is withheld is flagged, one whose message has no status row is flagged, and one whose message is done is not",
    () =>
      withWorkWorld(async (world) => {
        const now = new Date();
        const withheld = await world.mail({ status: "withheld" });
        const none = await world.mail({ status: "none" });
        const skipped = await world.mail({ status: "skipped" });
        const held = await world.mail({ held: true });
        const done = await world.mail({ status: "done" });
        await world.opportunity({
          refs: [
            ["message", withheld.id],
            ["message", none.id],
            ["message", skipped.id],
            ["message", held.id],
            ["message", done.id],
          ],
        });
        const [item] = await world.dispatch().proposedOpportunities(now);
        expect(item?.facts.basis.map((one) => one.flagged)).toEqual([true, true, true, true, false]);
      }),
    TIMEOUT,
  );

  it(
    "an opportunity with a pending card is not among those to decide, and one whose card expired reports the case as ever carded",
    () =>
      withWorkWorld(async (world) => {
        const now = new Date();
        const { sent } = await trusted(world);
        // Three cases: each about an event of its own.
        const waiting = await world.opportunity({ about: ["event", await world.event()], refs: [["message", sent]] });
        await world.card({ target: ["opportunity", waiting.id], caseKey: waiting.caseId, state: "pending" });
        const expired = await world.opportunity({ about: ["event", await world.event()], refs: [["message", sent]] });
        await world.card({ target: ["opportunity", expired.id], caseKey: expired.caseId, state: "expired" });
        const plain = await world.opportunity({ about: ["event", await world.event()], refs: [["message", sent]] });
        const items = await world.dispatch().proposedOpportunities(now);
        expect(items.map((one) => one.id).sort()).toEqual([expired.id, plain.id].sort());
        expect(items.find((one) => one.id === expired.id)?.facts).toMatchObject({
          cardPending: false,
          caseEverCarded: true,
        });
        expect(items.find((one) => one.id === plain.id)?.facts).toMatchObject({
          cardPending: false,
          caseEverCarded: false,
        });
      }),
    TIMEOUT,
  );

  it(
    "a case the owner declined is reported closed, with news only when a source ref is new",
    () =>
      withWorkWorld(async (world) => {
        const now = new Date();
        const { sent, inbound } = await trusted(world);
        const declined = await world.opportunity({ refs: [["message", sent]], at: at(now, -10 * DAY) });
        await world.decision(declined.id, "no_go", { by: "owner", at: at(now, -9 * DAY) });
        const again = await world.opportunity({ refs: [["message", sent]], caseId: declined.caseId });
        const withNews = await world.opportunity({
          refs: [
            ["message", sent],
            ["message", inbound],
          ],
          caseId: declined.caseId,
        });
        const items = await world.dispatch().proposedOpportunities(now);
        const closed = (id: string) => items.find((one) => one.id === id)?.facts.caseClosed;
        expect(closed(again.id)).toEqual({ by: "owner", daysSince: expect.closeTo(9, 3), newSourceRef: false });
        expect(closed(withNews.id)).toEqual({ by: "owner", daysSince: expect.closeTo(9, 3), newSourceRef: true });
        // The positive control: a case the owner said go on is not closed. It is about another
        // thing, or it would share the declined case (one case per kind, thing, author and label).
        const welcomed = await world.opportunity({
          about: ["event", await world.event()],
          refs: [["message", sent]],
          at: at(now, -10 * DAY),
        });
        await world.decision(welcomed.id, "go", { by: "owner", at: at(now, -9 * DAY) });
        await world.status("opportunity", welcomed.id, "done");
        const next = await world.opportunity({ refs: [["message", sent]], caseId: welcomed.caseId });
        expect(
          (await world.dispatch().proposedOpportunities(now)).find((one) => one.id === next.id)?.facts.caseClosed,
        ).toBeNull();
      }),
    TIMEOUT,
  );

  it(
    "vetoedOpen returns a handed opportunity and the veto's ruling id",
    () =>
      withWorkWorld(async (world) => {
        const person = await world.person();
        const other = await world.person();
        const named = await world.mail({ person: person.id });
        const plain = await world.mail({ person: other.id });
        const handed = await world.opportunity({ refs: [["message", named.id]] });
        await world.status("opportunity", handed.id, "handed_to_owner");
        const closed = await world.opportunity({ refs: [["message", named.id]] });
        await world.status("opportunity", closed.id, "done");
        await world.opportunity({ refs: [["message", plain.id]] });
        const ruling = await world.veto("person", [person.fp]);
        expect(await world.dispatch().vetoedOpen()).toEqual([{ id: handed.id, ruling }]);
      }),
    TIMEOUT,
  );

  it(
    "erasureLevel refuses a missing journal",
    () =>
      withWorkWorld(async (world) => {
        const dispatch = world.dispatch();
        expect(await dispatch.erasureLevel()).toBe("level");
        await world.erasure({ journal: false });
        expect(await dispatch.erasureLevel()).toBe("behind");
        await rm(world.journal);
        expect(await refusedWith(() => dispatch.erasureLevel())).toMatchObject({ code: "journal_refused" });
      }),
    TIMEOUT,
  );
});
