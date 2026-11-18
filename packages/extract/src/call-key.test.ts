import type { ModelCallKey, ModelCallStore, Timestamp } from "@intelligence/contracts";
import type { MessageTriageRow, OpenedRecord } from "@intelligence/contracts/personal";
import { type ModelClient, ModelClientError } from "@intelligence/personal-models";
import { describe, expect, it } from "vitest";
import { askDecideModel, decideInputHash } from "./decide-call.ts";
import { fitRecordSlot, fitScreenSlot } from "./fit.ts";
import { interpret, interpretItem, readRecord, savedCall } from "./interpret.ts";
import { messageData } from "./message.ts";
import { documentPrompt, meetingPrompt, momentPrompt, ownLinesPrompt, promptAt, promptFor } from "./prompts.ts";
import { DECIDE_RECORD, DECIDE_SCREEN } from "./question-prompts.ts";
import { recoveryAnswer } from "./recovery.ts";
import { screenItem } from "./screen.ts";

// What every path asks a saved call under, literal: a saved call must replay after any refactor, or
// evidence is sent again and paid for again. Nothing here is computed by the code it pins.

const EVIDENCE = "a".repeat(64);
const SENT = "2026-03-02T09:00:00.000Z" as Timestamp;
const record = {
  body: "I will send the plans by Friday.",
  context: { evidenceId: EVIDENCE, compartments: ["own"], identity: {} },
  item: { recordedAt: SENT },
} as unknown as OpenedRecord;
const { parsed, read } = readRecord(record, ["own"]);
const ROW: MessageTriageRow = { direction: "inbound", bulk: false, category: "primary", unreadable: false, chars: 32 };

const AWAY: ModelClient = {
  complete: () => Promise.reject(new ModelClientError("unavailable")),
  embed: () => Promise.reject(new ModelClientError("unavailable")),
};
// A store with nothing saved, noting each key it is asked for.
const noting = () => {
  const keys: ModelCallKey[] = [];
  const calls: ModelCallStore = {
    find: async (key) => {
      keys.push(key);
      return null;
    },
    save: async () => {},
  };
  return { keys, calls };
};
const keyOf = async (ask: (calls: ModelCallStore) => Promise<unknown>): Promise<ModelCallKey> => {
  const { keys, calls } = noting();
  await ask(calls).catch(() => null);
  expect(keys).toHaveLength(1);
  return keys[0] as ModelCallKey;
};
const decide = (calls: ModelCallStore) => ({
  store: { calls: () => calls } as never,
  decideModel: { model: AWAY, modelId: "decide" },
});

const key = (promptId: string, promptVersion: string, inputHash: string) => ({
  promptId,
  promptVersion,
  evidenceId: EVIDENCE,
  revision: 0,
  extractorGeneration: 0,
  inputHash,
});

describe("the key of every call", () => {
  const data = messageData(parsed, SENT);

  it("an item's call, whichever way it is asked", async () => {
    const expected = key(
      "personal_correspondence",
      "4",
      "751a436214503ace23a87a955035db158b5fe3abcaf8a57ca83bf6131fd60bb5",
    );
    expect(
      await keyOf((calls) => interpret(promptFor("correspondence"), data, parsed, read, { model: AWAY, calls })),
    ).toEqual(expected);
    expect(
      await keyOf((calls) =>
        interpretItem(parsed, read, "correspondence", SENT, {
          model: AWAY,
          modelId: "m",
          store: { calls: () => calls },
        } as never),
      ),
    ).toEqual(expected);
  });

  it("savedCall asks by the very key interpret asks with", async () => {
    const expected = key(
      "personal_correspondence",
      "4",
      "751a436214503ace23a87a955035db158b5fe3abcaf8a57ca83bf6131fd60bb5",
    );
    expect(await keyOf((calls) => savedCall(promptFor("correspondence"), data, parsed, calls))).toEqual(expected);
  });

  it("a later version of a lane's prompt", async () => {
    expect(
      await keyOf((calls) => interpret(promptAt("correspondence", "11"), data, parsed, read, { model: AWAY, calls })),
    ).toEqual(key("personal_correspondence", "11", "5679650a737b1f72a80d6d047b6f2334bd72d544c7cc4fdea2375e433a8ea657"));
    expect(
      await keyOf((calls) => interpret(promptAt("agent", "9"), data, parsed, read, { model: AWAY, calls })),
    ).toEqual(key("personal_agent_record", "9", "14b3518c49cc4fb69c091d5c60671c4a83615920b3898a3fb6785ae0d61d7656"));
    expect(
      await keyOf((calls) => interpret(promptAt("transaction", "4"), data, parsed, read, { model: AWAY, calls })),
    ).toEqual(key("personal_transaction", "4", "40276593b3aea494c175db426e98018ee1996e335feb3d9826df7c2674c9ced1"));
  });

  it("the other lanes' slots", async () => {
    expect(
      await keyOf((calls) => interpret(documentPrompt(), { document: "{}" }, parsed, read, { model: AWAY, calls })),
    ).toEqual(key("personal_document", "1", "2b39cef377f5eac1864abc4cc7d045e477244b03bf18657ee7d429b840610568"));
    expect(
      await keyOf((calls) => interpret(meetingPrompt(), { meeting: "{}" }, parsed, read, { model: AWAY, calls })),
    ).toEqual(key("personal_meeting", "7", "1d0cbcc1e6d79c5e8acd04a971799bacbe03a0c485b88fd64c0c88d9c2eaece8"));
    expect(
      await keyOf((calls) => interpret(momentPrompt(), { moments: "{}" }, parsed, read, { model: AWAY, calls })),
    ).toEqual(key("personal_moment", "9", "3d16fb9f929fb2dc87b467dfb737655f30339bcaa39fa6193a086d15e14c6c9f"));
    expect(
      await keyOf((calls) => interpret(ownLinesPrompt(), { moments: "{}" }, parsed, read, { model: AWAY, calls })),
    ).toEqual(key("personal_own_lines", "1", "b399a32413b08b73a02931ecd758dfacf0f013bfeaef2863cdc022650ccdf4db"));
  });

  it("the item screen, under the decide model's prompt", async () => {
    const data = { message: JSON.stringify(fitScreenSlot(parsed, ROW)) };
    const expected = key("jev_screen", "1", "fe8613467bfd15a988392fc6d7dc3cdb7c5852442e9b06bbbfa1e6544f5ae093");
    expect(await keyOf((calls) => screenItem(parsed, read, ROW, decide(calls)))).toEqual(expected);
    expect(await keyOf((calls) => askDecideModel(DECIDE_SCREEN, data, parsed, read, decide(calls)))).toEqual(expected);
    expect(decideInputHash(DECIDE_SCREEN, data)).toBe(
      "fe8613467bfd15a988392fc6d7dc3cdb7c5852442e9b06bbbfa1e6544f5ae093",
    );
  });

  it("the record and recovery screens", async () => {
    expect(
      await keyOf((calls) =>
        askDecideModel(
          DECIDE_RECORD,
          { record: JSON.stringify(fitRecordSlot(record.body)) },
          parsed,
          read,
          decide(calls),
        ),
      ),
    ).toEqual(key("jev_record", "2", "38d6d4697c3fd8fbe9f0446af17ebc5986cf610397ff998bd7a1caa96ee7c692"));
    expect(await keyOf((calls) => recoveryAnswer(parsed, read, ROW, decide(calls)))).toEqual(
      key("jev_recovery", "1", "c3aa99c8d4984c4b1312cebb81997a2bb0941cc5f1bf923ae1ca70f89c7660bf"),
    );
  });
});
