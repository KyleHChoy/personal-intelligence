// The row pieces every room shares: a kept read, a person's name, and asking an agent.

import type { OwnerTaskRef, WebReadArgs, WebReadName, WebReadResult } from "@intelligence/contracts/personal";
import { type Loaded, said } from "./api.ts";
import { useKept } from "./kept.ts";
import { capital, UNNAMED } from "./words.ts";

// A read of the page's kept layer (kept.ts), again when `reload` is called. A read of new arguments is
// the owner's action (the `X-PI-Action` header); a re-read after a write is the page's own, and keeps
// what is shown until its answer comes, so open rows stay open. What it read is kept, so a room shown
// again, another room or another row starts from it with no read; `fresh` reads it each time it is
// shown.
export function useRead<N extends WebReadName>(
  name: N,
  args: WebReadArgs<N> = {},
  fresh = false,
): [Loaded<WebReadResult<N>>, () => void] {
  return useKept(name, args, { navigate: true, keepIt: !fresh });
}

// A refusal under the decision it refused.
export const Refused = ({ code }: { code: string | null }) =>
  code === null ? null : (
    <p className="empty" role="alert">
      {said(code)}
    </p>
  );

export const whoName = (who: { name: { untrusted: string } | null; address: { untrusted: string } | null }): string =>
  who.name?.untrusted ?? who.address?.untrusted ?? capital(UNNAMED);

// ---------- Asking an agent ----------

// What the owner asks an agent about, from a row: its refs, the kind of task, and the button's
// words. `what` is the row's title, shown on the sheet so the owner sees what they ask about (never
// sent: a claim's words never go into an agent's brief); `note` starts the owner's words.
export type Ask = { about: OwnerTaskRef[]; kind: string; what?: string; note?: string };
// The roles that suit a kind of task, best first, by the words a role's name holds.
const ROLE_WORDS: Readonly<Record<string, readonly string[]>> = {
  research: ["research"],
  investigate: ["research", "investig"],
  meeting_prep: ["chief", "prep", "assist"],
  goal_step: ["chief", "plan", "coach"],
  life_admin: ["chief", "admin", "assist"],
};
// The role a task of `kind` goes to: the first of the owner's agents' roles that suits it, else the first.
export const roleFor = (kind: string, roles: readonly string[]): string => {
  for (const word of ROLE_WORDS[kind] ?? [kind]) {
    const found = roles.find((role) => role.includes(word));
    if (found !== undefined) return found;
  }
  return roles[0] ?? "";
};
