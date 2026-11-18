import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpportunityId, type PersonalTool, type ReadOutcome } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { createWork } from "../agent-work/work.ts";
import { openStore } from "../test-support/store.ts";
import { outcomeValue, registration } from "../test-support/values.ts";
import { seedWorld, storeSeeder, WORLD, WORLD_NOW } from "../test-support/world.ts";

// It is run again when the statements change.
//
// The synthetic world grown to the reference size: 100,000 messages from 20,000 people under
// `own`, and the same again under `employer:example`, each through the writer. The caller is a
// client cleared for `own`. What it cannot measure yet, and why, is in NOT_MEASURED: a tool
// there keeps its provisional deadline.

const MEASURE = process.env.PI_MEASURE === "1";
const MESSAGES = Number(process.env.PI_MEASURE_MESSAGES ?? 100_000);
const PEOPLE = Number(process.env.PI_MEASURE_PEOPLE ?? 20_000);
const RUNS = Number(process.env.PI_MEASURE_RUNS ?? 1_000);
// A client's record quota is 200 a day: enough clients for RUNS records.
const RECORDERS = Math.ceil(RUNS / 200);

const NOT_MEASURED: Readonly<Record<string, string>> = {
  sync_memory: "its statements are the memory adapters', measured with them",
  release_opportunity:
    "measured as claim_opportunity's not_found path is: the same function shape on an empty ledger, so its provisional deadline stands",
  propose_hypothesis: "needs durable-work rows the synthetic world does not hold yet",
  record_test: "needs durable-work rows the synthetic world does not hold yet",
  propose_opportunity: "needs durable-work rows the synthetic world does not hold yet",
  plan_move: "needs durable-work rows the synthetic world does not hold yet",
  report_move: "needs durable-work rows the synthetic world does not hold yet",
  set_intention: "needs durable-work rows the synthetic world does not hold yet",
  append_step: "needs a run held by the reasoner",
  finish_run: "needs a run held by the reasoner",
  draft_message: "needs a held opportunity and a cleared move",
  find_documents: "needs documents the synthetic world does not hold yet",
  get_document: "needs documents the synthetic world does not hold yet",
};

