import { createHash } from "node:crypto";
import type { ModelRequest, ModelResponse } from "@intelligence/contracts";
import type { KeyedCallKey, KeyedCallStore } from "@intelligence/contracts/personal";
import { ULID_PATTERN } from "@intelligence/contracts/personal";
import { checkCompletion, checkReply } from "./client/checks.ts";
import type { ModelClient } from "./client/client.ts";
import { ModelClientError, ModelOutputRejected } from "./client/errors.ts";
import { type Prompt, validateOutput } from "./client/prompts.ts";
import { rejectedText } from "./client/replay.ts";

// The replay of a call that is not about one evidence item: the shared completeWithReplay's rules,
// in its order, on a key named by a subject instead of an evidence id. The record keeps the output,
// the key, the refs and the compartments, and never the rendered input, so no name or text is kept
// beside a fingerprint.

// What the caller names of a call. `subject` is built by code from ids and keyed fingerprints
// only; `refs` are what the input rested on; `modelId` is the configured model, saved with the
// record.
export type KeyedCall = { point: string; version: number; subject: string; refs: string[]; modelId: string };

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// `pair:<a>:<b>`, two address fingerprints sorted; `facts:<a>:<b>`, two fact key fingerprints
// sorted; or `draft:<draft id>`, a Crockford ULID.
const PAIR = /^(?:pair|facts):([0-9a-f]{64}):([0-9a-f]{64})$/;
const DRAFT = new RegExp(`^draft:drf_${ULID_PATTERN}$`);
const goodSubject = (subject: string): boolean => {
  const pair = PAIR.exec(subject);
  return pair !== null ? (pair[1] ?? "") < (pair[2] ?? "") : DRAFT.test(subject);
};

// What vault.decision_calls takes: 1 to 100 refs, each an id or a fingerprint. Checked before the
// call, so a call that could not be saved, and so never replayed, is never paid for.
const REF = /^[A-Za-z0-9_]{1,128}$/;
const goodRefs = (refs: readonly string[]): boolean =>
  refs.length >= 1 && refs.length <= 100 && refs.every((ref) => REF.test(ref));

const sameKey = (a: KeyedCallKey, b: KeyedCallKey): boolean =>
  a.point === b.point &&
  a.version === b.version &&
  a.promptId === b.promptId &&
  a.promptVersion === b.promptVersion &&
  a.subject === b.subject &&
  a.inputHash === b.inputHash;

// Calls the client at most once for each key. The input hash is the hash of the rendered prompt,
// taken here and never from the caller. The request carries no call key: its key is this one.
export async function completeKeyedWithReplay(
  client: ModelClient,
  store: KeyedCallStore,
  req: ModelRequest,
  call: KeyedCall,
  compartments: string[],
  registry: readonly Prompt[],
): Promise<ModelResponse> {
  const { request, prompt, rendered } = checkCompletion(req, registry);
  // The key hashes the rendered slots and nothing of tools or messages, so a loop would replay.
  if (request.tools !== undefined || request.messages !== undefined) throw new ModelClientError("tools_not_allowed");
  if (
    request.callKey !== undefined ||
    !goodSubject(call.subject) ||
    compartments.length === 0 ||
    !goodRefs(call.refs) ||
    call.modelId === ""
  )
    throw new ModelClientError("bad_key");

  const key: KeyedCallKey = {
    point: call.point,
    version: call.version,
    promptId: request.promptId,
    promptVersion: request.promptVersion,
    subject: call.subject,
    inputHash: sha256(rendered.text),
  };

  // A record the store returns for any other key is a miss, never a replay.
  const stored = await store.find(key);
  if (stored !== null && sameKey(stored.key, key)) {
    if (sha256(stored.rawOutput) !== stored.outputHash) throw new ModelClientError("bad_record");
    return {
      output: validateOutput(prompt, stored.rawOutput),
      label: request.label,
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      modelId: "replay",
    };
  }

  const save = (rawOutput: string) =>
    store.save({
      key,
      rawOutput,
      outputHash: sha256(rawOutput),
      refs: [...call.refs],
      compartments: [...compartments],
      modelId: call.modelId,
    });

  let response: ModelResponse;
  try {
    response = checkReply(prompt, request, await client.complete(request));
    if (response.blocks?.length) throw new ModelOutputRejected(JSON.stringify(response.output));
  } catch (error) {
    // A rejected output is saved, whichever client threw it, so a retry replays the refusal.
    if (error instanceof ModelOutputRejected) await save(rejectedText(prompt, error.rawOutput));
    throw error;
  }
  await save(JSON.stringify(response.output));
  return response;
}
