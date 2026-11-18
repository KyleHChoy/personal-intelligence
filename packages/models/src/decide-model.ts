import type { ModelRequest, ModelResponse } from "@intelligence/contracts";
import type { ModelClient } from "./client/client.ts";
import { ModelClientError, ModelOutputRejected } from "./client/errors.ts";
import type { OpenRouterOptions } from "./completion.ts";
import { isRecord, type Json, parseJson, plainCompletion, usageReporter } from "./completion.ts";
import { depsOf, HttpStatusError, type Sent, send } from "./retry.ts";
import { microUsd, usageOf } from "./usage.ts";

// The decide-model client: the shared ModelClient on OpenRouter's Decisions surface. One request of
// four keys, the prompt's questions asked of the slots as state, and an answer of one probability
// per question.

// The one model this client takes: thresholds are tuned to one version, so the alias is refused.
export const DECIDE_MODELS: readonly string[] = Object.freeze(["typesafe/jev-1.13"]);

// What a decide-model call whose cost is not known counts as: a full 32 000-token call is 1 344.
export const DECIDE_ASSUMED_CALL_MICRO_USD = 2_000;

// `onRetainedResend`, the owner's setting: when given, a request refused for want of a
// zero-retention endpoint is sent once more without that request, and it is called first, each
// time. Without it, that refusal is final, as any other.
export type DecideOptions = OpenRouterOptions & { onRetainedResend?: () => void };

const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const ATTEMPT_MS = 20_000;
// No option sends a request without these.
const PROVIDER = Object.freeze({ zdr: true, data_collection: "deny" });
const RETAINED = Object.freeze({ data_collection: "deny" });

// Whether an answer is OpenRouter's refusal for want of an endpoint that serves the model under
// zero retention. An assumption, unverified against OpenRouter: it answers 404 with a JSON body
// whose `error.message` names the data policy, as "No endpoints found matching your data policy
// (Zero data retention)". So only a 404 whose message matches is taken as this refusal; any other
// refusal is final. The body is read from a copy, and never kept.
const NO_ZDR_ENDPOINT = /data policy|zero data retention|zdr/i;
const refusedForRetention = async (response: Response): Promise<boolean> => {
  if (response.status !== 404) return false;
  try {
    const body = parseJson(await response.clone().text());
    const error = isRecord(body) ? body.error : undefined;
    const message = isRecord(error) ? error.message : undefined;
    return typeof message === "string" && NO_ZDR_ENDPOINT.test(message);
  } catch {
    return false;
  }
};

// The answers as the output, when there is exactly one probability for each question; else
// undefined, which is a rejection.
const outputOf = (answers: Json, ids: readonly string[]): Record<string, number> | undefined => {
  const given = Object.keys(answers);
  if (given.length !== ids.length || !ids.every((id) => Object.hasOwn(answers, id))) return undefined;
  const output: Record<string, number> = {};
  for (const id of ids) {
    const answer = answers[id];
    const p = isRecord(answer) && answer.type === "noul" ? answer.noul : undefined;
    if (typeof p !== "number" || !(p >= 0 && p <= 1)) return undefined;
    output[id] = p;
  }
  return output;
};

export function createDecideClient(options: DecideOptions): ModelClient {
  const { apiKey, model, registry } = options;
  if (!DECIDE_MODELS.includes(model)) throw new ModelClientError("bad_request");

  const deps = depsOf(options.deps);

  return {
    async complete(raw: ModelRequest): Promise<ModelResponse> {
      const { request, prompt } = plainCompletion(raw, registry);
      // The questions are the prompt's own text, never data; each slot is the JSON code made.
      const questions = parseJson(prompt.instructions);
      if (!isRecord(questions)) throw new ModelClientError("bad_request");
      const state: Json = {};
      for (const [slot, value] of Object.entries(request.data)) {
        const parsed = parseJson(value);
        if (parsed === undefined) throw new ModelClientError("bad_request");
        state[slot] = parsed;
      }

      const report = usageReporter(options.onUsage, request, model);

      // The last answer's status is a 404 only when it refused, since a 404 is not retried.
      let noZdrEndpoint = false;
      const watched = (async (input: string | URL | Request, init?: RequestInit) => {
        const response = await deps.fetch(input, init);
        noZdrEndpoint = await refusedForRetention(response);
        return response;
      }) as typeof fetch;
      const post = (provider: object): Promise<Sent> =>
        send(
          ENDPOINT,
          {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ model, state, questions, provider }),
            redirect: "error",
          },
          { ...deps, fetch: watched },
          ATTEMPT_MS,
        );
      let sent: Sent;
      try {
        sent = await post(PROVIDER);
      } catch (error) {
        // A refusal of that request is final.
        const { onRetainedResend } = options;
        if (
          onRetainedResend === undefined ||
          !(noZdrEndpoint && error instanceof HttpStatusError && error.status === "http_404")
        )
          throw error;
        onRetainedResend();
        sent = await post(RETAINED);
      }
      if (sent.kind === "timed_out") {
        await report("timed_out", DECIDE_ASSUMED_CALL_MICRO_USD);
        throw new ModelClientError("unavailable");
      }
      const answer = parseJson(sent.text);
      const fields = isRecord(answer) && isRecord(answer.usage) ? answer.usage : {};
      const { cost, ...tokens } = usageOf({
        prompt_tokens: fields.input_tokens,
        completion_tokens: fields.output_tokens,
        cost: fields.cost,
      });

      // No answers: unavailable, counted only when it carries a cost.
      const answers = isRecord(answer) ? answer.answers : undefined;
      if (answers === undefined) {
        if (cost !== undefined) await report("no_answer", microUsd(cost), tokens);
        throw new ModelClientError("unavailable");
      }

      const output = isRecord(answers) ? outputOf(answers, Object.keys(questions)) : undefined;
      const outcome = cost === undefined ? "cost_missing" : output !== undefined ? "ok" : "rejected";
      await report(outcome, cost === undefined ? DECIDE_ASSUMED_CALL_MICRO_USD : microUsd(cost), tokens);
      if (output === undefined) throw new ModelOutputRejected(JSON.stringify(answers));
      return {
        output,
        label: request.label,
        usage: { ...tokens, cost: cost ?? DECIDE_ASSUMED_CALL_MICRO_USD / 1_000_000 },
        modelId: model,
      };
    },
    async embed() {
      throw new ModelClientError("bad_purpose");
    },
  };
}
