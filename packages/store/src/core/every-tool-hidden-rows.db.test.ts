import { TOOL_WIRE } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ABSENT_IDS,
  buildPeople,
  CATALOGUE,
  COVERAGE,
  callTool,
  type EveryClients,
  everyClients,
  type Ids,
  NAMED,
  type NamedAsk,
  seedHiddenRows,
  seedVisibleRows,
  type Visible,
  widenReasoner,
  withRequest,
} from "../test-support/hidden-rows-every-tool.ts";
import { LISTED, NO_CONTROL } from "../test-support/hidden-rows-listed.ts";
import {
  addHiddenWork,
  openWorkInv6,
  seedVisible,
  type WorkIds,
  type WorkInv6,
} from "../test-support/hidden-rows-work.ts";
import { normal } from "../test-support/hidden-rows-world.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";

// I1 over the whole tool catalogue: every tool that hidden-rows-every-tool.ts's COVERAGE gives to this
// file, asked over the work view's world (hidden-rows-work.ts) with the hidden twin's rows under
// employer:example. An ask that names a row is asked with the id of a hidden row and with an id no row
// has: for a viewer cleared for `own` and the agent compartments it shares, and for one cleared for
// `own` alone, the two replies are byte-identical once the ids only one of them holds (those a call
// mints) are renamed by order of first appearance, ids both hold kept in place, and no reply names a
// hidden row it was not asked about. An ask that names no row answers byte-identically before
// seedHiddenRows's rows are added and after. Every pair has its control, each ask its own: a client
// cleared for every compartment is given the hidden row, so its two replies differ.
//
// Do not weaken, skip or delete this test to make a change pass.

const TIMEOUT = SLOW_DB_TEST_TIMEOUT;

let w: WorkInv6;
let clients: EveryClients;
let seen: WorkIds;
let visible: Visible;
let added: WorkIds;
let hidden: Ids;
const before = new Map<string, Map<string, string>>();
let wideBefore: Map<string, string>;

type Viewer = { name: "narrow" | "bare"; token: (by: NamedAsk["by"]) => string };
const viewers = (): Viewer[] => [
  { name: "narrow", token: (by) => (by === "reasoner" ? clients.reasoner.token : clients.agent.token) },
  { name: "bare", token: (by) => (by === "reasoner" ? clients.reasoner.token : clients.bare.token) },
];
// The control's client: the reasoner is widened only for the controls of the asks that name a row.
const wide = (by: NamedAsk["by"], which: NamedAsk["wide"] = "both"): string =>
  by === "reasoner" ? clients.reasoner.token : clients.wide[which];

const text = (outcome: unknown): string => JSON.stringify(outcome);

// The hidden ids a reply names that its arguments did not: none may reach a viewer.
const leaked = (reply: string, args: unknown): string[] => {
  const asked = JSON.stringify(args);
  const ids = [...Object.values(hidden), ...Object.values(added)].filter((one) => one.length >= 20);
  return [...new Set(ids)].filter((id) => reply.includes(id) && !asked.includes(id));
};

// Each listed ask's reply, by ask, with what counts the caller's own calls taken out; compared as
// normal(reply, other) with the reply it is compared with.
const listedTranscript = async (token: (by: NamedAsk["by"]) => string): Promise<Map<string, string>> => {
  const replies = new Map<string, string>();
  for (const { ask, tool, by, args, own } of LISTED) {
    const reply = text(await callTool(w, token(by), tool, args));
    replies.set(ask, own === undefined ? reply : reply.replace(new RegExp(own, "g"), "own"));
  }
  return replies;
};
const same = (a: string, b: string): boolean => normal(a, b) === normal(b, a);

beforeAll(async () => {
  w = await openWorkInv6();
  seen = await seedVisible(w);
  clients = await everyClients(w);
  visible = await seedVisibleRows(w, seen);
  // addHiddenWork writes rows under `own` too (the wider client's work on what the viewer sees), so
  // the first transcript is taken after it, and seedHiddenRows adds a hidden project of its own.
  added = await addHiddenWork(w, seen);
  await buildPeople(w);
  for (const viewer of viewers()) before.set(viewer.name, await listedTranscript(viewer.token));
  wideBefore = await listedTranscript((by) => wide(by));
  hidden = await seedHiddenRows(w, added);
  await buildPeople(w);
}, TIMEOUT);

afterAll(async () => {
  await w?.s.close();
});

