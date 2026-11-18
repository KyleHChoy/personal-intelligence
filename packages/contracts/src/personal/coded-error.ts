// An error that carries one fixed code and nothing else: a refusal, or a store's own failure. Its
// message is its code unless a caller gives another; faultOf reads only the code. An error that
// carries more than a code keeps its own class.
export class CodedError<C extends string = string> extends Error {
  readonly code: C;
  constructor(code: C, options?: ErrorOptions & { message?: string }) {
    super(options?.message ?? code, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
  }
}

// Whether a thrown value carries a string code (any error that does: a CodedError, a driver's, a
// system call's ENOENT), and, given one, that code.
export function isCoded<C extends string>(error: unknown, code?: C): error is { code: C } {
  if (typeof error !== "object" || error === null) return false;
  const own = (error as { code?: unknown }).code;
  return typeof own === "string" && (code === undefined || own === code);
}
