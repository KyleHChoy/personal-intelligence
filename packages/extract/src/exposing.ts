import type { PersonalPipelineStore } from "@intelligence/contracts/personal";
import { type ModelClient, ModelClientError } from "@intelligence/personal-models";

// The model route of the vendor exposure record: before a request leaves, the item whose text it
// holds is noted under the configured model id and the prompt's id, in a statement the store
// commits on a connection of its own. Only then is the vendor client called. It is the innermost
// wrapper, around the vendor client itself: inside `withBudget` and `noting`, so a call the budget
// refuses is not noted, and inside `completeWithReplay`, so a replay is not noted. A call that
// times out after the note stays noted: the record errs toward "may have been sent".
//
// The evidence id is the request's call key's: the item for an extraction or a decide-model screen, the
// agent record's evidence row for a finding. Every pipeline request has one, since the
// replay refuses a request without it; one without it is refused here too, never sent. A note
// that fails is `unavailable`, so the item is deferred as for a vendor that is away, and no
// request is made. An embedding names no item and is refused.

export function exposing(
  client: ModelClient,
  store: Pick<PersonalPipelineStore, "noteExposure">,
  modelId: string,
): ModelClient {
  return {
    async complete(request) {
      const evidenceId = request.callKey?.evidenceId;
      if (evidenceId === undefined) throw new ModelClientError("bad_key");
      try {
        await store.noteExposure(modelId, request.promptId, [evidenceId]);
      } catch {
        throw new ModelClientError("unavailable");
      }
      return client.complete(request);
    },
    embed: () => Promise.reject(new ModelClientError("bad_purpose")),
  };
}
