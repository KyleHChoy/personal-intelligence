import type { QuestionTried } from "@intelligence/contracts/personal";
import type { WorkClient } from "./work-clients.ts";
import { ok, type WorkWorld } from "./work-test-world.ts";

// The client needs both tools (insertWorkClient's default).
export async function triedFor(w: WorkWorld, client: WorkClient, compartments = ["own"]): Promise<QuestionTried> {
  const message = await w.message(compartments);
  ok(await w.reader.findMessages(client.token, {}));
  ok(await w.reader.readMessage(client.token, { id: message.id as never }));
  return {
    searches: [{ tool: "find_messages", query: "the delivery date" }],
    sources: [message.id as never],
    why: "No message names a delivery date.",
  };
}
