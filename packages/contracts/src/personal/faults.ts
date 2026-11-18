// How an edge of the agent-facing and command paths reads what was thrown at it. It expects a
// refusal or a store error with its own fixed code, a database driver's error, a socket's error
// and an abort or timeout; anything else is a bug. Only the error's own code, its SQLSTATE, its
// errno and its class name are read: never its message, its stack or its values.

type Fault = {
  // Whether the edge expects it; a bug is anything it does not.
  expected: boolean;
  // What the edge answers and logs: the error's own fixed code, `unavailable` for a driver's,
  // a socket's or an abort, and `bug` for anything else.
  code: string;
  // Which one, as a log code: its SQLSTATE (`sqlstate_40001`), its errno (`econnrefused`) or its
  // class name in snake case (`abort_error`, `type_error`). An error with its own code has one only
  // when its cause holds its driver's SQLSTATE: its code already says which.
  reason?: string;
};

// A log code: lower-case words joined by underscores, at most 64 characters.
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
// A system error's code, ECONNREFUSED or ETIMEDOUT; Node's own ERR_ codes, which a bug raises,
// hold an underscore and are never one.
const ERRNO = /^E[A-Z0-9]{2,30}$/;
const ABORTS: ReadonlySet<string> = new Set(["AbortError", "TimeoutError"]);

const snake = (code: string): string | null => (code.length <= 64 && SNAKE.test(code) ? code : null);
const sqlstateOf = (value: unknown): string | null =>
  typeof value === "string" && SQLSTATE.test(value) ? `sqlstate_${value.toLowerCase()}` : null;

// A thrown value's class as a log code: `TypeError` is `type_error`; a value that is not an object
// is `non_error`, and a class name that makes no code is `unknown`.
export function classCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "non_error";
  const name = (error as { constructor?: { name?: unknown } }).constructor?.name;
  if (typeof name !== "string" || name === "") return "unknown";
  const code = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return snake(code) ?? "unknown";
}

export function faultOf(error: unknown): Fault {
  const { code, name, cause } = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    name?: unknown;
    cause?: unknown;
  };
  if (typeof code === "string") {
    const own = snake(code);
    // A store error keeps its driver's SQLSTATE in its cause (`driverError`).
    if (own !== null) {
      const sqlstate = sqlstateOf((cause as { sqlstate?: unknown } | null)?.sqlstate);
      return sqlstate === null ? { expected: true, code: own } : { expected: true, code: own, reason: sqlstate };
    }
    const sqlstate = sqlstateOf(code);
    if (sqlstate !== null) return { expected: true, code: "unavailable", reason: sqlstate };
    if (ERRNO.test(code)) return { expected: true, code: "unavailable", reason: code.toLowerCase() };
  }
  if (typeof name === "string" && ABORTS.has(name))
    return { expected: true, code: "unavailable", reason: name === "AbortError" ? "abort_error" : "timeout_error" };
  return { expected: false, code: "bug", reason: classCode(error) };
}
