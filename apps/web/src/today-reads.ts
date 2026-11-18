// The three small helpers every part of the Today room shares: the kept-layer read, the empty
// arguments and the unwrapping of untrusted text. A leaf, so the parts never import each other back.
import type { UntrustedString, WebReadArgs, WebReadName, WebReadResult } from "@intelligence/contracts/personal";
import type { Loaded } from "./api.ts";
import { useKept } from "./kept.ts";

export const NO_ARGS = {};

// One read of the page's kept layer (kept.ts): shown again with no read while it is kept, read
// again as the ledger moves it.
export function useKeptRead<N extends WebReadName>(
  name: N,
  args: WebReadArgs<N>,
  navigate = false,
): Loaded<WebReadResult<N>> {
  return useKept(name, args, { navigate })[0];
}

export const text = (value: UntrustedString | null | undefined): string | null => value?.untrusted ?? null;
