import type { ClaimRefusal, PersonalToolError, TurnReply, TurnRequest } from "@intelligence/contracts/personal";

// The reasoner's two ports, types only.

// The agent API child, pi mcp: its tools/list and tools/call. A call's refusal is a code; a
// client that has ended answers every later call `unavailable`.
export type AgentApi = {
  listTools(): Promise<{ name: string; description: string; inputSchema: unknown }[]>;
  call(
    name: string,
    args: unknown,
  ): Promise<{ ok: true; value: unknown } | { ok: false; code: PersonalToolError; refusal?: ClaimRefusal }>;
  close(): Promise<void>;
};

// The model, over the contracts' turn.ts. A turn that rejects, for any reason, is a model
// failure to the loop.
export type TurnModel = { turn(request: TurnRequest): Promise<TurnReply> };
