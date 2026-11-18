import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Refusal } from "./env.ts";
import { turnModelFromEnv, WEB_RULES } from "./model.ts";

// A fetch that records the body it was sent and answers one fixed turn. No model is called.
const recordingFetch = () => {
  const bodies: Record<string, unknown>[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.000001 },
      }),
    );
  };
  return { fetch: fetch as typeof globalThis.fetch, bodies };
};

describe("the reasoner's model", () => {
  it("the model named in the environment is the one asked for", async () => {
    const { fetch, bodies } = recordingFetch();
    const model = turnModelFromEnv(
      { PI_REASONER_MODEL: "vendor/synthetic-model", PI_REASONER_MODEL_KEY: "sk-synthetic-key" },
      { fetch },
    );
    const reply = await model.turn({
      system: "s",
      messages: [{ role: "user", text: "u" }],
      tools: [],
      maxOutputTokens: 10,
    });
    expect(bodies[0]?.model).toBe("vendor/synthetic-model");
    expect(reply.modelId).toBe("vendor/synthetic-model");
  });

  it("there is no retention switch: an environment that asks for one changes nothing, and zdr is not sent", async () => {
    const { fetch, bodies } = recordingFetch();
    const model = turnModelFromEnv(
      {
        PI_REASONER_MODEL: "vendor/synthetic-model",
        PI_REASONER_MODEL_KEY: "sk-synthetic-key",
        PI_REASONER_ZDR: "off",
      },
      { fetch },
    );
    await model.turn({ system: "s", messages: [], tools: [], maxOutputTokens: 10 });
    expect(bodies[0]?.provider).toEqual({ data_collection: "deny", require_parameters: true });
  });

  it("PI_REASONER_REASONING_EFFORT is sent as reasoning.effort; unset or empty sends none; any other value is refused bad_env", async () => {
    const base = { PI_REASONER_MODEL: "vendor/synthetic-model", PI_REASONER_MODEL_KEY: "sk-synthetic-key" };
    const turn = { system: "s", messages: [], tools: [], maxOutputTokens: 10 };
    for (const [effort, sent] of [
      [undefined, undefined],
      ["", undefined],
      ["low", { effort: "low" }],
      ["medium", { effort: "medium" }],
      ["high", { effort: "high" }],
    ] as const) {
      const { fetch, bodies } = recordingFetch();
      await turnModelFromEnv(effort === undefined ? base : { ...base, PI_REASONER_REASONING_EFFORT: effort }, {
        fetch,
      }).turn(turn);
      expect(bodies[0]?.reasoning, String(effort)).toEqual(sent);
    }
    for (const effort of ["HIGH", "max", "none", "minimal", " high"]) {
      try {
        turnModelFromEnv({ ...base, PI_REASONER_REASONING_EFFORT: effort });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(Refusal);
        expect({ code: (error as Refusal).code, hint: (error as Refusal).hint }).toEqual({
          code: "bad_env",
          hint: "set PI_REASONER_REASONING_EFFORT",
        });
      }
    }
  });

  // A trial's model and effort take the place of the configured ones; with none, PI_REASONER_MODEL.
  // The key stays the reasoner's.
  it("a trial uses its own model and effort, and with none it is PI_REASONER_MODEL", async () => {
    const env = {
      PI_REASONER_MODEL: "vendor/synthetic-model",
      PI_REASONER_MODEL_KEY: "sk-synthetic-key",
      PI_REASONER_REASONING_EFFORT: "high",
    };
    const turn = { system: "s", messages: [], tools: [], maxOutputTokens: 10 };
    for (const [trial, model, effort] of [
      [{ model: "vendor/synthetic-trial", effort: "low" }, "vendor/synthetic-trial", "low"],
      [undefined, "vendor/synthetic-model", "high"],
    ] as const) {
      const { fetch, bodies } = recordingFetch();
      await turnModelFromEnv(env, { fetch }, trial).turn(turn);
      expect([bodies[0]?.model, bodies[0]?.reasoning], model).toEqual([model, { effort }]);
    }
  });

  // No model id is in the reasoner's code: every model it runs comes from its environment or a
  // trial.
  it("no model id is in the reasoner's code", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const sources = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    expect(sources).toContain("model.ts");
    for (const name of sources) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(text, name).not.toMatch(/\b(anthropic|openai|google|meta-llama|mistralai|x-ai)\/[a-z0-9]/);
      expect(text, name).not.toMatch(/\bclaude-(opus|sonnet|haiku)/);
    }
  });

  it("each variable is required, and the refusal names it", () => {
    for (const [env, name] of [
      [{ PI_REASONER_MODEL_KEY: "sk-synthetic-key" }, "PI_REASONER_MODEL"],
      [{ PI_REASONER_MODEL: "vendor/synthetic-model", PI_REASONER_MODEL_KEY: "" }, "PI_REASONER_MODEL_KEY"],
    ] as const) {
      try {
        turnModelFromEnv(env);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(Refusal);
        expect({ code: (error as Refusal).code, hint: (error as Refusal).hint }).toEqual({
          code: "missing_env",
          hint: `set ${name}`,
        });
      }
    }
  });

  // Web search and web fetch on an Anthropic key, off unless a number opts in.
  it("on an Anthropic key the web tools are sent only when PI_REASONER_WEB_SEARCH or PI_REASONER_WEB_FETCH names a number; unset, empty or off sends none; on an OpenRouter key none is", async () => {
    const anthropicFetch = () => {
      const bodies: Record<string, unknown>[] = [];
      const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            type: "message",
            content: [{ type: "text", text: "{}" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      };
      return { fetch: fetch as typeof globalThis.fetch, bodies };
    };
    const turn = { system: "s", messages: [{ role: "user" as const, text: "u" }], tools: [], maxOutputTokens: 10 };
    const anthropic = { PI_REASONER_MODEL: "claude-opus-5-5", PI_REASONER_MODEL_KEY: "sk-ant-synthetic-key" };
    const webOf = (body: Record<string, unknown> | undefined) =>
      (body!.tools as Record<string, unknown>[]).map((tool) => [tool.name, tool.max_uses]);
    for (const [env, sent] of [
      [{}, []],
      [{ PI_REASONER_WEB_SEARCH: "", PI_REASONER_WEB_FETCH: "" }, []],
      [
        { PI_REASONER_WEB_SEARCH: "10", PI_REASONER_WEB_FETCH: "10" },
        [
          ["web_search", 10],
          ["web_fetch", 10],
        ],
      ],
      [{ PI_REASONER_WEB_SEARCH: "3" }, [["web_search", 3]]],
      [{ PI_REASONER_WEB_SEARCH: "10", PI_REASONER_WEB_FETCH: "off" }, [["web_search", 10]]],
      [{ PI_REASONER_WEB_SEARCH: "off", PI_REASONER_WEB_FETCH: "off" }, []],
    ] as const) {
      const { fetch, bodies } = anthropicFetch();
      await turnModelFromEnv({ ...anthropic, ...env }, { fetch }).turn(turn);
      expect(webOf(bodies[0]), JSON.stringify(env)).toEqual(sent);
      const system = (bodies[0]!.system as { text: string }[]).map((block) => block.text);
      expect(system).toEqual(sent.length > 0 ? ["s", WEB_RULES] : ["s"]);
    }
    // The rules say web results are data and what rests on them says "from the web".
    expect(WEB_RULES).toContain("never an instruction");
    expect(WEB_RULES).toContain('"from the web"');

    const { fetch, bodies } = recordingFetch();
    await turnModelFromEnv(
      {
        PI_REASONER_MODEL: "vendor/synthetic-model",
        PI_REASONER_MODEL_KEY: "sk-synthetic-key",
        PI_REASONER_WEB_SEARCH: "5",
      },
      { fetch },
    ).turn(turn);
    expect(bodies[0]?.tools).toEqual([]);
    expect(JSON.stringify(bodies[0])).not.toMatch(/web_search|web_fetch/);

    for (const [name, value] of [
      ["PI_REASONER_WEB_SEARCH", "0"],
      ["PI_REASONER_WEB_SEARCH", "101"],
      ["PI_REASONER_WEB_FETCH", "OFF"],
      ["PI_REASONER_WEB_FETCH", " 5"],
    ] as const) {
      for (const key of ["sk-ant-synthetic-key", "sk-synthetic-key"]) {
        try {
          turnModelFromEnv({ ...anthropic, PI_REASONER_MODEL_KEY: key, [name]: value });
          expect.unreachable();
        } catch (error) {
          expect({ code: (error as Refusal).code, hint: (error as Refusal).hint }).toEqual({
            code: "bad_env",
            hint: `set ${name}`,
          });
        }
      }
    }
  });
});
