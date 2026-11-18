import type { EvidenceId, ModelRequest } from "@intelligence/contracts";
import type { DueItem, OpenedItem, PersonalLogEvent, PersonalLogger } from "@intelligence/contracts/personal";
import { gmailItem } from "@intelligence/personal-core/items";
import { world } from "@intelligence/personal-core/testing";
import type { ModelClient } from "@intelligence/personal-models";
import { fakeDecideClient, fakeModelClient } from "@intelligence/personal-models/testing";
import { EXTRACT_GENERATION, type ExtractDeps } from "../config.ts";
import { processItem } from "../process-item.ts";
import { type MemoryPipelineStore, memoryPipelineStore } from "./memory-store.ts";

// What this package's own tests share: the fixed clock, the world's store, a logger that keeps
// its lines, and a model that records each request.

export const NOW = new Date("2026-10-01T12:00:00.000Z");
export const MODEL_ID = "test/luna";

type Logged = { level: "info" | "warn" | "error"; event: PersonalLogEvent };
const keptLog = (lines: Logged[] = []): PersonalLogger & { lines: Logged[] } => ({
  lines,
  info: (event) => void lines.push({ level: "info", event }),
  warn: (event) => void lines.push({ level: "warn", event }),
  error: (event) => void lines.push({ level: "error", event }),
});

// A client that keeps every request it is handed before passing it on.
export const recording = (inner: ModelClient, requests: ModelRequest[]): ModelClient => ({
  complete: (request) => {
    requests.push(request);
    return inner.complete(request);
  },
  embed: (request) => inner.embed(request),
});

export type Setup = {
  w: ReturnType<typeof world>;
  store: MemoryPipelineStore;
  calls: string[];
  requests: ModelRequest[];
  decideCalls: string[];
  // The decide model's calls of its other prompts, each `<prompt id>:<evidence id>`.
  otherDecideCalls: string[];
  decideRequests: ModelRequest[];
  deps: ExtractDeps;
  log: ReturnType<typeof keptLog>;
};

export async function setup(over: Partial<ExtractDeps> = {}): Promise<Setup> {
  const w = world({ now: NOW });
  const store = await memoryPipelineStore(w);
  const calls: string[] = [];
  const requests: ModelRequest[] = [];
  const log = keptLog();
  const deps: ExtractDeps = {
    store,
    model: recording(fakeModelClient(store.outputs, calls), requests),
    modelId: MODEL_ID,
    log,
    now: () => NOW,
    ...over,
  };
  return { w, store, calls, requests, decideCalls: [], otherDecideCalls: [], decideRequests: [], deps, log };
}

// A message's due item: every world item is one.
type EmailDue = Extract<DueItem, { source: "email" }>;

export async function dueOf(
  store: MemoryPipelineStore,
  gmailId: string,
  generation = EXTRACT_GENERATION,
): Promise<EmailDue> {
  const id = store.evidenceIdOf(gmailId);
  const found = (await store.due(1000, generation)).find((one) => one.evidenceId === id);
  if (found?.source !== "email") throw new Error("not due");
  return found;
}

// The model answers these outputs, by Gmail id, over the world's.
export function answering(s: Setup, outputs: Record<string, unknown>): void {
  const all = { ...s.store.outputs };
  for (const [gmailId, output] of Object.entries(outputs)) all[s.store.evidenceIdOf(gmailId)] = output;
  s.deps.model = recording(fakeModelClient(all, s.calls), s.requests);
}

type Message = Setup["w"]["accounts"][number]["messages"][number];

// The store opens this item with its message changed as given: a message the world does not hold.
export function changed(
  s: Setup,
  gmailId: string,
  change: (message: Message) => void,
  item: (opened: OpenedItem) => OpenedItem = (one) => one,
): void {
  const id = s.store.evidenceIdOf(gmailId);
  const store = s.deps.store;
  s.deps.store = {
    ...store,
    async open(evidenceId) {
      const opened = await store.open(evidenceId);
      if (opened === null || evidenceId !== id) return opened;
      const message = structuredClone(
        s.w.accounts.flatMap((box) => box.messages).find((one) => one.id === gmailId),
      ) as Message;
      change(message);
      return item({
        ...opened,
        raw: gmailItem(message, { sourceAccount: opened.raw.sourceAccount, changeKind: opened.raw.changeKind }),
      });
    },
  };
}

