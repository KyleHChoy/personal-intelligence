import { gmailItemId } from "@intelligence/personal-core";
import { contactItemId } from "@intelligence/personal-core/items";
import { describe, expect, it } from "vitest";
import type { CanaryApi, Reply } from "./api.ts";
import { type CanaryTables, followAll } from "./check.ts";
import { canaryPlant } from "./plant.ts";

// The check's verdicts on what the tables and the agent API say, with neither behind them.
const DAY = "2026-11-04";
const plant = canaryPlant(DAY);
const THROUGH = { stored: true, settled: true, claims: 1, belief: true };

const tables = (over: Partial<CanaryTables> = {}): CanaryTables => ({
  connected: async () => THROUGH,
  captured: async () => THROUGH,
  written: async () => THROUGH,
  known: async (address) => address === plant.people.contact.address,
  proposalCards: async () => ({ waiting: [], all: 1 }),
  ...over,
});

// Every read carries everything of the day; `over` changes one tool's answer.
const api =
  (over: Record<string, Reply> = {}): CanaryApi =>
  async (_client, tool) =>
    over[tool] ?? {
      ok: true,
      value: {
        results: [{ id: "ent_1" }],
        documents: [{ id: "doc_1" }],
        entries: [{ kind: "captured_meeting", capture: "cap_1", startsAt: plant.meeting.startedAt }],
        everything: [
          plant.title,
          plant.event.summary,
          plant.people.contact.name,
          plant.word,
          `the notes on ${plant.word}`,
          `finder of ${plant.word}`,
        ],
      },
    };

const code = async (source: string, given: Parameters<typeof followAll>[2]) =>
  (await followAll(plant, DAY, given)).find((one) => one.source === source)?.code;

describe("followAll", () => {
  it("passes when every hop holds", async () => {
    const results = await followAll(plant, DAY, { api: api(), tables: tables() });
    expect(results.every((one) => one.code === "ok")).toBe(true);
  });

  it("asks identity for the day's contact address, and list_people for the day's name", async () => {
    const stale = canaryPlant("2026-11-03").people.contact;
    expect(
      await code("contact", { api: api(), tables: tables({ known: async (address) => address === stale.address }) }),
    ).toBe("stuck_pipeline");
    const yesterdays: Reply = { ok: true, value: { people: [{ name: { untrusted: stale.name } }], next: null } };
    expect(await code("contact", { api: api({ list_people: yesterdays }), tables: tables() })).toBe("not_on_surface");
  });

  // The model states the meeting's fact in its own fields, a role and not the sentence, and what the
  // timeline shows of the meeting itself is the meeting's entry: a title or a transcript line is on
  // no surface. So the hop asks for the day's meeting on the person's timeline.
  it("a meeting is on the surface by its entry on the person's timeline, not by a line of its transcript", async () => {
    const onTimeline = (entries: unknown[]): Reply => ({ ok: true, value: { entries } });
    const given = (entries: unknown[]) => ({ api: api({ get_timeline: onTimeline(entries) }), tables: tables() });
    const entry = { kind: "captured_meeting", capture: "cap_1", startsAt: "2026-11-03T21:00:00.000Z" };
    expect(await code("meeting", given([entry]))).toBe("ok");
    expect(await code("meeting", given([]))).toBe("not_on_surface");
    expect(await code("meeting", given([{ ...entry, startsAt: "2026-11-02T21:00:00.000Z" }]))).toBe("not_on_surface");
    expect(await code("meeting", given([{ ...entry, kind: "meeting" }]))).toBe("not_on_surface");
  });

  it("reads list_people to its last page: a person past the first is still listed", async () => {
    let asks = 0;
    const paged: CanaryApi = async (client, tool, args) => {
      if (tool !== "list_people") return api()(client, tool, args);
      asks += 1;
      return args.after === undefined
        ? { ok: true, value: { people: [], next: "page-2" } }
        : { ok: true, value: { people: [{ name: { untrusted: plant.people.contact.name } }], next: null } };
    };
    expect(await code("contact", { api: paged, tables: tables() })).toBe("ok");
    expect(asks).toBe(2);
  });

  it("a second card for the proposal is no_belief; the query names both requests", async () => {
    const asked: (readonly string[])[] = [];
    expect(
      await code("proposal", {
        api: api(),
        tables: tables({
          proposalCards: async (requests) => {
            asked.push(requests);
            return { waiting: [], all: 2 };
          },
        }),
      }),
    ).toBe("no_belief");
    expect(asked[0]).toEqual([plant.proposal.requestId, plant.proposalAgain.requestId]);
  });

  it("a lane off is lane_off for its sources, and a broken hop stays that hop", async () => {
    const lanesOff = ["document", "meeting", "moment"];
    expect(await code("gmail", { api: api(), tables: tables(), lanesOff })).toBe("ok");
    for (const source of ["drive", "meeting", "moment"])
      expect(await code(source, { api: api(), tables: tables(), lanesOff })).toBe("lane_off");
    expect(
      await code("drive", { api: api({ find_facts: { ok: false, code: "unavailable" } }), tables: tables(), lanesOff }),
    ).toBe("not_read");
  });

  it("with the budget spent, what needed the model says budget, and what did not still answers", async () => {
    const unsettled = { stored: true, settled: false, claims: 0, belief: false };
    const spent = tables({
      connected: async (connector) =>
        connector === "google_mail" || connector === "google_docs" ? unsettled : THROUGH,
      captured: async () => unsettled,
      written: async () => ({ ...unsettled, stored: true }),
      proposalCards: async () => ({ waiting: [], all: 0 }),
    });
    const results = Object.fromEntries(
      (await followAll(plant, DAY, { api: api(), tables: spent, budget: true })).map((one) => [one.source, one.code]),
    );
    expect(results).toMatchObject({
      gmail: "budget",
      drive: "budget",
      meeting: "budget",
      moment: "budget",
      proposal: "budget",
      calendar: "ok",
      contact: "ok",
    });
  });

  it("reads each list by the day's own window and at its widest page, so other days' facts cannot crowd it out", async () => {
    const asked: Record<string, Record<string, unknown>[]> = {};
    const noting: CanaryApi = async (client, tool, args) => {
      (asked[tool] ??= []).push(args);
      return api()(client, tool, args);
    };
    await followAll(plant, DAY, { api: noting, tables: tables() });
    const span = (args: Record<string, unknown>): number =>
      (Date.parse(String(args.to)) - Date.parse(String(args.from))) / 86_400_000;
    for (const args of asked.find_facts ?? []) {
      expect(args.limit).toBe(50);
      expect(span(args)).toBeLessThanOrEqual(2);
    }
    expect(asked.find_facts).toHaveLength(2);
    for (const args of asked.get_timeline ?? []) {
      expect(args.limit).toBe(100);
      expect(span(args)).toBeLessThanOrEqual(4);
    }
    expect(asked.get_beliefs?.[0]?.limit).toBe(50);
  });

  it("names each item by its source's id", () => {
    expect(gmailItemId(plant.mail.id)).toContain(plant.mail.id);
    expect(contactItemId(String(plant.contact.resourceName))).toContain("people/");
  });
});
