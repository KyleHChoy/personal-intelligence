import type { FailureCode } from "@intelligence/contracts";

// Names the stage that failed and nothing else. It never carries a cause, a message from a
// parser or a model, or any evidence text.
export class PipelineError extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode) {
    super(code);
    this.name = "PipelineError";
    this.code = code;
  }
}
