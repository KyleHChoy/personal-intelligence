import type { PipelineCode } from "@intelligence/contracts/personal";

export { sha256 } from "@intelligence/personal-core";

// Why interpreting an item ended it: a code, never text. A model that is unavailable or refused,
// and a budget that is reached, are not this: they pass through for the run to act on.
// `shape`, for an answer the schema refused, its shape alone (rejectionShape).
export class ExtractFailure extends Error {
  readonly code: PipelineCode;
  readonly shape: Readonly<Record<string, number>> | undefined;
  constructor(code: PipelineCode, shape?: Readonly<Record<string, number>>) {
    super(code);
    this.name = "ExtractFailure";
    this.code = code;
    this.shape = shape;
  }
}
