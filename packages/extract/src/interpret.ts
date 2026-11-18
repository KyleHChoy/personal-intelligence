import { createHash } from "node:crypto";
import {
  ContentKeys,
  type ModelCallKey,
  type ModelCallStore,
  type ModelRequest,
  SourceAccountId,
  type Timestamp,
} from "@intelligence/contracts";
import {
  isCoded,
  type OpenedItem,
  type OpenedRecord,
  type PipelineCode,
  REJECTED_CONTENT_FILTER,
  REJECTED_LENGTH,
} from "@intelligence/contracts/personal";
import {
  checkOutput,
  type Interpreted,
  type Parsed,
  PipelineError,
  parse,
  type ReadItem,
  verify,
} from "@intelligence/personal-core";
import { memoryItem, pipelineItemOf } from "@intelligence/personal-core/items";
import {
  completeWithReplay,
  type ModelClient,
  ModelClientError,
  ModelOutputRejected,
  type Prompt,
  renderPrompt,
} from "@intelligence/personal-models";
import { ExtractFailure } from "./call-failure.ts";
import { CALL_GENERATION, EXTRACT_CONFIG, EXTRACT_TRUST_GROUP, type ExtractDeps, verifyLabelFor } from "./config.ts";
import { AGENT_PROJECT_VERSIONS } from "./lane-versions.ts";
import { messageData, messageSlot } from "./message.ts";
import type { PromptLane } from "./message-prompts.ts";
import { CALLED_PROMPTS, promptFor } from "./prompts.ts";

