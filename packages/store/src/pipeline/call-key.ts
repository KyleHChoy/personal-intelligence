// The saved-call key's versions. A call saved before the model was part of the key is version 1:
// the item, its revision, the prompt, its version and the input, with the model recorded beside it
// and deciding nothing. A call saved now is version 2: the same and the model's id. No stored row
// is rewritten: a version 1 call is read by its own key.

export const CALL_KEY_VERSION = 2;

export type SavedCall = { id: string; key_version: number; model_id: string };

// Which stored call answers a key for a model: the model's own version 2 call, else a version 1
// call, whatever model made it. Never another model's version 2 call: that model's answer is not
// this one's. `rows` are the calls of the key's other five parts that a retry has not superseded.
export function replayedCall<Row extends SavedCall>(rows: readonly Row[], modelId: string): Row | undefined {
  return (
    rows.find((row) => row.key_version === CALL_KEY_VERSION && row.model_id === modelId) ??
    rows.find((row) => row.key_version === 1)
  );
}
