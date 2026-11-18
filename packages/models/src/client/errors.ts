import type { GatewayRefusal } from "@intelligence/contracts";

export type ModelClientErrorCode =
  | "wrong_trust_group"
  | "no_scope"
  | "wrong_gateway"
  | "unlabelled"
  | "bad_request"
  | "unknown_prompt"
  | "altered_prompt"
  | "bad_slots"
  | "tools_not_allowed"
  | "wrong_mode"
  | "bad_purpose"
  | "bad_key"
  | "bad_record"
  | "no_record"
  | "output_rejected"
  | "refused"
  | "unavailable";

// Carries a code and never a prompt, a response or any evidence text. A failed model call ends
// as `unavailable`, and the caller's queue lease retries the item.
export class ModelClientError extends Error {
  readonly code: ModelClientErrorCode;
  // The gateway's own code, when it refused the call.
  readonly reason: GatewayRefusal["code"] | undefined;

  constructor(code: ModelClientErrorCode, reason?: GatewayRefusal["code"]) {
    super(code);
    this.name = "ModelClientError";
    this.code = code;
    this.reason = reason;
  }
}

// An output that broke the prompt's closed schema. It carries the raw output so the caller can
// still save it. The message stays a bare code, and the raw text is not enumerable, so printing,
// inspecting or serialising the error never shows it.
export class ModelOutputRejected extends ModelClientError {
  declare readonly rawOutput: string;

  constructor(rawOutput: string) {
    super("output_rejected");
    this.name = "ModelOutputRejected";
    Object.defineProperty(this, "rawOutput", { value: rawOutput, enumerable: false });
  }
}
