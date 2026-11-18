import { LocalEntityId } from "@intelligence/contracts";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { findingData, readRecord } from "./interpret.ts";
import { messageData } from "./message.ts";
import { promptAt } from "./prompts.ts";
import { runExtraction } from "./run.ts";
import { recording, type Setup, setup } from "./test-support/support.ts";
import { runTrial, trialReportLines } from "./trial.ts";

// `pi extract trial --lane agent --fact-kinds` on the memory store: the newest findings done, each
// asked the agent lane's fact-kind version through the saved calls, checked as a run checks one, with
// nothing but saved calls written. Recorded outputs, no live call; agent-project-findings.db.test.ts
// reads a replay on the real store, whose saved calls a record's are too. Synthetic values only.

const PROJECT = LocalEntityId.parse(`ent_${"7".repeat(26)}`);
const DECISION = "The kiln build will use the gas burner.";
const DETAIL = "two firebricks of grade 23";
const NEXT = "order the firebricks by Friday";
const BODY = `${DECISION} The order is for ${DETAIL}. Avery Quinn will ${NEXT}.`;

function filed(s: Setup, body: string, project: LocalEntityId | undefined): string {
  const at = new Date(Date.parse(s.w.now) - 3_600_000).toISOString();
  const id = s.store.putRecord({
    client: "alpha",
    kind: "finding",
    body,
    recordedAt: at as never,
    ...(project === undefined ? {} : { project }),
    ownerKeys: { names: ["Avery Quinn"], addresses: [] },
  });
  const mention = (value: string) => ({ key: { kind: "source_id", value }, observedAt: at });
  const claim = (type: string, fields: Record<string, unknown>) => ({
    type,
    subject: mention("project:this"),
    fields,
    statementKind: "stated_fact",
    basis: "third_party",
    span: `chars:0-${body.length}`,
  });
  s.store.outputs[id] = {
    claims: [
      claim("project.decision", { what: DECISION }),
      claim("project.fact", { what: DETAIL }),
      claim("project.next_step", { what: NEXT, who: mention("owner:this") }),
    ],
    narrowing: "none",
  };
  s.deps.model = recording(fakeModelClient(s.store.outputs, s.calls), s.requests);
  return id;
}

describe("the agent lane's trial", () => {
  it("asks version 9, keeps a decision, a detail and a next step of a filed finding, and writes no claim", async () => {
    const s = await setup();
    await runExtraction(s.deps);
    filed(s, BODY, PROJECT);
    await runExtraction(s.deps);
    const claims = s.store.claims().length;
    const report = await runTrial(s.deps, 5, {
      lane: "agent",
      factKinds: true,
      show: ["project.fact", "project.next_step"],
    });
    if (report === "already_running") throw new Error("locked");
    expect(report).toMatchObject({ lane: "agent", version: "9", items: 1, failed: 0, stopped: null });
    expect(Object.keys(report.claims).sort()).toEqual(["project.decision", "project.fact", "project.next_step"]);
    expect(s.store.claims()).toHaveLength(claims);
    const lines = trialReportLines(report, 0);
    expect(lines[1]).toBe("prompt: agent 9");
  });

  it("a finding filed under no project keeps none of them, and one that does not name the owner grounds no owner mention", async () => {
    const s = await setup();
    await runExtraction(s.deps);
    filed(s, BODY, undefined);
    await runExtraction(s.deps);
    const none = await runTrial(s.deps, 5, { lane: "agent", factKinds: true });
    if (none === "already_running") throw new Error("locked");
    expect(none.claims).toEqual({});

    const t = await setup();
    await runExtraction(t.deps);
    filed(t, `${DECISION} The order is for ${DETAIL}. Someone will ${NEXT}.`, PROJECT);
    await runExtraction(t.deps);
    const nobody = await runTrial(t.deps, 5, { lane: "agent", factKinds: true });
    if (nobody === "already_running") throw new Error("locked");
    expect(Object.keys(nobody.claims).sort()).toEqual(["project.decision", "project.fact"]);
    expect(nobody.unmapped).toMatchObject({ ungrounded_mention: 1 });
  });

  it("only version 9's slot names the owner, so an earlier version's saved call replays", async () => {
    const s = await setup();
    const id = filed(s, BODY, PROJECT);
    const record = await s.store.openRecord(id as never);
    if (record === null) throw new Error("no record");
    const { parsed } = readRecord(record, record.context.compartments);
    const earlier = messageData(parsed, record.item.recordedAt);
    expect(findingData(promptAt("agent", "7"), parsed, record)).toEqual(earlier);
    const latest = JSON.parse(findingData(promptAt("agent", "9"), parsed, record).message as string) as {
      owner: { names: string[] };
    };
    expect(latest.owner.names).toEqual(["Avery Quinn"]);
  });
});
