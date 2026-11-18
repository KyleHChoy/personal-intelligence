import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { MessageId, RunId } from "@intelligence/contracts/personal";
import { createTestDatabase } from "@intelligence/personal-store/testing";
import { describe, expect, it } from "vitest";
import {
  cardsOn,
  caseOf,
  count,
  decisionsOf,
  evt,
  header,
  isRecipe,
  LONG,
  mail,
  msg,
  NOT_FOUND,
  NOT_PERMITTED,
  ok,
  otherEvents,
  ownerSent,
  propose,
  REASONER_MAIN,
  withHarness,
} from "../test-support/work-gate-fixtures.ts";
import {
  answer,
  calls,
  DAY,
  HOUR,
  IGNORE,
  latest,
  pi,
  proposedAbout,
  proposedBy,
  READ_TOOLS,
  RECORDED_MODEL,
  type Result,
  recorded,
  requested,
  requestId,
  runMeeting,
  sequenceReplies,
  startSession,
  untilClaim,
  untilGo,
  value,
  WORK_TOOLS,
  writeWrapper,
} from "../test-support/work-harness.ts";

// Durable work's gate tests W3 to W7. Shared setup is in work-gate-fixtures.ts.

describe("durable work: what a reasoner and its runs cannot do", () => {
  it(
    "W3 the reasoner refuses to start with a database URL or a client token, with wrong_role_url, and makes no connection",
    async () => {
      const folder = await mkdtemp(join(tmpdir(), "pi-w3-"));
      const marker = join(folder, "started");
      const agentApi = join(folder, "agent-api");
      // An agent API that only says it was started.
      await writeFile(agentApi, `#!/bin/sh\n/usr/bin/touch '${marker}'\n`, { mode: 0o700 });
      // The key endpoint, preloaded in place of fetch: a 5-dollar limit with room left, so the
      // positive control gets past the spend cap and no request leaves the machine.
      const keyEndpoint = join(folder, "key-endpoint.mjs");
      await writeFile(
        keyEndpoint,
        `globalThis.fetch = async (input) => {
  if (String(input) !== "https://openrouter.ai/api/v1/key") throw new TypeError("no network in W3");
  return new Response(JSON.stringify({ data: { limit: 5, limit_remaining: 5, limit_reset: null } }), { status: 200, headers: { "content-type": "application/json" } });
};
`,
      );
      let connections = 0;
      const server = createServer((socket) => {
        connections += 1;
        socket.destroy();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      const reasoner = (env: Record<string, string>): Promise<Result> =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [REASONER_MAIN, "once"], {
            env: {
              PATH: process.env.PATH ?? "",
              NODE_OPTIONS: `--import=${pathToFileURL(keyEndpoint).href}`,
              PI_AGENT_API_COMMAND: agentApi,
              PI_REASONER_MODEL: RECORDED_MODEL,
              ...env,
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
          child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
          child.on("close", (exit) => resolve({ exit, stdout, stderr }));
        });
      const started = (): Promise<boolean> =>
        access(marker).then(
          () => true,
          () => false,
        );
      try {
        const refused = '{"event":"reasoner_failed","code":"wrong_role_url"}\n';
        expect(await reasoner({ PI_DATABASE_URL_READER: `postgres://pi_reader:x@127.0.0.1:${port}/pi` })).toEqual({
          exit: 1,
          stdout: "",
          stderr: refused,
        });
        expect(await reasoner({ PI_CLIENT_TOKEN: `pit_${"A".repeat(43)}` })).toEqual({
          exit: 1,
          stdout: "",
          stderr: refused,
        });
        expect(connections).toBe(0);
        expect(await started()).toBe(false);
        // The positive control: with neither, it gets past the check and starts the agent API,
        // which answers nothing. The key is a placeholder no model is ever called with.
        expect(await reasoner({ PI_REASONER_MODEL_KEY: "placeholder-not-a-key" })).toMatchObject({ exit: 1 });
        expect(await started()).toBe(true);
        expect(connections).toBe(0);
      } finally {
        server.close();
        await rm(folder, { recursive: true, force: true });
      }
    },
    LONG,
  );

  it(
    "W4 a run's writes wake nothing; the kill switch stops a run in flight, a claim and a move; a spent budget queues nothing, stops a run in flight, and the same wake queues a run on the next day's first tick",
    () =>
      withHarness({}, async (h) => {
        // A run that proposes and reminds, and a tick after it: no run is queued.
        const remind = {
          do: "remind",
          about: evt(h.ids.event),
          dueAt: new Date(h.now.getTime() + 2 * HOUR).toISOString(),
          summary: "Bring the agenda",
          basis: [evt(h.ids.event)],
        };
        const ran = await runMeeting(h, recorded(sequenceReplies(h, { more: [remind] })));
        expect(ran.exit).toBe(0);
        const [opportunity] = await proposedBy(h, ran.run);
        if (opportunity === undefined) throw new Error("the run proposed nothing");
        expect(await h.rows("select kind from ledger.intentions where run_id = $1", [ran.run])).toEqual([
          { kind: "remind" },
        ]);
        const runs = await count(h, "ledger.runs");
        ok(await h.tickProcess(), "work tick");
        expect(await count(h, "ledger.runs")).toBe(runs);
        expect(await latest(h, "opportunity", opportunity)).toMatchObject({ event: "go" });

        // The kill switch, turned on while a run is in flight: its next step gets go false and
        // it writes nothing after. A claim and a move are refused while it is on.
        const worker = await h.client("worker");
        value(await worker.tool("claim_opportunity", { id: opportunity, requestId: requestId() }));
        const stopModel = recorded([calls({ name: "get_self" }), answer(IGNORE)], {
          0: async () => void ok(await h.owner(["work", "stop"]), "work stop"),
        });
        const stopped = await requested(h, stopModel);
        expect(stopped.exit).toBe(0);
        expect(stopModel.requests).toHaveLength(1);
        expect(await count(h, "ledger.run_steps", "run_id = $1", [stopped.run])).toBe(0);
        for (const table of ["ledger.opportunities", "ledger.hypotheses", "ledger.intentions"])
          expect(await count(h, table, "run_id = $1", [stopped.run]), table).toBe(0);
        expect(await worker.tool("claim_opportunity", { id: opportunity, requestId: requestId() })).toEqual(NOT_FOUND);
        expect(await worker.tool("plan_move", { opportunity, stage: "prepare", requestId: requestId() })).toEqual(
          NOT_PERMITTED,
        );
        ok(await h.tickProcess(), "work tick");
        expect(await latest(h, "run", stopped.run)).toMatchObject({ event: "stopped", code: "kill_switch" });
        ok(await h.owner(["work", "start"]), "work start");

        // The budget: a new goal's wake, with the day's runs at the ceiling, is a silence with
        // reason budget, written once a day, and the next day's first tick queues its run.
        const goal = ok(
          await h.owner(["goal", "add", "--domain", "interests"], "Plan the spring trip\n"),
          "goal add",
        ).stdout.trim();
        const [ruling] = await h.rows<{ id: string }>(
          "select id from knowledge.owner_decisions where kind = 'goal_set' and target_id = $1",
          [goal],
        );
        const key = `goal:${ruling?.id}`;
        const now = new Date();
        const day = now.toISOString().slice(0, 10);
        const today = await count(
          h,
          "ledger.runs",
          "created_at >= ($1::date)::timestamp at time zone 'UTC' and created_at < ($1::date + 1)::timestamp at time zone 'UTC'",
          [day],
        );
        ok(await h.owner(["work", "budget", "--runs", String(today)]), "work budget");
        await h.tick(now);
        expect(await h.rows("select reason from ledger.silences where wake_key = $1", [key])).toEqual([
          { reason: "budget" },
        ]);
        await h.tick(new Date());
        expect(await h.rows("select reason from ledger.silences where wake_key = $1", [key])).toEqual([
          { reason: "budget" },
        ]);
        expect(await count(h, "ledger.runs", "wake_key = $1", [key])).toBe(0);
        const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 30));
        await h.tick(tomorrow);
        const [next] = await h.rows<{ id: RunId; wake_source: string }>(
          "select id, wake_source from ledger.runs where wake_key = $1",
          [key],
        );
        expect(next?.wake_source).toBe("goal_changed");

        // The dollar ceiling set under what the run has spent while it is in flight: its next
        // step gets go false, and the run ends failed at its own bound.
        const spentModel = recorded([calls({ name: "get_self" }), answer(IGNORE)], {
          1: async () => void ok(await h.owner(["work", "budget", "--usd", "0.00001"]), "work budget"),
        });
        const spent = await h.reason(spentModel);
        expect(spent.run).toBe(next?.id);
        expect(await latest(h, "run", next?.id ?? "")).toMatchObject({ event: "failed", code: "budget" });
        expect(spentModel.requests).toHaveLength(2);
        await worker.end();
      }),
    LONG,
  );

  it(
    "W5 a client cannot support its own hypothesis; a client's opportunity, one about the owner, an untrusted basis, a follow_up and a reply go to the owner; a carded case is not decided after a later run trusts it",
    () =>
      withHarness(
        {
          kinds: ["meeting_prep", "follow_up", "reply"],
          // The owner's automatic reply in the stranger's thread, and the message the system will
          // be said to have sent.
          prepare: (w, sources) => {
            const personal = w.accounts[0];
            const recipe = personal?.messages.find(isRecipe);
            if (personal === undefined || recipe === undefined) throw new Error("the world has the stranger's message");
            const from = header(recipe, "From");
            sources[0]?.gmail.add(
              mail({ worldNow: new Date(w.now) }, "19d0000000000001", {
                from: `Avery Quinn <${personal.address}>`,
                to: from,
                subject: "Re: Recipe",
                hoursAgo: 20 * 24 + 3,
                labels: ["SENT"],
                threadId: recipe.threadId,
                headers: [{ name: "Auto-Submitted", value: "auto-replied" }],
              }),
            );
            sources[0]?.gmail.add(
              mail({ worldNow: new Date(w.now) }, "19d0000000000002", {
                from: `Avery Quinn <${personal.address}>`,
                to: "Rhea Dorn <rhea.dorn@example.org>",
                subject: "Your table booking",
                hoursAgo: 30,
                labels: ["SENT"],
              }),
            );
          },
        },
        async (h) => {
          const { opportunity } = await untilGo(h);
          const worker = await h.client("worker");

          // A hypothesis the worker proposes, tested by the worker: the test does not count.
          const hypothesis = (
            value(
              await worker.tool("propose_hypothesis", {
                kind: "open_loop",
                about: msg(h.ids.cited),
                summary: "The trip dates are still open",
                basis: [msg(h.ids.cited)],
                requestId: requestId(),
              }),
            ) as { hypothesis: string }
          ).hypothesis;
          expect(
            value(
              await worker.tool("record_test", {
                hypothesis,
                result: "supports",
                basis: [msg(h.ids.cited)],
                requestId: requestId(),
              }),
            ),
          ).toMatchObject({ counts: false });
          expect(
            await h.rows("select counts from ledger.hypothesis_tests where hypothesis_id = $1", [hypothesis]),
          ).toEqual([{ counts: false }]);

          // The worker's proposal on the run's case: a second row, and it goes to the owner.
          const theirs = (
            value(
              await worker.tool("propose_opportunity", {
                kind: "meeting_prep",
                about: evt(h.ids.event),
                summary: "Prepare the sync",
                basis: [evt(h.ids.event), msg(h.ids.cited)],
                requestId: requestId(),
              }),
            ) as { opportunity: string }
          ).opportunity;
          expect(theirs).not.toBe(opportunity);
          expect(await caseOf(h, theirs)).not.toBe(await caseOf(h, opportunity));

          // The system's own message, and a stranger's reply to it synced after.
          const system = await h.messageOf("19d0000000000002");
          await h.rows(
            "update vault.evidence_items set system_originated = true where id = (select evidence_id from knowledge.messages where id = $1)",
            [system],
          );
          h.sources[0]?.gmail.add(
            mail(h, "19d0000000000003", {
              from: "Rhea Dorn <rhea.dorn@example.org>",
              to: h.w.accounts[0]?.address ?? "",
              subject: "Re: Your table booking",
              hoursAgo: 20,
              threadId: "19d0000000000002",
            }),
          );
          await h.sync();
          const stranger = await h.messageOf(h.gmail(isRecipe).id);
          const autoReply = await h.messageOf("19d0000000000001");
          const systemReply = await h.messageOf("19d0000000000003");
          for (const one of [stranger, autoReply, systemReply]) await h.screen(one);
          const [later] = await otherEvents(h);
          if (later === undefined) throw new Error("the world has another accepted event");

          const first = await requested(
            h,
            recorded([
              answer({
                actions: [
                  propose("meeting_prep", msg(stranger), [msg(stranger)], "Only the stranger's message"),
                  propose(
                    "meeting_prep",
                    msg(h.ids.cited),
                    [msg(stranger), msg(h.ids.cited)],
                    "Beside the owner's message of another thread",
                  ),
                  propose(
                    "meeting_prep",
                    msg(autoReply),
                    [msg(stranger), msg(autoReply)],
                    "Beside the owner's automatic reply",
                  ),
                  propose(
                    "meeting_prep",
                    msg(systemReply),
                    [msg(systemReply), msg(h.ids.cited)],
                    "A reply to the system's message",
                  ),
                  propose("meeting_prep", evt(later), [msg(stranger)], "A case a later run will back"),
                ],
              }),
            ]),
          );
          expect(first.exit).toBe(0);
          expect(await proposedBy(h, first.run)).toHaveLength(5);
          const untrusted = await Promise.all(
            [stranger, h.ids.cited, autoReply, systemReply, later].map((about) => proposedAbout(h, first.run, about)),
          );
          expect(
            await h.rows(
              "select source_class from ledger.basis where row_kind = 'opportunity' and row_id = $1 and ref_id = $2",
              [untrusted[3], systemReply],
            ),
          ).toEqual([{ source_class: "system" }]);

          // A follow_up and a reply, on the owner's own message, and an investigation about the owner.
          const second = await requested(
            h,
            recorded([
              answer({
                actions: [
                  propose("follow_up", msg(h.ids.cited), [msg(h.ids.cited)]),
                  propose("reply", msg(h.ids.cited), [msg(h.ids.cited)]),
                  {
                    do: "investigate",
                    kind: "preference",
                    about: { kind: "owner" },
                    summary: "The owner prefers mornings",
                    basis: [msg(h.ids.cited)],
                  },
                ],
              }),
            ]),
          );
          expect(second.exit).toBe(0);
          expect(await proposedBy(h, second.run)).toHaveLength(2);
          const handedKinds = [
            await proposedAbout(h, second.run, h.ids.cited, "follow_up"),
            await proposedAbout(h, second.run, h.ids.cited, "reply"),
          ];
          const [owned] = await h.rows<{ id: string; about_owner: boolean }>(
            "select id, about_owner from ledger.hypotheses where run_id = $1",
            [second.run],
          );
          expect(owned?.about_owner).toBe(true);

          ok(await h.tickProcess(), "work tick");
          for (const id of [theirs, ...untrusted, ...handedKinds]) {
            expect(await latest(h, "opportunity", id), id).toMatchObject({ event: "proposed" });
            expect(await decisionsOf(h, id), id).toEqual([]);
            expect(
              (await cardsOn(h, id)).map((one) => [one.kind, ["pending", "deferred"].includes(one.state)]),
              id,
            ).toEqual([["opportunity_decision", true]]);
          }
          expect((await cardsOn(h, theirs))[0]?.author).toMatch(/^client:cli_/);
          expect((await cardsOn(h, owned?.id ?? "")).map((one) => one.kind)).toEqual(["owner_question"]);

          // A later run backs the carded case with the owner's message and the event: its basis
          // grows, and neither that tick nor the next decides it.
          const carded = untrusted[4] ?? "";
          expect(
            (
              await requested(
                h,
                recorded([answer({ actions: [propose("meeting_prep", evt(later), [evt(later), msg(h.ids.cited)])] })]),
              )
            ).exit,
          ).toBe(0);
          expect(await count(h, "ledger.basis", "row_kind = 'opportunity' and row_id = $1", [carded])).toBe(3);
          ok(await h.tickProcess(), "work tick");
          ok(await h.tickProcess(), "work tick");
          expect(await latest(h, "opportunity", carded)).toMatchObject({ event: "proposed" });
          expect(await decisionsOf(h, carded)).toEqual([]);
          expect(await cardsOn(h, carded)).toHaveLength(1);
          await worker.end();
        },
      ),
    LONG,
  );

  it(
    "W6 a client cleared for public alone gets the answers of an empty ledger, and an accepted meeting under a compartment the reasoner lacks queues nothing and writes nothing",
    () =>
      withHarness({}, async (h) => {
        // The sequence through a report, and a hypothesis, so each call names a row that exists.
        const { opportunity, worker } = await untilClaim(h);
        const move = (
          value(await worker.tool("plan_move", { opportunity, stage: "prepare", requestId: requestId() })) as {
            move: string;
          }
        ).move;
        value(
          await worker.tool("report_move", {
            move,
            outcome: "done",
            summary: "Done",
            report: { deliverable: "Done", next: "Nothing" },
            requestId: requestId(),
          }),
        );
        const hypothesis = (
          value(
            await worker.tool("propose_hypothesis", {
              kind: "open_loop",
              about: msg(h.ids.cited),
              summary: "An open loop in the cited message",
              basis: [msg(h.ids.cited)],
              requestId: requestId(),
            }),
          ) as { hypothesis: string }
        ).hypothesis;

        // The third client, here and on a database with no ledger rows.
        const PUBLIC = [
          "--compartments",
          "public",
          "--views",
          "self,people,work",
          "--tools",
          [...READ_TOOLS, ...WORK_TOOLS].join(","),
        ];
        await h.register("open", PUBLIC);
        ok(await h.owner(["intent", "add", "--kinds", "meeting_prep", "--clients", "open", "--mode", "policy"]));
        ok(await h.owner(["harness", "grant", "open", "--kind", "meeting_prep", "--stage", "prepare"]));
        const empty = await createTestDatabase({ keyFile: h.keyFile });
        try {
          const emptyAdmin = { PI_DATABASE_URL_ADMIN: empty.urls.admin, PI_KEY_FILE: h.keyFile };
          const added = ok(await pi(["clients", "add", "open", ...PUBLIC], emptyAdmin));
          ok(
            await pi(["intent", "add", "--kinds", "meeting_prep", "--clients", "open", "--mode", "policy"], emptyAdmin),
          );
          ok(await pi(["harness", "grant", "open", "--kind", "meeting_prep", "--stage", "prepare"], emptyAdmin));
          const wrapper = join(h.folder, "open-empty-mcp");
          await writeWrapper(wrapper, empty.urls.reader, h.keyFile, added.stdout.trim(), true);
          const here = await h.client("open");
          const there = startSession(wrapper);
          expect((await there.call("initialize", { protocolVersion: "2025-06-18" })).result).toBeDefined();
          const dueAt = new Date(Date.now() + 2 * HOUR).toISOString();
          const CALLS: [string, Record<string, unknown>][] = [
            ["list_opportunities", {}],
            ["list_opportunities", { scope: "mine" }],
            ["claim_opportunity", { id: opportunity, requestId: "w6-claim-1" }],
            ["release_opportunity", { id: opportunity, requestId: "w6-release-1" }],
            ["plan_move", { opportunity, stage: "prepare", requestId: "w6-plan-1" }],
            ["report_move", { move, outcome: "done", requestId: "w6-report-1" }],
            ["set_intention", { opportunity, kind: "check_back", dueAt, requestId: "w6-intent-1" }],
            ["record_test", { hypothesis, result: "supports", basis: [msg(h.ids.cited)], requestId: "w6-test-1" }],
            [
              "propose_hypothesis",
              {
                kind: "open_loop",
                about: msg(h.ids.cited),
                summary: "An open loop in the cited message",
                basis: [msg(h.ids.cited)],
                requestId: "w6-hyp-1",
              },
            ],
            [
              "propose_opportunity",
              {
                kind: "meeting_prep",
                about: evt(h.ids.event),
                summary: "Prepare for the cited meeting",
                basis: [evt(h.ids.event)],
                requestId: "w6-opp-1",
              },
            ],
          ];
          for (const [tool, args] of CALLS)
            expect(await here.tool(tool, args), tool).toEqual(await there.tool(tool, args));
          await there.end();
          await here.end();
        } finally {
          await empty.drop();
        }

        // An accepted meeting synced under employer:example, while the reasoner holds own alone.
        const work = h.w.accounts[1];
        if (work === undefined) throw new Error("the world has two accounts");
        const start = new Date(h.now.getTime() + 5 * HOUR);
        h.sources[1]?.calendar.upsert({
          id: "evt-w6-work-planning",
          status: "confirmed",
          etag: "etag-evt-w6-work-planning",
          updated: new Date(h.worldNow.getTime() - DAY).toISOString(),
          summary: "Work planning",
          start: { dateTime: start.toISOString() },
          end: { dateTime: new Date(start.getTime() + HOUR).toISOString() },
          organizer: { email: work.address, self: true },
          attendees: [
            { email: work.address, self: true, responseStatus: "accepted" },
            { email: "devon.marsh@employer.test", displayName: "Devon Marsh", responseStatus: "accepted" },
          ],
        });
        await h.sync();
        expect(
          await count(
            h,
            "knowledge.events e join knowledge.event_details d on d.event_id = e.id",
            "e.compartments = '{employer:example}' and d.starts_at >= now() and d.starts_at < now() + interval '24 hours' and ledger.owner_backed('event', e.id)",
          ),
        ).toBe(1);
        const before = [
          await count(h, "ledger.runs"),
          await count(h, "ledger.silences"),
          await count(h, "ledger.decision_point_calls"),
        ];
        ok(await h.tickProcess(), "work tick");
        expect([
          await count(h, "ledger.runs"),
          await count(h, "ledger.silences"),
          await count(h, "ledger.decision_point_calls"),
        ]).toEqual(before);
        await worker.end();
      }),
    LONG,
  );

  it(
    "W7 an instruction read by a run changes no tool; a send or a label key ends a run bad_output with no row; a withheld, held or unscreened message is not trusted at rung 0 or at plan_move",
    () =>
      withHarness({}, async (h) => {
        await h.drain();
        // The world's message whose body holds an instruction, read by a run.
        const instruction = await h.messageOf(h.w.handles.bodyInstructionMessageId);
        const read = recorded([calls({ name: "read_message", arguments: { id: instruction } }), answer(IGNORE)]);
        expect((await requested(h, read)).exit).toBe(0);
        expect(read.requests).toHaveLength(2);
        expect(read.requests[1]?.tools).toEqual(read.requests[0]?.tools);
        const result = read.requests[1]?.messages.at(-1);
        expect(result?.role).toBe("tool");
        expect(result?.role === "tool" ? result.result : "").toMatch(/ignore all previous instructions/i);

        // A send, and a proposal that names a compartment: bad_output, and no row.
        const rowCount = async (): Promise<number[]> => [
          await count(h, "ledger.hypotheses"),
          await count(h, "ledger.opportunities"),
          await count(h, "ledger.intentions"),
        ];
        const rowsBefore = await rowCount();
        for (const output of [
          { actions: [{ do: "send" }] },
          {
            actions: [
              { ...propose("meeting_prep", evt(h.ids.event), [evt(h.ids.event)]), compartments: ["employer:example"] },
            ],
          },
        ]) {
          // The same answer twice: the first gets one more turn, told what it broke.
          const bad = await requested(h, recorded([answer(output), answer(output)]));
          expect(bad.exit).toBe(1);
          expect(await latest(h, "run", bad.run)).toMatchObject({ event: "failed", code: "bad_output" });
        }
        expect(await rowCount()).toEqual(rowsBefore);

        // Seven of the owner's sent messages, each screened: three to be marked before the tick,
        // three after rung 0's go and the claim, and one left alone.
        const sent = await Promise.all(
          ownerSent(h)
            .slice(0, 7)
            .map((one) => h.messageOf(one.id)),
        );
        expect(sent).toHaveLength(7);
        for (const one of sent) await h.screen(one);
        const marks: [string, (message: MessageId) => Promise<unknown>][] = [
          [
            "withheld",
            (message) =>
              h.rows(
                "update vault.pipeline_items set withheld = true where evidence_id = (select evidence_id from knowledge.messages where id = $1)",
                [message],
              ),
          ],
          ["held", (message) => h.rows("update knowledge.messages set held = true where id = $1", [message])],
          [
            "no status row",
            (message) =>
              h.rows(
                "delete from vault.pipeline_items where evidence_id = (select evidence_id from knowledge.messages where id = $1)",
                [message],
              ),
          ],
        ];
        const each = (ids: MessageId[]) => ids.map((one) => propose("meeting_prep", msg(one), [msg(one)]));

        // Marked before the tick: not decided at rung 0.
        const early = await requested(h, recorded([answer({ actions: each(sent.slice(0, 3)) })]));
        const earlyIds = await Promise.all(sent.slice(0, 3).map((about) => proposedAbout(h, early.run, about)));
        for (const [index, [, mark]] of marks.entries()) await mark(sent[index] as MessageId);
        // Marked after the go and the claim: no move under a go policy decided.
        const late = await requested(h, recorded([answer({ actions: each(sent.slice(3, 7)) })]));
        const lateIds = await Promise.all(sent.slice(3, 7).map((about) => proposedAbout(h, late.run, about)));
        ok(await h.tickProcess(), "work tick");
        for (const [index, id] of earlyIds.entries()) {
          expect(await latest(h, "opportunity", id), marks[index]?.[0]).toMatchObject({ event: "proposed" });
          expect(await decisionsOf(h, id)).toEqual([]);
          expect((await cardsOn(h, id)).map((one) => one.kind)).toEqual(["opportunity_decision"]);
        }
        const worker = await h.client("worker");
        for (const id of lateIds) {
          expect(await decisionsOf(h, id)).toEqual([{ decision: "go", decided_by: "policy", reason: "intent" }]);
          value(await worker.tool("claim_opportunity", { id, requestId: requestId() }));
        }
        for (const [index, [, mark]] of marks.entries()) await mark(sent[3 + index] as MessageId);
        for (const [index, id] of lateIds.slice(0, 3).entries()) {
          expect(
            await worker.tool("plan_move", { opportunity: id, stage: "prepare", requestId: requestId() }),
            marks[index]?.[0],
          ).toEqual(NOT_PERMITTED);
        }
        // The positive control.
        expect(
          (await worker.tool("plan_move", { opportunity: lateIds[3], stage: "prepare", requestId: requestId() })).ok,
        ).toBe(true);
        expect(await h.rows("select opportunity_id from ledger.moves")).toEqual([{ opportunity_id: lateIds[3] }]);
        await worker.end();
      }),
    LONG,
  );
});
