import { REFUSAL_CODE_HINTS } from "@intelligence/contracts/personal";

// What every route of the HTTP server answers with, and the one body cap every route but Lens's has.

export const MAX_BODY = 64 * 1024;

export type HttpAnswer = {
  status: number;
  body: string;
  type: "application/json" | "text/plain" | "text/html";
  headers?: Record<string, string>;
};

export const json = (status: number, value: unknown): HttpAnswer => ({
  status,
  body: JSON.stringify(value),
  type: "application/json",
});
export const error = (status: number, code: string): HttpAnswer => json(status, { error: code });
// A tool not granted or that is no tool answers this, so neither can be told from the other
// (invariant 6). Without OAuth a token missing, unknown or revoked answers it too; with OAuth such
// a token answers 401 with the challenge instead, so a caller can tell a
// bad token from an ungranted tool, but never which tools another client holds.
export const REFUSED = json(403, { error: "not_permitted", hint: REFUSAL_CODE_HINTS.not_permitted });

export const bearer = (header: string | undefined): string | undefined => /^Bearer (\S+)$/i.exec(header ?? "")?.[1];
