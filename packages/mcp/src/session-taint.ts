// Session taint: each session's label, and each token's, kept in this process's memory, and the
// verdict on a call from it. A session is one client token and, when the client sends one, its MCP
// session id. A token's label joins every session of it, so a new session id, or a session dropped
// past MAX_SESSIONS, never starts a token clean for the restricted rules.

import { createHash } from "node:crypto";
import type { ClientView, SessionLabel, SessionTaintCode, ToolName } from "@intelligence/contracts/personal";
import {
  FRESH_LABEL,
  isRawTextTool,
  isTaintPrivate,
  isTaintReadTool,
  isTaintRestricted,
  joinLabels,
  sendsFreeText,
} from "@intelligence/contracts/personal";

// A label kept this long after its session's (or token's) last call is forgotten, and at most this
// many sessions, and this many tokens, are kept, the least recently used dropped first.
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const MAX_SESSIONS = 10_000;
const MAX_TOKENS = 1_000;

// What a call is told before it runs: refused with a code; counted in shadow with a code, and run;
// or run.
export type Verdict = { refuse: SessionTaintCode } | { shadow: SessionTaintCode } | null;

// The verdict for one call, from the session's label, its token's label and the caller's clearance.
// A read's label is the caller's clearance, as the read log keeps it, since a result carries no label
// of its own. Restricted compartments are enforced, from the session's label or any other session of
// the token; any other private compartment, and free text to other agents from a marked session, is
// counted in shadow only, from the session's own label.
export function verdictOn(
  label: SessionLabel,
  client: ClientView,
  tool: ToolName,
  args: unknown,
  token: SessionLabel = FRESH_LABEL,
): Verdict {
  if (isRawTextTool(tool)) {
    if ([...label.compartments, ...token.compartments].some(isTaintRestricted)) return { refuse: "private_session" };
    if (label.compartments.some(isTaintPrivate)) return { shadow: "private_session" };
    return null;
  }
  if (!label.untrusted && !token.untrusted) return null;
  // Agents always write back: free text from a marked session is counted, never refused.
  if (sendsFreeText(tool, args)) return label.untrusted ? { shadow: "tainted_session" } : null;
  if (isTaintReadTool(tool)) {
    if (client.compartments.some(isTaintRestricted)) return { refuse: "tainted_session" };
    if (label.untrusted && client.compartments.some(isTaintPrivate)) return { shadow: "tainted_session" };
  }
  return null;
}

// What a call that answered ok adds to its session's label: a read, the caller's clearance; a
// raw-text read, the untrusted mark too. Any other call reads nothing under a label.
export function readBy(client: ClientView, tool: ToolName): SessionLabel | null {
  if (!isTaintReadTool(tool)) return null;
  return { compartments: [...client.compartments].sort(), untrusted: isRawTextTool(tool) };
}

// Labels by key, each forgotten once idle past SESSION_IDLE_MS, at most `max` kept.
class Labels {
  readonly #labels = new Map<string, { label: SessionLabel; at: number }>();
  readonly max: number;
  readonly now: () => number;

  constructor(max: number, now: () => number) {
    this.max = max;
    this.now = now;
  }

  get(key: string): SessionLabel {
    const kept = this.#labels.get(key);
    if (kept === undefined) return FRESH_LABEL;
    if (this.now() - kept.at > SESSION_IDLE_MS) {
      this.#labels.delete(key);
      return FRESH_LABEL;
    }
    return kept.label;
  }

  // The label joined with what a call read, kept as the most recently used. A call that read
  // nothing under a label keeps a marked label alive and starts none.
  add(key: string, read: SessionLabel | null): void {
    const before = this.get(key);
    if (read === null && before === FRESH_LABEL) return;
    const label = read === null ? before : joinLabels(before, read);
    this.#labels.delete(key);
    if (this.#labels.size >= this.max) {
      const oldest = this.#labels.keys().next().value;
      if (oldest !== undefined) this.#labels.delete(oldest);
    }
    this.#labels.set(key, { label, at: this.now() });
  }

  get size(): number {
    return this.#labels.size;
  }
}

// A call's place in the labels: its session's key and its token's.
export type TaintKey = { session: string; token: string };

// The sessions' labels and the tokens'. Keys are digests of the token and session id, so no token is
// kept here. The tokens' labels are their own map, so dropping sessions never drops a token's mark.
export class SessionTaint {
  readonly #sessions: Labels;
  readonly #tokens: Labels;

  constructor(now: () => number = Date.now) {
    this.#sessions = new Labels(MAX_SESSIONS, now);
    this.#tokens = new Labels(MAX_TOKENS, now);
  }

  static keyOf(token: string, session?: string): TaintKey {
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    return { session: digest(`${token}\n${session ?? ""}`), token: digest(`token\n${token}`) };
  }

  // The same call's key with its token's mark kept under the client the bearer resolved to.
  static forClient(key: TaintKey, clientId: string): TaintKey {
    return { session: key.session, token: createHash("sha256").update(`client\n${clientId}`).digest("hex") };
  }

  label(key: TaintKey): SessionLabel {
    return this.#sessions.get(key.session);
  }

  tokenLabel(key: TaintKey): SessionLabel {
    return this.#tokens.get(key.token);
  }

  // What a call read joins its session's label and its token's.
  add(key: TaintKey, read: SessionLabel | null): void {
    this.#sessions.add(key.session, read);
    this.#tokens.add(key.token, read);
  }

  get size(): number {
    return this.#sessions.size;
  }
}

// The sessions of a process that was handed none: `handle` called without its own.
export const PROCESS_SESSIONS = new SessionTaint();
