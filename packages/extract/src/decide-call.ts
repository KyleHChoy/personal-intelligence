import type { Parsed, ReadItem } from "@intelligence/personal-core";
import { completeWithReplay, ModelClientError, ModelOutputRejected, type Prompt } from "@intelligence/personal-models";
import { ExtractFailure } from "./call-failure.ts";
import type { ExtractDeps } from "./config.ts";
import { callRequest, passesThrough, rendered } from "./interpret.ts";

// One decide-model call about one stored item, for the recovery and record screens: the call key the item
// screen (`jev_screen`) uses, under the prompt given, made once per key through the shared replay and the
// item's call store under the decide model's model id, and replayed after. It answers the validated output, or
// "rejected" for an answer that was not one; an outage, a refusal and a reached budget pass through; any other
// client error fails the item `interpret_failed`, as the item screen does. The hash of a decide-model prompt
// rendered over these slots: what a saved call's key holds, and what `pi ladder review` re-renders to check
// that the owner is asked about the input the model saw.
export const decideInputHash = (prompt: Prompt, data: Record<string, string>): string =>
  rendered(prompt, data, [prompt]).inputHash;

export async function askDecideModel(
  prompt: Prompt,
  data: Record<string, string>,
  parsed: Parsed,
  read: ReadItem,
  deps: Pick<ExtractDeps, "store"> & { decideModel: NonNullable<ExtractDeps["decideModel"]> },
): Promise<unknown> {
  const registry = [prompt];
  const { request, keys } = callRequest(prompt, data, { parsed, read }, decideInputHash(prompt, data));
  try {
    const response = await completeWithReplay(
      deps.decideModel.model,
      deps.store.calls(deps.decideModel.modelId),
      request,
      keys,
      registry,
    );
    const answer = prompt.outputSchema.safeParse(response.output);
    return answer.success ? answer.data : "rejected";
  } catch (error) {
    if (passesThrough(error)) throw error;
    if (error instanceof ModelOutputRejected) return "rejected";
    if (error instanceof ModelClientError) throw new ExtractFailure("interpret_failed");
    throw error;
  }
}
