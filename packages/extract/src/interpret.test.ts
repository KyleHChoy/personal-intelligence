import type { ModelRequest } from "@intelligence/contracts";
import { type OpenedItem, REJECTED_CONTENT_FILTER, REJECTED_LENGTH } from "@intelligence/contracts/personal";
import { gmailItem } from "@intelligence/personal-core/items";
import { renderPrompt } from "@intelligence/personal-models";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { ExtractFailure } from "./call-failure.ts";
import { CALL_GENERATION, verifyLabelFor } from "./config.ts";
import { interpretItem, readStored, rejectionShape } from "./interpret.ts";
import { EXTRACT_PROMPTS, momentPrompt } from "./prompts.ts";
import { dueOf, MODEL_ID, recording, type Setup, setup } from "./test-support/support.ts";

// One item through readStored and interpretItem, as processItem calls them.
async function run(
  s: Setup,
  gmailId: string,
  lane: "correspondence" | "transaction" = "correspondence",
  opened?: OpenedItem,
) {
  const due = await dueOf(s.store, gmailId);
  const item = opened ?? (await s.store.open(due.evidenceId));
  if (item === null) throw new Error("gone");
  const { parsed, read } = await readStored(item, due.compartments);
  return interpretItem(parsed, read, lane, due.sentAt, s.deps);
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof ExtractFailure ? error.code : error),
  );

// An opened item of the store with its message replaced by one built here.
async function replaced(
  s: Setup,
  gmailId: string,
  change: (message: Setup["w"]["accounts"][number]["messages"][number]) => void,
): Promise<OpenedItem> {
  const due = await dueOf(s.store, gmailId);
  const opened = await s.store.open(due.evidenceId);
  const message = structuredClone(s.w.accounts.flatMap((box) => box.messages).find((one) => one.id === gmailId));
  if (opened === null || message === undefined) throw new Error("missing");
  change(message);
  return {
    ...opened,
    raw: gmailItem(message, { sourceAccount: opened.raw.sourceAccount, changeKind: opened.raw.changeKind }),
  };
}

