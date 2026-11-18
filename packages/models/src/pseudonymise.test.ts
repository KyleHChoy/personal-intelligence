import type { TurnRequest } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { completeWithReplay } from "./client/replay.ts";
import { createOpenRouterClient } from "./openrouter.ts";
import { createPseudonymiser, type KnownIdentities } from "./pseudonymise.ts";
import { answer, KEY, keys, MODEL, memoryStore, REGISTRY, request } from "./test-support/support.ts";
import { createOpenRouterTurnModel } from "./turn.ts";

// Every test runs on a fake fetch that captures what would leave the box. The people are
// invented, on reserved domains and fictional numbers.

const BOX_KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);
const KNOWN: KnownIdentities = {
  names: ["Mira Okafor", "Bryn"],
  addresses: ["mira@example.com"],
  phones: ["+1 555 010 2233"],
  handles: ["@bryn_calder"],
};
const SECRETS = ["Mira Okafor", "Okafor", "mira@example.com", "555 010 2233", "bryn_calder", "Bryn"];
const pseudonymiser = (known: KnownIdentities = KNOWN, key = BOX_KEY) =>
  createPseudonymiser({ key: async () => key, known });

const MESSAGE = {
  from: "Mira Okafor <mira@example.com>",
  to: ["owner@example.org"],
  segments: [
    {
      span: "body:0",
      text: "Bryn, call me on +1 555 010 2233 or ping @bryn_calder. Mira Okafor, 2026-03-04.",
    },
  ],
};

// A fetch that answers as a model that copied the first person token it was shown into its claim,
// and records each body it was sent.
const echoingFetch = () => {
  const bodies: string[] = [];
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body);
    bodies.push(body);
    const token = /Email_[0-9a-f]{8}@pseudonym\.invalid/.exec(body)?.[0] ?? "none";
    const claim = {
      type: "commitment",
      subject: { key: { kind: "address", value: token }, observedAt: "2026-03-04T10:00:00Z" },
      fields: { what: "I will send the report." },
      statementKind: "stated_fact",
      basis: "explicit_self",
      span: "body:0",
    };
    return new Response(JSON.stringify(answer({ content: JSON.stringify({ claims: [claim], narrowing: "none" }) })));
  }) as typeof globalThis.fetch;
  return { fetch, bodies };
};

const extractClient = (fetch: typeof globalThis.fetch, given = pseudonymiser()) =>
  createOpenRouterClient({
    apiKey: KEY,
    model: MODEL,
    registry: REGISTRY,
    onUsage: async () => {},
    deps: { fetch, sleep: async () => {}, random: () => 0, pseudonymiser: given },
  });

