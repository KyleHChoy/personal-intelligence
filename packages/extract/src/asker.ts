import { EvidenceId, TrustGroupId } from "@intelligence/contracts";
import {
  isCoded,
  type KeyedCallStore,
  type PersonalLogger,
  type PersonalPipelineStore,
} from "@intelligence/contracts/personal";
import { byText, THE_OWNER } from "@intelligence/personal-core";
import {
  BudgetReached,
  completeKeyedWithReplay,
  type ModelClient,
  ModelOutputRejected,
  type Prompt,
} from "@intelligence/personal-models";

// One model call that is not about one stored item: a judge's case, a pair, a day. Asked once per
// key through the keyed replay, its items noted as exposed to the model before the request leaves
// (a replay sends nothing, so notes nothing). A refused output is saved and replays as a refusal;
// a reached budget asked nothing; an outage is logged by its code alone.

// A store's view of its saved calls: `lastId` reads back the id of the call this view saved.
type SavedCalls = { store: KeyedCallStore; lastId(): Promise<string | null> };

// What is asked: the prompt's one slot, the key's subject, the items the input rests on (noted as
// exposed, and saved with the call, sorted and once each) and the call's compartments.
type AskCall = { slot: string; subject: string; refs: readonly string[]; compartments: readonly string[] };

// The parsed answer and its saved call; a saved refusal and the raw output refused; or why there is
// none.
type Answer<T> = { output: T; savedCall: string } | { rejected: string; rawOutput: unknown } | "budget" | "unavailable";

type Ask<T> = (call: AskCall) => Promise<Answer<T>>;

const TRUST_GROUP = TrustGroupId.parse("personal-openrouter");

export function asker<T>(deps: {
  point: { id: string; version: number };
  // A prompt of one slot, which takes the call's `slot`.
  prompt: Prompt;
  schema: { parse(value: unknown): T };
  store: { calls(): SavedCalls };
  exposure: Pick<PersonalPipelineStore, "noteExposure">;
  client: { model: ModelClient; modelId: string };
  log: PersonalLogger;
  // The event an outage is logged under.
  failed: { event: string };
}): Ask<T> {
  const { point, prompt, schema, store, exposure, client, log, failed } = deps;
  const [slotName, ...others] = prompt.slots;
  if (slotName === undefined || others.length > 0) throw new Error(`asker: ${prompt.id} must take one slot`);
  return async ({ slot, subject, refs, compartments }) => {
    const shown = [...new Set(refs)].sort(byText);
    const showing = shown.map((id) => EvidenceId.parse(id));
    const noting: ModelClient = {
      ...client.model,
      complete: async (request) => {
        await exposure.noteExposure(client.modelId, request.promptId, showing);
        return client.model.complete(request);
      },
    };
    const calls = store.calls();
    try {
      const response = await completeKeyedWithReplay(
        noting,
        calls.store,
        {
          promptId: prompt.id,
          promptVersion: prompt.version,
          data: { [slotName]: slot },
          label: { compartments: [...compartments], readers: [THE_OWNER] },
          trustGroup: TRUST_GROUP,
        },
        { point: point.id, version: point.version, subject, refs: shown, modelId: client.modelId },
        [...compartments],
        [prompt],
      );
      return { output: schema.parse(response.output), savedCall: (await calls.lastId()) ?? "" };
    } catch (error) {
      if (error instanceof BudgetReached) return "budget";
      const saved = await calls.lastId();
      if (saved !== null)
        return { rejected: saved, rawOutput: error instanceof ModelOutputRejected ? error.rawOutput : undefined };
      const code = isCoded(error) ? error.code : undefined;
      if (code === undefined) throw error;
      log.warn({ ...failed, code });
      return "unavailable";
    }
  };
}
