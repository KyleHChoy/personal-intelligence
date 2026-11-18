// An id of the wrong kind, sent where another kind goes: the log keeps its form by prefix and never
// its value, and the agent is told what it sent and which tool reads that kind.
import { describe, expect, it } from "vitest";
import { handleAtOnce as handle, NO_WORK } from "./test-support/fakes.ts";
import { call, fakeLog, fakeReads, TOKEN } from "./test-support/handle-fixtures.ts";

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ3";
const RECORD_RULE = "an id exactly as a tool gave it: rec_ or hdl_ followed by 26 characters, never a name";
const MESSAGE_RULE = "an id exactly as a tool gave it: msg_ or hdl_ followed by 26 characters, never a name";

async function refused(tool: string, args: Record<string, unknown>) {
  const { log, events } = fakeLog();
  const reply = (await handle({ provider: fakeReads().reads, work: NO_WORK }, log, TOKEN, call(tool, args))) as {
    result: { content: { text: string }[] };
  };
  const [code, details] = reply.result.content;
  expect(code?.text).toBe("invalid_request");
  const told = JSON.parse(details?.text ?? "{}") as { arguments: { name: string; rule: string }[] };
  const [event] = events;
  return { told: told.arguments, logged: { reason: event?.reason, argument: event?.argument }, events };
}

describe("an id of the wrong kind", () => {
  const cases: { tool: string; args: Record<string, unknown>; reason: string; rule: string }[] = [
    {
      tool: "read_record",
      args: { record: `msg_${ULID}` },
      reason: "schema_id_form_msg",
      rule: `${RECORD_RULE}. This is a message id: read_message reads it.`,
    },
    {
      tool: "read_record",
      args: { record: `opp_${ULID}` },
      reason: "schema_id_form_opp",
      rule: `${RECORD_RULE}. This is an opportunity id.`,
    },
    {
      tool: "read_record",
      args: { record: "e".repeat(64) },
      reason: "schema_id_form_hex64",
      rule: `${RECORD_RULE}. This is a fact id: get_evidence_span reads it.`,
    },
    {
      tool: "read_record",
      args: { record: "Kiln firing notes" },
      reason: "schema_id_form_other",
      rule: `${RECORD_RULE}. This is no id.`,
    },
    {
      tool: "read_record",
      args: { record: `doc_${ULID}` },
      reason: "schema_id_form_doc",
      rule: `${RECORD_RULE}. This is a document id: get_document reads it.`,
    },
    {
      tool: "read_record",
      args: { record: "rec_01JABC" },
      reason: "schema_id_form_rec",
      rule: `${RECORD_RULE}. This rec_ id is cut short or changed.`,
    },
    {
      tool: "read_item",
      args: { message: `rec_${ULID}` },
      reason: "schema_id_form_rec",
      rule: `${MESSAGE_RULE}. This is an agent record id: read_record reads it.`,
    },
    {
      tool: "read_item",
      args: { message: `ent_${ULID}` },
      reason: "schema_id_form_ent",
      rule: `${MESSAGE_RULE}. This is an entity id: get_entity reads it.`,
    },
    {
      tool: "read_item",
      args: { message: "e".repeat(64) },
      reason: "schema_id_form_hex64",
      rule: `${MESSAGE_RULE}. This is a fact id: get_evidence_span reads it.`,
    },
    {
      tool: "read_item",
      args: { message: "Invoice 4417" },
      reason: "schema_id_form_other",
      rule: `${MESSAGE_RULE}. This is no id.`,
    },
  ];

  it("is logged by its form and told what it is and which tool reads it", async () => {
    for (const { tool, args, reason, rule } of cases) {
      const { told, logged, events } = await refused(tool, args);
      const [name] = Object.keys(args);
      expect(logged, `${tool} ${reason}`).toEqual({ reason, argument: name });
      expect(told, `${tool} ${reason}`).toEqual([{ name, rule }]);
      const line = JSON.stringify(events);
      for (const value of Object.values(args)) expect(line).not.toContain(value);
    }
  });

  it("an argument of any name that takes ids is logged by the form sent, not only id and opportunity", async () => {
    const { logged } = await refused("find_paths", { target: `msg_${ULID}` });
    expect(logged).toEqual({ reason: "schema_id_form_msg", argument: "target" });
    // Where id and opportunity were logged by form before, they still are.
    expect((await refused("get_entity", { id: `rec_${ULID}` })).logged).toEqual({
      reason: "schema_id_form_rec",
      argument: "id",
    });
  });

  it("a value of the wrong type is no id form: its issue is logged as before", async () => {
    const { logged } = await refused("read_record", { record: 7 });
    expect(logged).toEqual({ reason: "schema_invalid_union", argument: "record" });
  });
});