describe("createPseudonymiser", () => {
  it("sends no known name, address, phone or handle through a real client", async () => {
    const { fetch, bodies } = echoingFetch();
    await extractClient(fetch).complete(request({ data: { message: JSON.stringify(MESSAGE) } }));
    expect(bodies).toHaveLength(1);
    const [sent = ""] = bodies;
    for (const secret of SECRETS) expect(sent).not.toContain(secret);
    expect(sent).toMatch(/Person_[0-9a-f]{8}/);
    // What is not an identity stays: the date and the words around the names.
    expect(sent).toContain("2026-03-04");
    expect(sent).toContain("call me on");
  });

  it("restores the originals in the model's output before the client reads it", async () => {
    const { fetch } = echoingFetch();
    const response = await extractClient(fetch).complete(request({ data: { message: JSON.stringify(MESSAGE) } }));
    const [claim] = (response.output as { claims: { subject: { key: { value: string } } }[] }).claims;
    expect(claim?.subject.key.value).toBe("mira@example.com");
  });

  it("saves the restored output under the plain input's key, so a replay never holds a token", async () => {
    const { fetch, bodies } = echoingFetch();
    const { store, records } = memoryStore();
    const asked = request({ data: { message: JSON.stringify(MESSAGE) } });
    await completeWithReplay(extractClient(fetch), store, asked, keys, REGISTRY);
    const again = await completeWithReplay(extractClient(fetch), store, asked, keys, REGISTRY);
    expect(bodies).toHaveLength(1);
    expect(again.modelId).toBe("replay");
    expect(records[0]?.rawOutput).toContain("mira@example.com");
    expect(records[0]?.rawOutput).not.toContain("pseudonym.invalid");
  });

  it("pseudonymises a name inside a tool result's { untrusted } value, and restores a tool call's arguments", async () => {
    const bodies: string[] = [];
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      bodies.push(body);
      const token = /Person_[0-9a-f]{8}/.exec(body)?.[0] ?? "none";
      const call = {
        id: "call-2",
        type: "function",
        function: { name: "read_message", arguments: JSON.stringify({ about: token }) },
      };
      return new Response(
        JSON.stringify({
          id: "gen-1",
          model: MODEL,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: null, tool_calls: [call] },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13, cost: 0.0001 },
        }),
      );
    }) as typeof globalThis.fetch;
    const turn: TurnRequest = {
      system: "You look over one person's mail.",
      messages: [
        { role: "user", text: "Look at the latest message." },
        { role: "assistant", text: null, toolCalls: [{ id: "call-1", name: "read_message", arguments: {} }] },
        { role: "tool", id: "call-1", result: JSON.stringify({ body: { untrusted: "Mira Okafor asks to meet." } }) },
      ],
      tools: [{ name: "read_message", description: "Read one message.", inputSchema: { type: "object" } }],
      maxOutputTokens: 2000,
    };
    const model = createOpenRouterTurnModel({
      apiKey: KEY,
      model: MODEL,
      deps: { fetch, sleep: async () => {}, pseudonymiser: pseudonymiser() },
    });
    const reply = await model.turn(turn);
    expect(bodies[0]).not.toContain("Mira Okafor");
    expect(bodies[0]).toContain("asks to meet");
    expect(reply.toolCalls[0]?.arguments).toEqual({ about: "Mira Okafor" });
  });

  it("gives the same token in every call and every instance under one key, and another under another key", async () => {
    const text = "Mira Okafor wrote from mira@example.com.";
    const one = pseudonymiser();
    const first = await one.outgoing(text);
    expect(await one.outgoing(text)).toBe(first);
    expect(await pseudonymiser().outgoing(text)).toBe(first);
    expect(await pseudonymiser(KNOWN, OTHER_KEY).outgoing(text)).not.toBe(first);
    // Case does not change who a name is.
    const token = /Person_[0-9a-f]{8}/.exec(first)?.[0];
    expect(await one.outgoing("MIRA OKAFOR said so")).toContain(token);
  });

  it("finds an unknown address, phone and display name by their patterns, and leaves dates and ids", async () => {
    const one = pseudonymiser({});
    const sent = await one.outgoing(
      '{"from":"Tamsin Vale &lt;tamsin@example.net&gt;","text":"Call Tamsin Vale at (555) 010-4477 on 2026-03-04, order 1763251200, ref 12-345."}',
    );
    for (const secret of ["tamsin@example.net", "Tamsin Vale", "010-4477"]) expect(sent).not.toContain(secret);
    for (const kept of ["2026-03-04", "1763251200", "12-345"]) expect(sent).toContain(kept);
    expect(one.incoming(sent)).toBe(
      '{"from":"Tamsin Vale &lt;tamsin@example.net&gt;","text":"Call Tamsin Vale at (555) 010-4477 on 2026-03-04, order 1763251200, ref 12-345."}',
    );
  });

  it("matches a one-word name only with its capital, and never inside another word", async () => {
    const sent = await pseudonymiser({ names: ["Will"] }).outgoing("Will said he will go to Willow Street.");
    expect(sent).toMatch(/^Person_[0-9a-f]{8} said he will go to Willow Street\.$/);
  });

  it("reads a caller's known identities once, at the first request, and not before", async () => {
    let reads = 0;
    const one = createPseudonymiser({
      key: async () => BOX_KEY,
      known: async () => {
        reads += 1;
        return { names: ["Tamsin Vale"] };
      },
    });
    expect(reads).toBe(0);
    expect(await one.outgoing("Tamsin Vale says hello.")).toMatch(/^Person_[0-9a-f]{8} says hello\.$/);
    await one.outgoing("Tamsin Vale again.");
    expect(reads).toBe(1);
  });

  it("leaves a token it never issued, and any text without tokens, as it is", async () => {
    const one = pseudonymiser();
    expect(one.incoming("Person_0123abcd met nobody.")).toBe("Person_0123abcd met nobody.");
  });
});
