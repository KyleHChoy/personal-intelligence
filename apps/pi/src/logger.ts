import { faultOf, PersonalLogEvent } from "@intelligence/contracts/personal";

// The personal logger and its clock, shared with pi-reasoner: one JSON line per event, to stderr
// and nowhere else (log-lines.ts in the personal contracts).
export { createLogger, logClockOf } from "@intelligence/contracts/personal";

// The code a process warning is logged under: its name in lower snake case, such as
// `deprecation_warning`. A name that makes no code is the fixed `warning`; a warning's message
// is never logged.
export function warningCode(name: string): string {
  const code = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return PersonalLogEvent.safeParse({ event: "process_warning", code }).success && code.length <= 64 ? code : "warning";
}

// A failure's code and reason for its log line: its own fixed code, `unavailable` for a driver's or
// a socket's error or an abort, `bug` for anything else, with its SQLSTATE, errno or class as the
// reason (faultOf). Never its message.
export function faultFields(error: unknown): { code: string; reason?: string } {
  const { code, reason } = faultOf(error);
  return reason === undefined ? { code } : { code, reason };
}