const percentile = (sorted: number[], p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
const deadlineOf = (p999: number): number => Math.max(100, Math.ceil((2 * p999) / 100) * 100);

describe.skipIf(!MEASURE)("each tool's work at the reference size", () => {
  it("records each tool's 99.9th percentile and the deadline it sets", { timeout: 12 * 3_600_000 }, async () => {
    const store = await openStore({
      now: WORLD_NOW,
      compartments: ["own", "employer:example", ...Array.from({ length: RECORDERS }, (_, n) => `agent:measure-${n}`)],
    });
    try {
      await seedWorld(store.writer, store.admin);
      const seed = storeSeeder(store.writer, WORLD_NOW);
      const grown = [
        { label: "personal", compartment: "own", owner: WORLD.ownerPersonal },
        { label: "work", compartment: "employer:example", owner: WORLD.ownerWork },
      ] as const;
      for (const { label, compartment, owner } of grown) {
        const mailbox = await store.writer.ensureSourceAccount(label, "google_mail", compartment, owner);
        for (let n = 0; n < MESSAGES; n += 1) {
          const person = n % PEOPLE;
          await seed.mail(mailbox, {
            id: `measure-${label}-${n}`,
            from: { address: `person-${person}@measure-${label}.test`, name: `Measure Person${person}` },
            to: [{ address: owner }],
            at: new Date(WORLD_NOW.getTime() - (n + 1) * 60_000),
            subject: `measure subject ${n}`,
          });
        }
      }

      const admin = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, recordEnabled: true });
      const reads = [
        "get_self",
        "search",
        "get_entity",
        "get_timeline",
        "find_messages",
        "read_message",
        "find_facts",
        "get_commitments",
        "build_context_pack",
      ];
      const { token } = await admin.clients.addClient(
        registration("measure", ["own"], { views: ["self", "people", "work"], tools: reads as PersonalTool[] }),
      );
      const recorders = await Promise.all(
        Array.from(
          { length: RECORDERS },
          async (_, n) =>
            (
              await admin.clients.addClient(
                registration(`measure-${n}`, ["own"], { tools: ["record"] as PersonalTool[] }),
              )
            ).token,
        ),
      );
      const agent = (
        await admin.clients.addClient(
          registration("measure-agent", ["own"], {
            kind: "agent",
            views: ["work"],
            tools: ["list_opportunities", "claim_opportunity"] as PersonalTool[],
          }),
        )
      ).token;
      const reasoner = (
        await admin.clients.addClient(
          registration("measure-reasoner", ["own"], {
            kind: "reasoner",
            views: ["work"],
            tools: ["next_run"] as PersonalTool[],
          }),
        )
      ).token;
      const work = createWork({ reader: store.reader, log: store.log, now: () => WORLD_NOW });

      const someone = seed.entityOf("person-1@measure-personal.test");
      const message = outcomeValue(await store.reader.findMessages(token, {})).messages[0]?.id;
      if (message === undefined) throw new Error("the grown world holds no message");
      const missing = OpportunityId.parse(`opp_${"0".repeat(26)}`);
      const request = (n: number): string => `req-measure-${String(n).padStart(8, "0")}`;

      const calls: Record<string, (n: number) => Promise<ReadOutcome<unknown>>> = {
        get_self: () => store.reader.getSelf(token),
        search: (n) => store.reader.search(token, { query: `person${n % PEOPLE}` }),
        get_entity: () => store.reader.getEntity(token, { id: someone }),
        get_timeline: () => store.reader.getTimeline(token, { id: someone }),
        find_messages: (n) =>
          store.reader.findMessages(token, n % 2 === 0 ? {} : { sender: `person-${n % PEOPLE}@measure-personal.test` }),
        read_message: () => store.reader.readMessage(token, { id: message }),
        find_facts: () => store.reader.findFacts(token, { type: "commitment" }),
        get_commitments: () => store.reader.getCommitments(token, {}),
        build_context_pack: () => store.reader.buildContextPack(token, { purpose: "agent_bootstrap" }),
        record: (n) =>
          store.reader.record(recorders[n % RECORDERS] ?? "", {
            kind: "note",
            body: `measure note ${n}`,
            requestId: request(n),
          }),
        list_opportunities: () => work.listOpportunities(agent, {}),
        claim_opportunity: (n) => work.claimOpportunity(agent, { id: missing, requestId: request(n) }),
        next_run: (n) => work.nextRun(reasoner, { requestId: request(n) }),
      };

      const results: { tool: string; p50: number; p999: number; deadline: number; codes: string[] }[] = [];
      for (const [tool, run] of Object.entries(calls)) {
        const times: number[] = [];
        const codes = new Set<string>();
        for (let n = 0; n < RUNS; n += 1) {
          const started = performance.now();
          const outcome = await run(n);
          times.push(performance.now() - started);
          codes.add(outcome.ok ? "ok" : outcome.code);
        }
        // A call that failed measured nothing worth a deadline.
        expect(codes.has("unavailable"), tool).toBe(false);
        times.sort((a, b) => a - b);
        const p999 = percentile(times, 0.999);
        results.push({
          tool,
          p50: Math.round(percentile(times, 0.5)),
          p999: Math.round(p999),
          deadline: deadlineOf(p999),
          codes: [...codes].sort(),
        });
      }

      const report = {
        messagesPerCompartment: MESSAGES,
        peoplePerCompartment: PEOPLE,
        runs: RUNS,
        results,
        notMeasured: NOT_MEASURED,
      };
      const file = join(tmpdir(), `pi-deadline-measure-${Date.now()}.json`);
      await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(
        `${results.map((row) => `${row.tool}\tp50 ${row.p50} ms\tp99.9 ${row.p999} ms\tdeadline ${row.deadline} ms\t${row.codes.join(",")}`).join("\n")}\nwritten to ${file}\n`,
      );
    } finally {
      await store.close();
    }
  });
});
