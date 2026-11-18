import { ClientId, SessionId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { Sessions } from "./sessions.ts";

describe("Sessions", () => {
  it("remembers one session for each client, and none for a client it was not told of", () => {
    const sessions = new Sessions();
    const alpha = ClientId.parse(`cli_${"0".repeat(26)}`);
    const beta = ClientId.parse(`cli_${"1".repeat(26)}`);
    const first = SessionId.parse(`ses_${"2".repeat(26)}`);
    expect(sessions.of(alpha)).toBeUndefined();
    sessions.remember(alpha, first);
    expect(sessions.of(alpha)).toBe(first);
    expect(sessions.of(beta)).toBeUndefined();
  });

  it("keeps a client's first session, and known() is a copy", () => {
    const sessions = new Sessions();
    const alpha = ClientId.parse(`cli_${"0".repeat(26)}`);
    const first = SessionId.parse(`ses_${"2".repeat(26)}`);
    const second = SessionId.parse(`ses_${"3".repeat(26)}`);
    const before = sessions.known();
    sessions.remember(alpha, first);
    sessions.remember(alpha, second);
    expect(sessions.of(alpha)).toBe(first);
    expect(before.size).toBe(0);
    expect(sessions.known().get(alpha)).toBe(first);
  });
});
