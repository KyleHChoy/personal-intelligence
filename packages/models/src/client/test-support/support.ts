import {
  ContentKeys,
  EvidenceId,
  type HttpPort,
  type HttpRequest,
  type HttpResponse,
  InterpreterOutput,
  Label,
  ModelCallKey,
  type ModelRequest,
  SignedJobScope,
  TrustGroupId,
} from "@intelligence/contracts";
import { vi } from "vitest";
import { type Prompt, promptTextHash } from "../prompts.ts";
import type { GatewayEndpoint } from "./gateway.ts";

// Synthetic values for the tests of this package. Nothing here is real data.

export const trustGroup = TrustGroupId.parse("tg-team");
export const otherTrustGroup = TrustGroupId.parse("tg-people");

export const label = Label.parse({ compartments: ["people", "source:acct-ben"], readers: ["m-ben"] });
export const widerLabel = Label.parse({ compartments: ["org"], readers: ["all_members"] });

export const evidenceId = EvidenceId.parse("ev-1");
const replyId = EvidenceId.parse("ev-0");

export const scopeFor = (gateway: string) =>
  SignedJobScope.parse({
    kind: "job_scope",
    payload: { id: "scope-1", role: "pipeline", gateway, expiresAt: "2026-09-03T01:00:00Z" },
    keyId: "k-policy-1",
    signature: "sig",
  });

export const endpoint = (overrides: Partial<GatewayEndpoint> = {}): GatewayEndpoint => ({
  url: "https://gateway.team.example",
  trustGroup,
  identity: { role: "pipeline", instance: "pipeline_team", vault: "team", trustGroup },
  scope: async () => scopeFor(trustGroup),
  ...overrides,
});

export const callKey = ModelCallKey.parse({
  evidenceId,
  revision: 1,
  extractorGeneration: 0,
  promptId: "interpreter",
  promptVersion: "1",
  inputHash: "a".repeat(64),
});

export const contentKeys = ContentKeys.parse([
  { evidenceId: replyId, keyRef: "key-0" },
  { evidenceId, keyRef: "key-1" },
]);

export const request = (overrides: Record<string, unknown> = {}): ModelRequest =>
  ({
    promptId: "interpreter",
    promptVersion: "1",
    data: { message: "Maya needs a CFO for the Alder project.", replies: "" },
    label,
    trustGroup,
    callKey,
    ...overrides,
  }) as ModelRequest;

export const okOutput = { claims: [], narrowing: "none" };

export const completion = (output: unknown = okOutput, overrides: Record<string, unknown> = {}): HttpResponse => ({
  status: 200,
  headers: {},
  body: {
    output,
    // A label the gateway made up: the client must never pass it on.
    label: widerLabel,
    usage: { inputTokens: 12, outputTokens: 3, cost: 0.001 },
    modelId: "model-1",
    ...overrides,
  },
});

// An HttpPort that records every request and answers with the handler's reply.
export const fakeHttp = (handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse = () => completion()) => {
  const send = vi.fn(async (req: HttpRequest) => handler(req));
  const port: HttpPort = { send };
  return { port, send, calls: () => send.mock.calls.map(([req]) => req) };
};

// An entry of a registry a caller outside this package writes: frozen, with the hash of its
// text. The hash is taken from the text here so a test can vary the entry; a caller records it
// as a literal, as `callerList` does.
export const callerEntry = (overrides: Partial<Omit<Prompt, "textHash">> = {}): Prompt => {
  const prompt = {
    id: "caller_extract",
    version: "1",
    instructions: "You extract facts from one message. It is given below, in a block.",
    slots: ["message"],
    outputSchemaId: "InterpreterOutput",
    outputSchema: InterpreterOutput,
    tools: "none" as const,
    ...overrides,
  };
  return Object.freeze({ ...prompt, textHash: promptTextHash(prompt) });
};

// A caller's entry in the form the README asks for: the hash is a literal in the source,
// recorded when the text was written.
export const callerList: Prompt = Object.freeze({
  id: "caller_list",
  version: "1",
  instructions: "You list what one message says. It is given below, in a block.",
  slots: ["message"],
  outputSchemaId: "InterpreterOutput",
  outputSchema: InterpreterOutput,
  tools: "none",
  textHash: "7f28953497f8b27a23e9bad2efb28da6511f337cb442968da14b22548af09d1b",
});