describe("I1 over every tool: a row a viewer cannot see answers as one that is not there", { timeout: TIMEOUT }, () => {
  it("the asks reach every tool this file is given, and only those", () => {
    const mine = CATALOGUE.filter((tool) => {
      const row = COVERAGE[tool];
      return row !== undefined && "asked" in row && row.asked === "every";
    });
    const asked = new Set([...NAMED, ...LISTED].map((one) => one.tool));
    expect([...asked].sort()).toEqual([...mine].sort());
  });

  it("every ask's arguments are the tool's own, so no pair is two refusals of a malformed call", () => {
    for (const { ask, tool, args } of NAMED)
      for (const ids of [hidden, ABSENT_IDS]) {
        const parsed = TOOL_WIRE[tool].args.safeParse(withRequest(tool, args(ids, visible)));
        expect(parsed.success, `${ask}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`).toBe(true);
      }
    for (const { ask, tool, args } of LISTED)
      expect(TOOL_WIRE[tool].args.safeParse(withRequest(tool, args)).success, ask).toBe(true);
    // Every hidden id the asks name is there.
    for (const [key, value] of Object.entries(hidden)) expect(value, key).not.toBe("");
  });

  it("compared replies keep the ids both hold in place, so two rows that swap places differ; minted ids are renamed", () => {
    const [x, y, m1, m2] = ["ent", "ent", "req", "req"].map((kind, n) => `${kind}_${String(n).repeat(26)}`) as [
      string,
      string,
      string,
      string,
    ];
    expect(same(`[${x},${y}]`, `[${y},${x}]`)).toBe(false);
    expect(same(`[${x},${y},${m1}]`, `[${x},${y},${m2}]`)).toBe(true);
  });

  it("an ask that names no row answers the same before the hidden rows and after", async () => {
    for (const viewer of viewers()) {
      const after = await listedTranscript(viewer.token);
      const was = before.get(viewer.name) ?? new Map<string, string>();
      expect([...after.keys()], viewer.name).toEqual(LISTED.map((one) => one.ask));
      for (const [ask, reply] of after) {
        const then = was.get(ask) ?? "";
        expect(normal(reply, then), `${viewer.name}: ${ask}`).toBe(normal(then, reply));
      }
    }
  });

  // Each listed ask its own control, so a viewer's unchanged reply means the hidden rows were there
  // to change it.
  describe("control: the wide client's answer to each ask that names no row changes with the hidden rows", () => {
    let wideAfter: Map<string, string>;
    beforeAll(async () => {
      wideAfter = await listedTranscript((by) => wide(by));
    }, TIMEOUT);
    it("every ask without a control is a listed ask", () => {
      for (const ask of Object.keys(NO_CONTROL)) expect(LISTED.map((one) => one.ask)).toContain(ask);
    });
    for (const one of LISTED.filter((ask) => NO_CONTROL[ask.ask] === undefined))
      it(`control, ${one.ask}`, () => {
        const [was, now] = [wideBefore.get(one.ask) ?? "", wideAfter.get(one.ask) ?? ""];
        expect(same(now, was), `${one.ask}: ${now}`).toBe(false);
      });
  });

  // Each pair in its own test, so a leak names its tool and ask.
  for (const one of NAMED)
    it(`${one.ask}: a hidden id answers exactly as an absent one`, async () => {
      for (const viewer of viewers()) {
        if (one.narrowOnly === true && viewer.name !== "narrow") continue;
        const token = viewer.token(one.by);
        const [hiddenArgs, absentArgs] = [one.args(hidden, visible), one.args(ABSENT_IDS, visible)];
        // The absent id first: a write it is let make is not then a row the hidden id's call merges into.
        const want = text(await callTool(w, token, one.tool, absentArgs));
        const got = text(await callTool(w, token, one.tool, hiddenArgs));
        expect(leaked(got, hiddenArgs), `${viewer.name}: ${one.ask} names a hidden row`).toEqual([]);
        expect(normal(got, want), `${viewer.name}: ${one.ask}`).toBe(normal(want, got));
        // A refusal for the call's count or a failure would make any two replies alike.
        expect(want, `${viewer.name}: ${one.ask}`).not.toMatch(/"code":"(rate_limited|unavailable)"/);
      }
    });

  // Run after every viewer's ask: the wide client's writes change what it asks next, never a viewer's
  // replies above.
  it("control: the reasoner is widened to every compartment and takes the hidden run", async () => {
    await widenReasoner(w, clients.reasoner, hidden.run);
  });
  for (const one of NAMED.filter((ask) => ask.noControl === undefined))
    it(`control, ${one.ask}: the wide client is given the hidden row`, async () => {
      const token = wide(one.by, one.wide);
      const [hiddenArgs, absentArgs] = [one.args(hidden, visible), one.args(ABSENT_IDS, visible)];
      const want = text(await callTool(w, token, one.tool, absentArgs));
      const got = text(await callTool(w, token, one.tool, hiddenArgs));
      expect(!same(got, want) || leaked(got, hiddenArgs).length > 0, `${one.ask}: ${got}`).toBe(true);
    });
});
