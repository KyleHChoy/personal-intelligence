import type { WebWriteName } from "@intelligence/contracts/personal";
import { post, said } from "./api.ts";
import { useToast } from "./toast.tsx";

// One owner decision, said in the toast with Undo where the write has one. `useWriteWithToast(name, undo?)` gives a function that posts `name` with the body and, when it is
// written, shows `words` in the toast. `undo` names the write that undoes it, from what was sent and what the write answered, or null where there is none; Undo in the toast
// posts it, and `onUndone` then puts the page back. A refusal is answered, never toasted: the caller shows it under the decision.

export type Sent = Record<string, unknown>;
export type UndoWrite = { name: WebWriteName; body: Sent; words?: string };
export type Wrote = { ok: true; result: unknown } | { ok: false; code: string };
export type Write = (body: Sent, words: string, onUndone?: () => void) => Promise<Wrote>;

// A write that says itself in the toast: post `name`; written, toast `words` with Undo where `undo`
// gives the write that undoes it. A write with words of its own calls api.ts's `write` or `post`,
// which give every request its id. The hook below and People's `useWrite` use it.
export async function postWithToast(
  toast: ReturnType<typeof useToast>,
  name: WebWriteName,
  body: Sent,
  words: string,
  undo?: (sent: Sent, result: unknown) => UndoWrite | null,
  onUndone?: () => void,
): Promise<Wrote> {
  const sent = { ...body };
  const answer = await post<{ result?: unknown }>(name, sent);
  if (!answer.ok) return { ok: false, code: answer.code };
  const result = answer.value.result;
  const back = undo?.(body, result) ?? null;
  toast(
    words,
    back === null
      ? undefined
      : () =>
          void post(back.name, { ...back.body }).then((undone) => {
            if (!undone.ok) return toast(`Not undone: ${said(undone.code)}`);
            toast(back.words ?? "Undone.");
            onUndone?.();
          }),
  );
  return { ok: true, result };
}

export function useWriteWithToast(name: WebWriteName, undo?: (sent: Sent, result: unknown) => UndoWrite | null): Write {
  const toast = useToast();
  // A refusal is said at once, so no caller can let a refused write pass for a done one.
  return async (body, words, onUndone) => {
    const done = await postWithToast(toast, name, body, words, undo, onUndone);
    if (!done.ok) toast(`Not done: ${said(done.code)}`);
    return done;
  };
}
