import type { EvidenceId } from "@intelligence/contracts";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { fitRecordSlot, MARKER, STATE_BYTES } from "./fit.ts";
import { processItem } from "./process-item.ts";
import { recording, type Setup, setup, withDecideModel } from "./test-support/support.ts";

// The record screen, on the memory store with fakeDecideClient.

const NORA = "nora.vance@example.org";

function record(
  s: Setup,
  kind: "finding" | "note" | "handoff" = "finding",
  body = `${NORA} will send the lease by Friday.`,
): EvidenceId {
  const id = s.store.putRecord({ client: "alpha", kind, body });
  s.store.outputs[id] = { claims: [], narrowing: "none" };
  s.deps.model = recording(fakeModelClient(s.store.outputs, s.calls), s.requests);
  return id;
}

const due = async (s: Setup, id: EvidenceId) => {
  const found = (await s.store.due(1000, 1)).find((one) => one.evidenceId === id);
  if (found?.source !== "agent_record") throw new Error("not due");
  return found;
};
const process = async (s: Setup, id: EvidenceId) => processItem(await due(s, id), s.deps);

describe("the record screen", () => {
  it("a finding at 0.85 is withheld quarantine and flagged, and Luna is not called", async () => {
    const s = await setup();
    const id = record(s);
    withDecideModel(s, { [`jev_record:${id}`]: { quarantine: 0.85 } });
    expect(await process(s, id)).toMatchObject({ status: "withheld", code: "quarantine", live: true });
    expect(s.store.record(id)).toMatchObject({ flagged: true });
    expect(s.calls).toEqual([]);
    expect(s.otherDecideCalls).toEqual([`jev_record:${id}`]);
  });

  it("at 0.69 the finding goes to Luna (the line is 0.7)", async () => {
    const s = await setup();
    const id = record(s);
    withDecideModel(s, { [`jev_record:${id}`]: { quarantine: 0.69 } });
    expect(await process(s, id)).toMatchObject({ status: "done" });
    expect(s.calls).toEqual([id]);
    expect(s.store.record(id)).toMatchObject({ flagged: false });
  });

  it("a note and a handoff are never sent", async () => {
    for (const kind of ["note", "handoff"] as const) {
      const s = await setup();
      const id = record(s, kind);
      withDecideModel(s, { [`jev_record:${id}`]: { quarantine: 0.99 } });
      expect(await process(s, id)).toMatchObject({ status: "skipped", code: "not_a_finding" });
      expect(s.otherDecideCalls).toEqual([]);
    }
  });

  it("the owner's release clears the flag, and the next run applies neither Jev's nor Luna's narrowing", async () => {
    const s = await setup();
    const id = record(s);
    s.store.outputs[id] = { claims: [], narrowing: "quarantine" };
    s.deps.model = recording(fakeModelClient(s.store.outputs, s.calls), s.requests);
    withDecideModel(s, { [`jev_record:${id}`]: { quarantine: 0.95 } });
    expect(await process(s, id)).toMatchObject({ status: "withheld", code: "quarantine" });
    s.store.releaseRecord(id);
    expect(await process(s, id)).toMatchObject({ status: "done" });
    expect(s.store.record(id)).toMatchObject({ flagged: false });
    // The released finding is not sent to the decide model again.
    expect(s.otherDecideCalls).toEqual([`jev_record:${id}`]);
  });

  it("no answer defers the finding model_unavailable; a rejection goes on to Luna", async () => {
    const s = await setup();
    const id = record(s);
    withDecideModel(s, {}, null);
    expect(await process(s, id)).toMatchObject({ status: "waiting", code: "model_unavailable" });
    expect(s.calls).toEqual([]);
    const t = await setup();
    const other = record(t);
    withDecideModel(t, { [`jev_record:${other}`]: "rejected:by_test" });
    expect(await process(t, other)).toMatchObject({ status: "done" });
  });

  it("the request carries the finding's text in its record slot, under the record's label", async () => {
    const s = await setup();
    const id = record(s);
    withDecideModel(s);
    await process(s, id);
    const [request] = s.decideRequests;
    expect(request).toMatchObject({ promptId: "jev_record", promptVersion: "2" });
    expect(request?.label.compartments).toEqual(["agent:alpha", "own"]);
    expect(JSON.parse(request?.data.record ?? "{}")).toEqual({
      kind: "finding",
      text: `${NORA} will send the lease by Friday.`,
      cut: false,
    });
  });

  it("with PI_DECIDE_MODEL unset no record call is made", async () => {
    const s = await setup();
    const id = record(s);
    expect(await process(s, id)).toMatchObject({ status: "done" });
    expect(s.decideRequests).toEqual([]);
  });
});

describe("fitRecordSlot", () => {
  it("keeps a short text whole", () => {
    expect(fitRecordSlot("a finding")).toEqual({ kind: "finding", text: "a finding", cut: false });
  });

  it("cuts a long text between code points, head and tail around the marker, to the state's bound, and counts what it left out", () => {
    const text = "é".repeat(20_000) + "🙂".repeat(5_000);
    const slot = fitRecordSlot(text);
    expect(Buffer.byteLength(JSON.stringify({ record: slot }), "utf8")).toBeLessThanOrEqual(STATE_BYTES);
    expect(slot.cut).toBe(true);
    expect(slot.text).toContain(MARKER);
    const kept = Array.from(slot.text).length - Array.from(MARKER).length;
    expect(kept + (slot.omitted ?? 0)).toBe(Array.from(text).length);
    expect(slot.text.startsWith("é")).toBe(true);
    expect(slot.text.endsWith("🙂")).toBe(true);
  });

  it("is a pure function", () => {
    const text = "x".repeat(40_000);
    expect(fitRecordSlot(text)).toEqual(fitRecordSlot(text));
  });
});