// Runs one world item through processItem.
export async function processOne(s: Setup, gmailId: string) {
  return processItem(await dueOf(s.store, gmailId, s.deps.generation ?? EXTRACT_GENERATION), s.deps);
}

// The decide model's model id in tests, and an answer that changes nothing: a person wrote it, and it is neither
// sensitive nor an injection.
export const DECIDE_MODEL_ID = "typesafe/jev-1.13";
export const NEUTRAL = { human_written: 0.9, special_category: 0.01, quarantine: 0.01 };

// The recovery and record screens' answers that change nothing.
export const NO_RECOVERY = { account_recovery: 0.01 };
const NO_INSTRUCTION = { quarantine: 0.01 };
// The claim intake's answers that refuse nothing.
const STANDS = { standalone: 0.99 };
const SAID = { said: 0.99 };

// Turns the decide model on: every stored item answers `fallback` (none, when it is null), and the items
// `answers` names by Gmail id answer as given. A key `<prompt id>:<Gmail id>` answers that prompt
// for that item. With a fallback, the recovery and record screens answer "no" for every item unless
// told otherwise. The decide model's calls and requests are kept apart from the extract model's; its item screen's calls (the
// one NEUTRAL answers) go to `decideCalls`, its other prompts' to `otherDecideCalls`.
export function withDecideModel(s: Setup, answers: Record<string, unknown> = {}, fallback: unknown = NEUTRAL): void {
  const all: Record<string, unknown> =
    fallback === null
      ? {}
      : {
          ...Object.fromEntries(Object.keys(s.store.outputs).map((id) => [id, fallback])),
          jev_recovery: NO_RECOVERY,
          jev_record: NO_INSTRUCTION,
          jev_standalone: STANDS,
          jev_said: SAID,
        };
  for (const [key, output] of Object.entries(answers)) {
    const at = key.indexOf(":");
    if (at < 0) all[s.store.evidenceIdOf(key)] = output;
    else {
      // A Gmail id, or an evidence id as it is (an agent record has no Gmail id).
      const item = key.slice(at + 1);
      all[`${key.slice(0, at)}:${/^[0-9a-f]{64}$/.test(item) ? item : s.store.evidenceIdOf(item)}`] = output;
    }
  }
  const calls = {
    push: (...ids: string[]) => {
      for (const id of ids) (id.includes(":") ? s.otherDecideCalls : s.decideCalls).push(id);
    },
  } as unknown as string[];
  s.deps.decideModel = { model: recording(fakeDecideClient(all, calls), s.decideRequests), modelId: DECIDE_MODEL_ID };
}

export const recordsOf = (s: Setup, gmailId: string) =>
  s.store.claims().filter((one) => one.evidenceId === s.store.evidenceIdOf(gmailId));
export const unmappedOf = (s: Setup, gmailId: string) =>
  s.store.unmapped().filter((one) => one.evidenceId === s.store.evidenceIdOf(gmailId));

// An agent record's body as the tests write it: JSON with object keys sorted.
export const recordBody = (value: unknown): string => {
  const sorted = (one: unknown): unknown =>
    Array.isArray(one)
      ? one.map(sorted)
      : typeof one === "object" && one !== null
        ? Object.fromEntries(
            Object.keys(one)
              .sort()
              .map((key) => [key, sorted((one as Record<string, unknown>)[key])]),
          )
        : one;
  return JSON.stringify(sorted(value));
};

// Processes the agent record `id`, which must be due.
export const processRecord = async (s: Setup, id: EvidenceId) => {
  const due = (await s.store.due(1000, 1)).find((one) => one.evidenceId === id);
  if (due?.source !== "agent_record") throw new Error("not due");
  return processItem(due, s.deps);
};

// The claims built from the evidence `id`.
export const claimsOf = (s: Setup, id: EvidenceId) => s.store.claims().filter((one) => one.evidenceId === id);
