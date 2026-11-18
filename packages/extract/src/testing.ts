// The extraction package's test entry, @intelligence/personal-extract/testing. Everything it
// exports lives in src/test-support/, or is an evaluation set under src/eval/ that `pi extract
// check` scores and so ships in the package itself; the package root exports no set.

export { openEvalDocument } from "./eval/eval-documents.ts";
export { EVAL_DOCUMENTS, EVAL_MODIFIED } from "./eval/eval-set.ts";
export * from "./test-support/memory-store.ts";
