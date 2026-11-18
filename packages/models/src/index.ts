// The model port to OpenRouter.

export type { KeyedCallKey, KeyedCallRecord, KeyedCallStore } from "@intelligence/contracts/personal";
export {
  ANTHROPIC_EFFORTS,
  type AnthropicEffort,
  type AnthropicExtractOptions,
  createAnthropicExtractClient,
  isAnthropicEffort,
} from "./anthropic-extract.ts";
export { anthropicKey, anthropicModelId, anthropicPriced, createAnthropicTurnModel } from "./anthropic-turn.ts";
export { type Budget, BudgetReached, type BudgetReason, microUsdOf, withBudget } from "./budget.ts";
export { checkCompletion, checkReply } from "./client/checks.ts";
export type { ModelClient } from "./client/client.ts";
export { ModelClientError, ModelOutputRejected } from "./client/errors.ts";
export { lookupPrompt, type Prompt, promptTextHash, renderPrompt, validateOutput } from "./client/prompts.ts";
export { completeWithReplay } from "./client/replay.ts";
export type { OpenRouterOptions } from "./completion.ts";
export {
  createDecideClient,
  DECIDE_ASSUMED_CALL_MICRO_USD,
  DECIDE_MODELS,
  type DecideOptions,
} from "./decide-model.ts";
export {
  checkSpendCap,
  type KeyLimit,
  type KeyReset,
  keyEndpointOf,
  keyLimit,
  type SpendCap,
  type SpendCapCode,
  spendCapEvent,
} from "./key-limit.ts";
export { completeKeyedWithReplay, type KeyedCall } from "./keyed-replay.ts";
export { createOpenRouterClient } from "./openrouter.ts";
export { createPseudonymiser, type KnownIdentities, type Pseudonymiser } from "./pseudonymise.ts";
export { HttpStatusError } from "./retry.ts";
export {
  type CheckedToolCall,
  checkToolCalls,
  createOpenRouterTurnModel,
  isReasoningEffort,
  modelFailureCode,
  REASONING_EFFORTS,
  type ReasoningEffort,
  type ServerTools,
  type TurnModel,
  type TurnModelOptions,
  TurnTimedOutError,
} from "./turn.ts";
export { ASSUMED_CALL_MICRO_USD } from "./usage.ts";
