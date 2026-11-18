import { BELIEF_TYPES, type CardId, type PersonalTool, type PersonalView } from "@intelligence/contracts/personal";
import { runExtraction } from "@intelligence/personal-extract";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { type AgentWorld, rowsOf, withAgents } from "@intelligence/personal-store/testing";
import { describe, expect, it, vi } from "vitest";
import { MODEL_ID, quiet } from "../test-support/extract-fixtures.ts";
import { pi as runPi } from "../test-support/run-pi.ts";

// The owner lets one agent read another's confirmed facts with `pi clients set-compartments`.
// Client alpha proposes a fact about the owner with scope `all`, the owner confirms its about_you
// card, and the belief is computed under alpha's label. Client beta, cleared for `own` and
// `agent:beta`, does not see it, until the owner widens beta to `agent:alpha`: then beta sees it, its
// label unchanged. The real reader and extraction (a proposal's claim is code's, never a model's);
// every belief is computed at read.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const WHAT = "canary-shared-window-seats";
const TOOLS: PersonalTool[] = ["get_self", "get_beliefs", "record", "propose_about_you"];
const VIEWS: PersonalView[] = ["self", "people", "work"];

async function pi(argv: string[], env: Record<string, string>) {
  const { exit, stderr } = await runPi(argv, env);
  return { exit, stderr };
}

const register = async (world: AgentWorld, name: string): Promise<string> =>
  (
    await world.admin.clients.addClient({
      name,
      runtime: "local",
      vendorRetention: "none",
      compartments: ["own"],
      views: VIEWS,
      tools: TOOLS,
    })
  ).token;

// What the client is served of the fact: its get_self and get_beliefs answers, as text.
async function served(world: AgentWorld, token: string): Promise<{ self: boolean; beliefs: boolean }> {
  const self = await world.reader.getSelf(token);
  const beliefs = await world.reader.getBeliefs(token, {});
  if (!self.ok || !beliefs.ok) throw new Error("a read was refused");
  return { self: JSON.stringify(self.value).includes(WHAT), beliefs: JSON.stringify(beliefs.value).includes(WHAT) };
}

// The distinct labels of the owner beliefs computed for each audience, each client's and the owner's.
const labelsOfFact = async (world: AgentWorld): Promise<string[][]> => {
  const labels = (await world.pipeline.sweepBeliefs(BELIEF_TYPES)).flatMap(({ records }) =>
    records.filter((record) => record.provenance === "owner").map((record) => JSON.stringify(record.compartments)),
  );
  return [...new Set(labels)].map((label) => JSON.parse(label) as string[]);
};

describe("agents that read each other's confirmed facts", () => {
  it("beta sees alpha's confirmed proposal only after the owner widens beta with pi clients set-compartments, and the belief's label is unchanged", () =>
    withAgents(async (world) => {
      const alpha = await register(world, "alpha");
      const beta = await register(world, "beta");

      // Alpha proposes; the record is taken in and extracted by code; the owner confirms its card.
      const proposed = await world.reader.proposeAboutYou(alpha, {
        kind: "preference",
        fields: { domain: "travel", object: WHAT, polarity: "prefers" },
        scope: "all",
        requestId: "shared-proposal-000001",
      });
      expect(proposed.ok).toBe(true);
      await world.writer.takeRecords();
      const summary = await runExtraction({
        store: world.pipeline,
        model: fakeModelClient({}),
        modelId: MODEL_ID,
        log: quiet,
        now: () => new Date(),
      });
      expect(summary).not.toBe("already_running");
      const [card, ...others] = await rowsOf<{ id: CardId; compartments: string[] }>(
        world.db,
        "select id, compartments from ledger.cards where kind = 'about_you'",
      );
      expect(others).toEqual([]);
      expect(card?.compartments).toEqual(["agent:alpha", "own"]);
      await world.admin.cards.decide({
        cards: [card?.id as CardId],
        answer: "confirm",
        requestId: "shared-confirm-000001",
      });

      // Computed under alpha's label: alpha sees it, beta does not.
      expect(await labelsOfFact(world)).toEqual([["agent:alpha", "own"]]);
      expect(await served(world, alpha)).toEqual({ self: true, beliefs: true });
      expect(await served(world, beta)).toEqual({ self: false, beliefs: false });

      // The owner widens beta, which makes beta's audience.
      expect(
        await pi(["clients", "set-compartments", "beta", "--compartments", "own,agent:beta,agent:alpha"], {
          PI_DATABASE_URL_ADMIN: world.db.urls.admin,
          PI_KEY_FILE: world.db.keyFile,
        }),
      ).toEqual({ exit: 0, stderr: "" });
      expect(await served(world, beta)).toEqual({ self: true, beliefs: true });
      expect(await labelsOfFact(world)).toEqual([["agent:alpha", "own"]]);
      // Alpha, not widened, sees no more than before.
      expect(await served(world, alpha)).toEqual({ self: true, beliefs: true });
    }));
});
