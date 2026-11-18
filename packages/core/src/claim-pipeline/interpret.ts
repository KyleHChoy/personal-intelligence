import { InterpreterOutput, type Sha256 } from "@intelligence/contracts";
import { PipelineError } from "./errors.ts";

// Anything else, a label, a reader, a destination or a grant included, rejects the whole output.
// Checked here whatever the client already checked.
export function checkOutput(output: unknown): InterpreterOutput {
  const parsed = InterpreterOutput.safeParse(output);
  if (!parsed.success) throw new PipelineError("interpret_failed");
  return parsed.data;
}

// What the interpreter proposed, and the hash of the prompt it was shown: the hash its call is
// saved under.
export interface Interpreted {
  output: InterpreterOutput;
  inputHash: Sha256;
}