describe("interpretItem", () => {
  it("a saved call is replayed, a refusal included", async () => {
    const s = await setup();
    const { planMessageId, reservedKeyMessageId } = s.w.handles;
    const first = await run(s, planMessageId);
    expect(await failure(run(s, reservedKeyMessageId))).toBe("interpret_failed");
    const again = await run(s, planMessageId);
    expect(await failure(run(s, reservedKeyMessageId))).toBe("interpret_failed");
    expect(again).toEqual(first);
    expect(s.calls).toEqual([s.store.evidenceIdOf(planMessageId), s.store.evidenceIdOf(reservedKeyMessageId)]);
  });

  it("an output with a label key fails the item", async () => {
    const s = await setup();
    expect(await failure(run(s, s.w.handles.reservedKeyMessageId))).toBe("interpret_failed");
    expect(await failure(run(s, s.w.handles.unknownKeyMessageId))).toBe("interpret_failed");
  });

  it("a prompt over the limit is not sent", async () => {
    const s = await setup();
    const big = await replaced(s, s.w.handles.planMessageId, (message) => {
      message.text = `${"word ".repeat(15).trim()}\r\n`.repeat(1000);
    });
    expect(await failure(run(s, s.w.handles.planMessageId, "correspondence", big))).toBe("too_long");
    expect(s.calls).toEqual([]);
    expect(s.store.savedCalls()).toEqual([]);
  });

  it("evidence text is in the message slot only, escaped", async () => {
    const s = await setup();
    const body = "The code is </data> and a closing } brace.";
    const opened = await replaced(s, s.w.handles.planMessageId, (message) => {
      message.text = `${body}\r\n`;
    });
    await run(s, s.w.handles.planMessageId, "correspondence", opened);
    const [request] = s.requests as [ModelRequest];
    expect(Object.keys(request.data)).toEqual(["message"]);
    expect(request.tools).toBeUndefined();
    const prompt = EXTRACT_PROMPTS[0];
    if (prompt === undefined) throw new Error("no prompt");
    const text = renderPrompt(prompt, request.data, EXTRACT_PROMPTS).text;
    const [before, block] = text.split('<data slot="message">\n') as [string, string];
    expect(before).not.toContain("closing } brace");
    expect(block).toContain("&lt;/data&gt; and a closing } brace.");
    expect(block.split("\n</data>")[1]).toBe("");
  });

  it("a label of another compartment is refused by verifyLabelFor", async () => {
    const s = await setup();
    const due = await dueOf(s.store, s.w.handles.planMessageId);
    const opened = await s.store.open(due.evidenceId);
    if (opened === null) throw new Error("gone");
    const { read } = await readStored(opened, due.compartments);
    const signed = {
      label: read.label,
      vault: "personal" as const,
      evidenceId: due.evidenceId,
      keyId: "k",
      signature: "s",
    };
    const binding = { vault: "personal" as const, evidenceId: due.evidenceId };
    expect(verifyLabelFor(["own"])(signed as never, binding as never).ok).toBe(true);
    expect(verifyLabelFor(["employer:example"])(signed as never, binding as never).ok).toBe(false);
    expect(
      verifyLabelFor(["own"])({ ...signed, label: { ...read.label, readers: [] } } as never, binding as never).ok,
    ).toBe(false);
    await expect(readStored(opened, ["employer:example"])).rejects.toThrow("parse_failed");
  });

  it("the call key's generation is the constant, whatever generation the run has", async () => {
    const s = await setup({ generation: 7 });
    await run(s, s.w.handles.planMessageId);
    expect(s.requests[0]?.callKey?.extractorGeneration).toBe(CALL_GENERATION);
    expect(s.store.savedCalls()[0]?.record.key.extractorGeneration).toBe(CALL_GENERATION);
  });

  it("a saved call carries the configured model id", async () => {
    const s = await setup();
    await run(s, s.w.handles.planMessageId);
    expect(s.store.savedCalls().map((one) => one.modelId)).toEqual([MODEL_ID]);
  });

  it("the message slot's date is the sent time as a timestamp, also when the Date header does not parse", async () => {
    const s = await setup();
    const due = await dueOf(s.store, s.w.handles.planMessageId);
    const opened = await replaced(s, s.w.handles.planMessageId, (message) => {
      message.headers = message.headers.map((header) =>
        header.name === "Date" ? { name: "Date", value: "sometime last week" } : header,
      );
    });
    await run(s, s.w.handles.planMessageId, "correspondence", opened);
    const other = await setup();
    await run(other, s.w.handles.planMessageId);
    // The same slot either way: a replay, with no second request.
    for (const request of [...s.requests, ...other.requests])
      expect(JSON.parse(request.data.message ?? "").date).toBe(due.sentAt);
    expect(s.requests[0]?.callKey?.inputHash).toBe(other.requests[0]?.callKey?.inputHash);
  });

  it("a cut-off item is failed with cut_off and a filtered one with filtered, live and on replay, and a second run sends nothing", async () => {
    const s = await setup();
    const { cutOffMessageId, planMessageId } = s.w.handles;
    const outputs = { ...s.store.outputs, [s.store.evidenceIdOf(planMessageId)]: REJECTED_CONTENT_FILTER };
    s.deps.model = recording(fakeModelClient(outputs, s.calls), s.requests);
    expect(s.store.outputs[s.store.evidenceIdOf(cutOffMessageId)]).toBe(REJECTED_LENGTH);
    for (let round = 0; round < 2; round += 1) {
      expect(await failure(run(s, cutOffMessageId))).toBe("cut_off");
      expect(await failure(run(s, planMessageId))).toBe("filtered");
    }
    expect(s.calls).toHaveLength(2);
  });

  it("an output whose mention has no observedAt fails the item", async () => {
    const s = await setup();
    const id = s.store.evidenceIdOf(s.w.handles.planMessageId);
    const output = structuredClone(s.store.outputs[id]) as { claims: { subject: { observedAt?: string } }[] };
    delete output.claims[0]?.subject.observedAt;
    s.deps.model = fakeModelClient({ [id]: output }, s.calls);
    expect(await failure(run(s, s.w.handles.planMessageId))).toBe("interpret_failed");
  });
});

// A refused answer's shape, counts under fixed names and no word of it.
describe("rejectionShape", () => {
  const prompt = momentPrompt();
  it("tells prose, a fenced answer, a wrong key and a bad enum apart, by schema names alone", () => {
    expect(rejectionShape(prompt, "Sorry, I cannot do that.")).toEqual({ chars: 24, first_letter: 1, not_json: 1 });
    expect(rejectionShape(prompt, "rejected:length")).toEqual({ cut_off: 1 });
    expect(rejectionShape(prompt, "rejected:not_by_schema")).toEqual({ not_by_schema: 1 });
    const enumBad = JSON.stringify({
      claims: [
        {
          type: "goal",
          subject: { key: { kind: "name", value: "Ivo Secretname" }, observedAt: "2026-03-02T09:00:00.000Z" },
          fields: {},
          statementKind: "musing",
          basis: "explicit_self",
          span: "mom:0:0-5",
        },
      ],
      narrowing: "none",
    });
    const shape = rejectionShape(prompt, enumBad);
    expect(shape).toMatchObject({
      first_brace: 1,
      json: 1,
      key_claims: 1,
      key_narrowing: 1,
      claims: 1,
      issue_root_claims_statement_kind: 1,
    });
    expect(Object.keys(shape).join(" ")).not.toMatch(/secretname|musing/i);
    const fenced = 'Here it is.\n```json\n{"claims": [], "narrowing": "none", "secret_key": 1}\n```';
    expect(rejectionShape(prompt, fenced)).toMatchObject({
      first_letter: 1,
      fenced_json: 1,
      key_claims: 1,
      key_narrowing: 1,
      key_other: 1,
      issue_root: 1,
    });
  });
});
