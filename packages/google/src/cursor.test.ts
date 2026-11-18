import { ConnectorCursor } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import { calendarCursor, contactsCursor, mailCursor, readContactsCursor } from "./cursor.ts";
import { GoogleError } from "./http.ts";

// The contacts connector's two phases in the package's cursor codec. Made-up tokens.
const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof GoogleError) return error.code;
    throw error;
  }
  return "none";
};
const encoded = (value: unknown): ConnectorCursor =>
  ConnectorCursor.parse(Buffer.from(JSON.stringify(value)).toString("base64url"));

describe("the contacts cursor", () => {
  it("a cursor of the mail connector fails bad_cursor", () => {
    expect(codeOf(() => readContactsCursor(mailCursor({ phase: "reset" })))).toBe("bad_cursor");
    expect(codeOf(() => readContactsCursor(calendarCursor({ phase: "sync", syncToken: "fake-sync" })))).toBe(
      "bad_cursor",
    );
    expect(codeOf(() => readContactsCursor(ConnectorCursor.parse("not-a-cursor")))).toBe("bad_cursor");
    expect(
      codeOf(() => readContactsCursor(encoded({ v: 4, connector: "google_contacts", phase: "list", pageToken: "" }))),
    ).toBe("bad_cursor");
    expect(
      codeOf(() =>
        readContactsCursor(
          encoded({ v: 4, connector: "google_contacts", phase: "list", pageToken: "t", timeMin: "x" }),
        ),
      ),
    ).toBe("bad_cursor");
  });

  it("one phase has one encoding", () => {
    for (const phase of [
      { phase: "list", pageToken: "fake-page" },
      { phase: "sync", syncToken: "fake-sync" },
      { phase: "sync", syncToken: "fake-sync", pageToken: "fake-page" },
    ] as const) {
      const cursor = contactsCursor(phase);
      expect(readContactsCursor(cursor)).toEqual(phase);
      // Keys in another order make the same cursor.
      expect(contactsCursor(Object.fromEntries(Object.entries(phase).reverse()) as typeof phase)).toBe(cursor);
    }
  });
});
