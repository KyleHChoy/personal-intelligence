import {
  ContentKeys,
  type ModelCallKey,
  type ModelCallRecord,
  type ModelCallStore,
  type ModelRequest,
  type ModelResponse,
} from "@intelligence/contracts";
import { checkCompletion, checkReply } from "./checks.ts";
import type { ModelClient } from "./client.ts";
import { ModelClientError, ModelOutputRejected } from "./errors.ts";
import { type Prompt, REGISTRY, sha256, validateOutput } from "./prompts.ts";

const sameKey = (a: ModelCallKey, b: ModelCallKey): boolean =>
  a.evidenceId === b.evidenceId &&
  a.revision === b.revision &&
  a.extractorGeneration === b.extractorGeneration &&
  a.promptId === b.promptId &&
  a.promptVersion === b.promptVersion &&
  a.inputHash === b.inputHash;

// The text saved for a rejected output. One the schema refuses is saved as it is. Any other
// would replay as a success, or is no text at all, so what is saved starts with a marker that
// is not JSON: `validateOutput` refuses it under any schema, and the replay is a rejection again.
const REJECTED = "rejected:not_by_schema";
export const rejectedText = (prompt: Prompt, rawOutput: unknown): string => {
  if (typeof rawOutput !== "string") return REJECTED;
  try {
    validateOutput(prompt, rawOutput);
    return `${REJECTED} ${rawOutput}`;
  } catch {
    return rawOutput;
  }
};

// Calls the gateway at most once for each ModelCallKey. A saved record is returned with no
// gateway call. The key's input hash is the hash of the rendered prompt, taken here and never
// from the caller, so a changed input never replays an old output. `keys` names every item the
// input held: the message and its reply chain, never the whole thread. The prompt is looked up
// in `registry`: the package's own unless the caller passes another.
export async function completeWithReplay(
  client: ModelClient,
  saved: ModelCallStore,
  req: ModelRequest,
  keys: ContentKeys,
  registry: readonly Prompt[] = REGISTRY,
): Promise<ModelResponse> {
  const { request, prompt, rendered } = checkCompletion(req, registry);
  // The key below hashes the rendered slots and nothing of the tools or messages, so each later
  // turn of a loop would replay the first. Such a request is refused, whatever its prompt allows.
  if (request.tools !== undefined || request.messages !== undefined) throw new ModelClientError("tools_not_allowed");
  const callKey = request.callKey;
  if (
    callKey === undefined ||
    callKey.promptId !== request.promptId ||
    callKey.promptVersion !== request.promptVersion
  ) {
    throw new ModelClientError("bad_key");
  }
  const heldKeys = ContentKeys.safeParse(keys);
  if (!heldKeys.success || !heldKeys.data.some((held) => held.evidenceId === callKey.evidenceId)) {
    throw new ModelClientError("bad_key");
  }

  const renderedInput = rendered.text;
  const key = { ...callKey, inputHash: sha256(renderedInput) };

  // A record the store returns for any other key is a miss, never a replay.
  const stored = await saved.find(key);
  const found = stored !== null && sameKey(stored.key, key) ? stored : null;
  if (found !== null) {
    if (sha256(found.rawOutput) !== found.outputHash) throw new ModelClientError("bad_record");
    return {
      output: validateOutput(prompt, found.rawOutput),
      label: request.label,
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      modelId: "replay",
    };
  }

  const record = (rawOutput: string): ModelCallRecord => ({
    key,
    keys: heldKeys.data,
    renderedInput,
    rawOutput,
    outputHash: sha256(rawOutput),
    label: request.label,
    origin: "live",
  });

  // What the gateway client checks of a reply is checked here too, by the same helper, so a
  // client the caller brings cannot skip it. The request carried no tools, so a tool call in
  // the reply is a rejected output here, whatever the prompt allows.
  let response: ModelResponse;
  try {
    response = checkReply(prompt, request, await client.complete({ ...request, callKey: key }));
    if (response.blocks?.length) throw new ModelOutputRejected(JSON.stringify(response.output));
  } catch (error) {
    // A rejected output is still saved, whichever client threw it, so a retry replays the refusal.
    if (error instanceof ModelOutputRejected) await saved.save(record(rejectedText(prompt, error.rawOutput)));
    throw error;
  }
  await saved.save(record(JSON.stringify(response.output)));
  return response;
}