// What a refused answer looked like, as counts under fixed names, never a word
// of it (the logger takes counts): its length; whether it was JSON, or JSON in a fence;
// its first character's class; its top-level keys (claims, narrowing, any other); its claims; and
// each schema issue by its code and its path, the path's names only where they are the schema's own
// (an index is dropped, any other name is `other`). A cut-off or filtered answer is its code alone.
const SCHEMA_NAMES: Readonly<Record<string, string>> = Object.freeze({
  claims: "claims",
  narrowing: "narrowing",
  type: "type",
  subject: "subject",
  fields: "fields",
  statementKind: "statement_kind",
  basis: "basis",
  assertedBy: "asserted_by",
  validFrom: "valid_from",
  validTo: "valid_to",
  span: "span",
  context: "context",
  key: "key",
  kind: "kind",
  value: "value",
  observedAt: "observed_at",
  mention: "mention",
});
const snakeOf = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "other";
export function rejectionShape(prompt: Prompt, raw: string): Record<string, number> {
  if (raw === REJECTED_LENGTH) return { cut_off: 1 };
  if (raw === REJECTED_CONTENT_FILTER) return { filtered: 1 };
  // A rejection replay saved with no text of the answer (replay.ts's bare marker).
  if (raw === "rejected:not_by_schema") return { not_by_schema: 1 };
  const text = raw.replace(/^rejected:not_by_schema /, "");
  const shape: Record<string, number> = { chars: text.length };
  const trimmed = text.trim();
  const first = trimmed[0] ?? "";
  shape[
    `first_${first === "{" ? "brace" : first === "[" ? "bracket" : first === "`" ? "fence" : /\p{L}/u.test(first) ? "letter" : first === "" ? "none" : "other"}`
  ] = 1;
  const fenced = /```(?:json)?\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(trimmed)?.[1];
  let parsed: unknown;
  for (const [name, candidate] of [
    ["json", trimmed],
    ["fenced_json", fenced],
  ] as const) {
    if (candidate === undefined || parsed !== undefined) continue;
    try {
      parsed = JSON.parse(candidate);
      shape[name] = 1;
    } catch {
      // not this form
    }
  }
  if (parsed === undefined) return { ...shape, not_json: 1 };
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ...shape, not_object: 1 };
  for (const key of Object.keys(parsed)) {
    const name = key === "claims" || key === "narrowing" ? `key_${key}` : "key_other";
    shape[name] = (shape[name] ?? 0) + 1;
  }
  const claims = (parsed as { claims?: unknown }).claims;
  if (Array.isArray(claims)) shape.claims = claims.length;
  const result = prompt.outputSchema.safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path
        .filter((part): part is string => typeof part === "string")
        .map((part) => (Object.hasOwn(SCHEMA_NAMES, part) ? (SCHEMA_NAMES[part] as string) : "other"));
      const at = `issue_${["root", ...path].join("_")}`.slice(0, 60).replace(/_+$/, "");
      shape[at] = (shape[at] ?? 0) + 1;
      const code = `code_${snakeOf(issue.code)}`.slice(0, 60).replace(/_+$/, "");
      shape[code] = (shape[code] ?? 0) + 1;
    }
  }
  return shape;
}

// A rejection is read by its raw text alone, by exact comparison.
const rejectionCode = (raw: string): PipelineCode =>
  raw === REJECTED_LENGTH ? "cut_off" : raw === REJECTED_CONTENT_FILTER ? "filtered" : "interpret_failed";

// The run acts on these: the model is away or refused, or the budget is reached.
export const passesThrough = (error: unknown): boolean =>
  (error instanceof ModelClientError &&
    !(error instanceof ModelOutputRejected) &&
    (error.code === "unavailable" || error.code === "refused")) ||
  (error instanceof Error && isCoded(error, "budget_reached"));

// One call for one item, under its lane's prompt, made once per call key and replayed after.
// Evidence is in the `message` slot only, escaped. Over `promptChars` nothing is sent (`too_long`).
// `prompt`: the version secondDegreePrompt chose for the item; the lane's current one when absent.
export async function interpretItem(
  parsed: Parsed,
  read: ReadItem,
  lane: PromptLane,
  sentAt: Timestamp,
  deps: ExtractDeps,
  prompt: Prompt = promptFor(lane),
  data: Record<string, string> = messageData(parsed, sentAt),
): Promise<Interpreted> {
  return interpret(prompt, data, parsed, read, {
    model: deps.model,
    calls: deps.store.calls(deps.modelId),
  });
}

// An agent record's project versions are told who the owner is, so they can write `owner:this`: the
// names and addresses code holds under the finding's own label, at most ten of each. Every other
// version's slot stays as it was, so its saved calls replay. Known limit: a new name of the owner
// under the label changes this slot, so a saved call of that item is asked again, once.
const OWNER_KEYS_SHOWN = 10;
export const findingData = (prompt: Prompt, parsed: Parsed, record: OpenedRecord): Record<string, string> => {
  const at = record.item.recordedAt;
  if (!AGENT_PROJECT_VERSIONS.includes(prompt.version)) return messageData(parsed, at);
  const { names, addresses } = record.ownerKeys ?? { names: [], addresses: [] };
  return {
    message: JSON.stringify({
      ...messageSlot(parsed, at),
      owner: { names: names.slice(0, OWNER_KEYS_SHOWN), addresses: addresses.slice(0, OWNER_KEYS_SHOWN) },
    }),
  };
};

// Whether the call one item would make under `prompt` with `data` is saved, by the very key
// `interpret` asks with. A record the store returns for another key is no call. Nothing is sent and
// nothing is written.
export async function savedCall(
  prompt: Prompt,
  data: Record<string, string>,
  parsed: Parsed,
  calls: ModelCallStore,
): Promise<boolean> {
  const key = callKey(prompt, parsed, rendered(prompt, data).inputHash);
  const found = await calls.find(key);
  return (
    found !== null &&
    found.key.promptId === key.promptId &&
    found.key.promptVersion === key.promptVersion &&
    found.key.evidenceId === key.evidenceId &&
    found.key.revision === key.revision &&
    found.key.inputHash === key.inputHash
  );
}

// The prompt as the model is shown it, and the hash its call key holds.
export function rendered(
  prompt: Prompt,
  data: Record<string, string>,
  registry: readonly Prompt[] = CALLED_PROMPTS,
): { text: string; inputHash: string } {
  const text = renderPrompt(prompt, data, registry).text;
  return { text, inputHash: createHash("sha256").update(text, "utf8").digest("hex") };
}

// The one key a saved call is found by, whichever path asks it. A field added here reaches every
// call; a key that differs on one path would miss its replay and send the evidence again.
const callKey = (prompt: Prompt, parsed: Parsed, inputHash: string): ModelCallKey => ({
  promptId: prompt.id,
  promptVersion: prompt.version,
  evidenceId: parsed.evidenceId,
  revision: parsed.revision,
  extractorGeneration: CALL_GENERATION,
  inputHash,
});

// One call's request and the item its input held, as the shared replay takes them.
export const callRequest = (
  prompt: Prompt,
  data: Record<string, string>,
  { parsed, read }: { parsed: Parsed; read: ReadItem },
  inputHash: string,
): { request: ModelRequest; keys: ContentKeys } => ({
  request: {
    promptId: prompt.id,
    promptVersion: prompt.version,
    data,
    label: read.label,
    trustGroup: EXTRACT_TRUST_GROUP,
    callKey: callKey(prompt, parsed, inputHash),
  },
  keys: ContentKeys.parse([{ evidenceId: read.item.id, keyRef: read.item.keyRef }]),
});

// A replay's model: every call it is asked fails its item, so an answer not saved is never bought.
export const REPLAY_ONLY: ModelClient = {
  complete: () => Promise.reject(new ExtractFailure("model_unavailable")),
  embed: () => Promise.reject(new ExtractFailure("model_unavailable")),
};

// The model and the saved calls one call goes through.
export type CallPort = { model: ModelClient; calls: ModelCallStore };

// One call under a prompt with its data, for an item or for one group of a document.
export async function interpret(
  prompt: Prompt,
  data: Record<string, string>,
  parsed: Parsed,
  read: ReadItem,
  port: CallPort,
): Promise<Interpreted> {
  const { text, inputHash } = rendered(prompt, data);
  if (text.length > EXTRACT_CONFIG.limits.promptChars) throw new ExtractFailure("too_long");
  const { request, keys } = callRequest(prompt, data, { parsed, read }, inputHash);
  try {
    const response = await completeWithReplay(port.model, port.calls, request, keys, CALLED_PROMPTS);
    return { output: checkOutput(response.output), inputHash };
  } catch (error) {
    if (passesThrough(error)) throw error;
    if (error instanceof ModelOutputRejected)
      throw new ExtractFailure(rejectionCode(error.rawOutput), rejectionShape(prompt, error.rawOutput));
    if (error instanceof PipelineError || error instanceof ModelClientError)
      throw new ExtractFailure("interpret_failed");
    throw error;
  }
}

// The stored item as the shared functions take it: adapted with the item's own system mark, its
// label verified against its row's compartments, and its block parsed. A label that does not
// verify, or a block the shared parse refuses, is `parse_failed`: either is permanent, so the item
// is not retried. A document is parsed by sections as core's derive parses it: the value handed to
// the parse, and only that value, carries the sentinel reference kind.
export async function readStored(
  opened: OpenedItem,
  compartments: readonly string[],
  options: { sections?: true } = {},
): Promise<{ parsed: Parsed; read: ReadItem }> {
  const item = { ...pipelineItemOf(opened.raw, opened.context), systemOriginated: opened.systemOriginated };
  try {
    const read = verify(item, { config: EXTRACT_CONFIG, verifyLabel: verifyLabelFor(compartments) });
    const given = options.sections === true ? { ...item, referenceKind: "register" as const } : item;
    return {
      parsed: await parse(given, new Uint8Array(Buffer.from(opened.raw.payload, "base64")), EXTRACT_CONFIG.limits),
      read,
    };
  } catch (error) {
    if (error instanceof PipelineError) throw new ExtractFailure("parse_failed");
    throw error;
  }
}

// The sentinels of an agent record built in memory: the shared SourceKind has no agent record, so
// the item carries `research_note`, which nothing stores; its account, signature and key are as
// unread as a message's.
const NO_ACCOUNT = SourceAccountId.parse("personal-agent-record");
// The account sentinel of a meeting or a moment built in memory.
export const CAPTURE_ACCOUNT = SourceAccountId.parse("personal-capture");

// An item built in memory, not parsed from a stored block, as the shared functions take it: one
// text, the segments given with no author and not quoted, and no headers. Its label is verified
// against `compartments` as a stored item's is; one that does not verify is `parse_failed`.
export function readBuilt(
  item: Parameters<typeof memoryItem>[0],
  compartments: readonly string[],
  text: string,
  segments: readonly { span: string; text: string }[],
): { parsed: Parsed; read: ReadItem } {
  const built = memoryItem(item);
  let read: ReadItem;
  try {
    read = verify(built, { config: EXTRACT_CONFIG, verifyLabel: verifyLabelFor(compartments) });
  } catch (error) {
    if (error instanceof PipelineError) throw new ExtractFailure("parse_failed");
    throw error;
  }
  const parsed: Parsed = {
    evidenceId: item.id,
    revision: item.revision,
    sourceKind: item.sourceKind,
    automated: false,
    segments: segments.map((segment) => ({ span: segment.span, quoted: false, text: segment.text })),
    headers: {},
    replyChainEvidenceIds: [],
    unreadAttachments: 0,
    texts: { "": text },
  };
  return { parsed, read };
}

// An agent record as the shared functions take it, built here because the shared parse reads
// a stored message block and an agent record is not one. One segment, the whole body, with no
// author and not quoted; no headers, so the `message` slot has no sender and no recipients. Its
// span is the shared form over the body (`chars:0-<length>`), the only form the shared checker
// reads. The label is verified as a message's is, against the row's whole label.
export function readRecord(record: OpenedRecord, compartments: readonly string[]): { parsed: Parsed; read: ReadItem } {
  const { body, context, item: recorded } = record;
  return readBuilt(
    {
      id: context.evidenceId,
      sourceKind: "research_note",
      sourceAccount: NO_ACCOUNT,
      revision: 0,
      contentHash: createHash("sha256").update(body, "utf8").digest("hex"),
      mediaType: "text/plain",
      observedAt: recorded.recordedAt,
      ingestedAt: recorded.recordedAt,
      compartments: context.compartments,
    },
    compartments,
    body,
    [{ span: `chars:0-${body.length}`, text: body }],
  );
}
