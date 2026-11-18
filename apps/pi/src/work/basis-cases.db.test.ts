import { basisTrusted } from "@intelligence/personal-ladder";
import { type Ref, SLOW_DB_TEST_TIMEOUT, type WorkWorld, withWorkWorld } from "@intelligence/personal-store/testing";
import { describe, expect, it } from "vitest";

// The two agree on every case.

type Case = {
  name: string;
  trusted: boolean;
  build: (world: WorkWorld) => Promise<{ refs: Ref[]; about?: Ref; taint?: string }>;
};

const owner = (world: WorkWorld, thread: string, bulk = false) => world.mail({ direction: "outbound", thread, bulk });
const stranger = (world: WorkWorld, thread: string, options: Parameters<WorkWorld["mail"]>[0] = {}) =>
  world.mail({ direction: "inbound", thread, ...options });

const CASES: Case[] = [
  {
    name: "agent refs alone",
    trusted: false,
    build: async (world) => {
      const sent = await owner(world, "agent");
      const hypothesis = await world.hypothesis({ about: ["message", sent.id], refs: [["message", sent.id]] });
      return { refs: [["hypothesis", hypothesis.id]] };
    },
  },
  {
    name: "agent refs beside the owner's message (the positive control)",
    trusted: true,
    build: async (world) => {
      const sent = await owner(world, "agent-control");
      const hypothesis = await world.hypothesis({ about: ["message", sent.id], refs: [["message", sent.id]] });
      return {
        refs: [
          ["hypothesis", hypothesis.id],
          ["message", sent.id],
        ],
      };
    },
  },
  {
    name: "a source that is not owner-backed",
    trusted: false,
    build: async (world) => ({ refs: [["message", (await stranger(world, "lone")).id]] }),
  },
  {
    name: "an owner-backed source alone (the positive control)",
    trusted: true,
    build: async (world) => ({ refs: [["message", (await owner(world, "own-alone")).id]] }),
  },
  {
    name: "a system ref alone",
    trusted: false,
    build: async (world) => ({
      refs: [["message", (await world.mail({ direction: "outbound", thread: "system", system: "originated" })).id]],
    }),
  },
  {
    name: "an owner-backed message with a stranger's message in its thread",
    trusted: true,
    build: async (world) => ({
      refs: [
        ["message", (await owner(world, "same")).id],
        ["message", (await stranger(world, "same")).id],
      ],
    }),
  },
  {
    name: "an owner-backed message with a stranger's message in another thread",
    trusted: false,
    build: async (world) => ({
      refs: [
        ["message", (await owner(world, "one")).id],
        ["message", (await stranger(world, "two")).id],
      ],
    }),
  },
  {
    name: "an owner-backed event with a message",
    trusted: false,
    build: async (world) => {
      const event = await world.event({ response: "accepted" });
      return {
        refs: [
          ["event", event],
          ["message", (await stranger(world, "beside-event")).id],
        ],
      };
    },
  },
  {
    name: "an owner-backed event alone (the positive control)",
    trusted: true,
    build: async (world) => {
      const event = await world.event({ response: "accepted" });
      return { refs: [["event", event]], about: ["event", event] };
    },
  },
  {
    name: "the event it is about, which the owner did not accept, beside an owner-backed message",
    trusted: true,
    build: async (world) => {
      const event = await world.event({ response: "needsAction" });
      return {
        refs: [
          ["event", event],
          ["message", (await owner(world, "about")).id],
        ],
        about: ["event", event],
      };
    },
  },
  {
    name: "an owner-backed message beside an event the owner did not accept, which it is not about",
    trusted: false,
    build: async (world) => {
      const event = await world.event({ response: "needsAction" });
      return {
        refs: [
          ["message", (await owner(world, "not-about")).id],
          ["event", event],
        ],
      };
    },
  },
  {
    name: "a system ref in another thread than the owner-backed message",
    trusted: false,
    build: async (world) => ({
      refs: [
        ["message", (await owner(world, "s-one")).id],
        ["message", (await stranger(world, "s-two", { system: "answers" })).id],
      ],
    }),
  },
  {
    name: "a system ref in the owner-backed message's thread (the positive control)",
    trusted: true,
    build: async (world) => ({
      refs: [
        ["message", (await owner(world, "s-same")).id],
        ["message", (await stranger(world, "s-same", { system: "answers" })).id],
      ],
    }),
  },
  {
    name: "an automatic reply",
    trusted: false,
    build: async (world) => ({
      refs: [
        ["message", (await owner(world, "auto", true)).id],
        ["message", (await stranger(world, "auto")).id],
      ],
    }),
  },
  {
    name: "a withheld message",
    trusted: false,
    build: async (world) => ({
      refs: [
        ["message", (await owner(world, "w")).id],
        ["message", (await stranger(world, "w", { status: "withheld" })).id],
      ],
    }),
  },
  {
    name: "a held message",
    trusted: false,
    build: async (world) => ({
      refs: [
        ["message", (await owner(world, "h")).id],
        ["message", (await stranger(world, "h", { held: true })).id],
      ],
    }),
  },
  {
    name: "an unscreened message",
    trusted: false,
    build: async (world) => ({
      refs: [
        ["message", (await owner(world, "u")).id],
        ["message", (await stranger(world, "u", { status: "none" })).id],
      ],
    }),
  },
  {
    name: "a skipped message",
    trusted: false,
    build: async (world) => ({
      refs: [
        ["message", (await owner(world, "k")).id],
        ["message", (await stranger(world, "k", { status: "skipped" })).id],
      ],
    }),
  },
  {
    name: "a tainted ref",
    trusted: false,
    build: async (world) => {
      const inbound = await stranger(world, "t");
      return {
        refs: [
          ["message", (await owner(world, "t")).id],
          ["message", inbound.id],
        ],
        taint: inbound.id,
      };
    },
  },
];

describe("durable-work's two copies", () => {
  it(
    "the two agree on every case",
    () =>
      withWorkWorld(async (world) => {
        const agent = await world.agent();
        const intent = await world.intent(["meeting_prep"], [agent.id]);
        await world.harness(agent, "meeting_prep", "prepare");
        const dispatch = world.dispatch();
        const judged: { name: string; expected: boolean; ladder: boolean; database: boolean }[] = [];
        for (const one of CASES) {
          const built = await one.build(world);
          const about = built.about ?? (["event", await world.event({ response: null })] as Ref);
          const { id } = await world.opportunity({ about, refs: built.refs });
          if (built.taint !== undefined)
            await world.owner(
              "update ledger.basis set tainted_at = now() where row_kind = 'opportunity' and row_id = $1 and ref_id = $2",
              [id, built.taint],
            );
          const read = (await dispatch.proposedOpportunities(new Date())).find((item) => item.id === id);
          if (read === undefined) throw new Error(`${one.name}: not read`);
          const ladder = basisTrusted(read.facts.basis);
          await world.decision(id, "go", { by: "policy", intent });
          let database: boolean;
          try {
            await world.claimAndPlan(agent, id, "prepare");
            database = true;
          } catch (error) {
            if ((error as Error).message !== "the move was refused") throw error;
            database = false;
          }
          // Its lease given back, so the next case's claim is the agent's only one.
          await world.work("delete from queue.leases where resource_id = $1", [id]);
          judged.push({ name: one.name, expected: one.trusted, ladder, database });
        }
        expect(judged.filter((one) => one.ladder !== one.expected || one.database !== one.expected)).toEqual([]);
      }),
    SLOW_DB_TEST_TIMEOUT,
  );
});
