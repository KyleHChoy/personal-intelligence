import { ConnectorCursor, type SourceAccount, type SourceCredential } from "@intelligence/contracts";
import { SourceAccountId } from "@intelligence/contracts/personal";
import type { Connector } from "@intelligence/personal-core/items";
import { describe, expect, it } from "vitest";
import { createGoogleConnector } from "./connector.ts";
import { calendarCursor, mailCursor } from "./cursor.ts";
import { createGoogleHttp, GOOGLE_SCOPES, type GoogleDeps } from "./http.ts";
import { account, credential, failureOfCall as failure } from "./test-support/fixtures.ts";

// Every value here is made up. No test reaches the network: the port gets a fake fetch.

const otherId = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ1");

// An empty mailbox: a profile, and a listing with no message.
function emptyMailbox() {
  const calls: URL[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const body = url.pathname.endsWith("/profile")
      ? { emailAddress: "owner@example.org", historyId: "1000" }
      : { resultSizeEstimate: 0 };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const deps: GoogleDeps = {
    fetch,
    sleep: async () => {},
    now: () => Date.parse("2026-03-10T12:00:00.000Z"),
    random: () => 0.5,
    timeoutMs: 1000,
  };
  return { calls, deps, http: createGoogleHttp({ tokens: null, deps }) };
}

const encoded = (value: unknown): ConnectorCursor =>
  ConnectorCursor.parse(Buffer.from(JSON.stringify(value)).toString("base64url"));

describe("the Google connector", () => {
  it("a credential with a send scope, or for another connector, is refused at construction", async () => {
    const { calls, deps, http } = emptyMailbox();
    const send = { ...credential, scopes: [...GOOGLE_SCOPES, "https://www.googleapis.com/auth/gmail.send"] };
    expect((await failure(() => createGoogleConnector("google_mail", send, http, {}, deps))).code).toBe(
      "scope_mismatch",
    );
    // The scope gmail.readonly replaced is outside the set now.
    const metadata = { ...credential, scopes: [GOOGLE_SCOPES[1], "https://www.googleapis.com/auth/gmail.metadata"] };
    expect((await failure(() => createGoogleConnector("google_mail", metadata, http, {}, deps))).code).toBe(
      "scope_mismatch",
    );
    const calendar: SourceCredential = { ...credential, connector: "google_calendar" };
    expect((await failure(() => createGoogleConnector("google_mail", calendar, http, {}, deps))).code).toBe(
      "off_allowlist",
    );
    expect((await failure(() => createGoogleConnector("google_calendar", credential, http, {}, deps))).code).toBe(
      "off_allowlist",
    );
    expect(calls).toHaveLength(0);

    // The positive control: the credential with the two scopes, or fewer, is accepted and works.
    const connector: Connector = createGoogleConnector("google_mail", credential, http, {}, deps);
    expect((await connector.listChanges(account, null, 10)).items).toEqual([]);
    createGoogleConnector("google_mail", { ...credential, scopes: [GOOGLE_SCOPES[0]] }, http, {}, deps);
  });

  it("a mail credential is refused by the Drive connector, and a Drive credential by the mail and calendar connectors", async () => {
    const { calls, deps, http } = emptyMailbox();
    const drive = [
      "https://www.googleapis.com/auth/drive.metadata.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
    ];
    const docs = (scopes: string[]): SourceCredential => ({ ...credential, connector: "google_docs", scopes });
    for (const scopes of [
      [...GOOGLE_SCOPES],
      [drive[0] as string],
      [...drive, "https://www.googleapis.com/auth/drive.readonly"],
      [...drive, ...GOOGLE_SCOPES],
    ]) {
      expect(
        (await failure(() => createGoogleConnector("google_docs", docs(scopes), http, { roots: [] }, deps))).code,
        scopes.join(" "),
      ).toBe("scope_mismatch");
    }
    for (const id of ["google_mail", "google_calendar"] as const) {
      for (const scopes of [drive, [...GOOGLE_SCOPES, drive[1] as string]]) {
        expect(
          (await failure(() => createGoogleConnector(id, { ...credential, connector: id, scopes }, http, {}, deps)))
            .code,
          `${id} ${scopes.join(" ")}`,
        ).toBe("scope_mismatch");
      }
    }
    expect(calls).toHaveLength(0);
    // The control: each connector takes its own grant.
    createGoogleConnector("google_calendar", { ...credential, connector: "google_calendar" }, http, {}, deps);
    createGoogleConnector("google_docs", docs([...drive].reverse()), http, { roots: [] }, deps);
  });

  it("an account for another connector or source account is refused before any call", async () => {
    const { calls, deps, http } = emptyMailbox();
    const connector = createGoogleConnector("google_mail", credential, http, {}, deps);
    const { connector: _none, ...unread } = account;
    for (const refused of [
      { ...account, connector: "google_calendar" as const },
      { ...account, id: otherId },
      unread,
    ]) {
      expect((await failure(() => connector.listChanges(refused, null, 10))).code).toBe("off_allowlist");
    }
    expect(calls).toHaveLength(0);

    // The positive control: its own account is read.
    await connector.listChanges(account, null, 10);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("a cursor that does not decode fails bad_cursor", async () => {
    const { calls, deps, http } = emptyMailbox();
    const connector = createGoogleConnector("google_mail", credential, http, {}, deps);
    const broken = [
      ConnectorCursor.parse("not a cursor"),
      encoded("text"),
      encoded({}),
      encoded({ v: 5, connector: "google_mail", phase: "history", historyId: "1000" }),
      encoded({ v: 4, connector: "google_mail", phase: "sync", syncToken: "fake-sync-token" }),
      encoded({ v: 4, connector: "google_mail", phase: "list", start: "1000", reconcile: false }),
      encoded({ v: 4, connector: "google_mail", phase: "list", start: "1000", pass: "all", reconcile: false }),
      encoded({
        v: 4,
        connector: "google_mail",
        phase: "list",
        start: "1000",
        pass: "rest",
        pageToken: "p2",
        reconcile: "no",
      }),
      encoded({
        v: 4,
        connector: "google_mail",
        phase: "list",
        start: "1000",
        pass: "rest",
        reconcile: false,
        after: -1,
      }),
      encoded({
        v: 4,
        connector: "google_mail",
        phase: "list",
        start: "1000",
        pass: "rest",
        reconcile: false,
        after: 1.5,
      }),
      encoded({
        v: 4,
        connector: "google_mail",
        phase: "list",
        start: "1000",
        pass: "rest",
        reconcile: false,
        pending: [],
      }),
      encoded({
        v: 4,
        connector: "google_mail",
        phase: "list",
        start: "1000",
        pass: "older",
        reconcile: false,
        after: 1000,
      }),
      encoded({ v: 4, connector: "google_mail", phase: "list", start: "1000", pass: "older", reconcile: true }),
      encoded({
        v: 4,
        connector: "google_mail",
        phase: "list",
        start: "1000",
        pass: "older",
        reconcile: true,
        after: 1000,
        pending: ["m1"],
      }),
      encoded({ v: 4, connector: "google_mail", phase: "history", historyId: "" }),
      encoded({ v: 4, connector: "google_mail", phase: "history", historyId: "1000", pageToken: 7 }),
      encoded({ v: 4, connector: "google_mail", phase: "history", historyId: "1000", pending: [7] }),
      encoded({ v: 4, connector: "google_mail", phase: "history", historyId: "1000", sent: ["m1"] }),
      encoded({ v: 4, connector: "google_mail", phase: "history", historyId: "1000", pending: ["m1"], sent: ["m2"] }),
      encoded({ v: 4, connector: "google_mail", phase: "history", historyId: "1000", pending: ["m1"], sent: [] }),
      encoded({ v: 4, connector: "google_mail", phase: "history", historyId: "1000", pending: ["m1"], seen: ["m2"] }),
      encoded({
        v: 4,
        connector: "google_mail",
        phase: "history",
        historyId: "1000",
        pending: ["m1"],
        threads: ["t1"],
      }),
      encoded({
        v: 4,
        connector: "google_mail",
        phase: "history",
        historyId: "1000",
        pending: ["m1"],
        sent: ["m1"],
        seen: ["m1"],
      }),
      encoded({
        v: 4,
        connector: "google_mail",
        phase: "history",
        historyId: "1000",
        pending: ["m1"],
        sent: ["m1"],
        seen: [],
      }),
      encoded({
        v: 4,
        connector: "google_mail",
        phase: "history",
        historyId: "1000",
        pending: ["m1"],
        sent: ["m1"],
        threads: [7],
      }),
    ];
    for (const cursor of broken) {
      const error = await failure(() => connector.listChanges(account, cursor, 10));
      expect(error.code, Buffer.from(cursor, "base64url").toString()).toBe("bad_cursor");
    }
    expect(calls).toHaveLength(0);

    // The positive control: a cursor the codec made is read.
    await connector.listChanges(
      account,
      mailCursor({ phase: "list", start: "1000", pass: "rest", pageToken: "p2", reconcile: false }),
      10,
    );
    expect(calls).toHaveLength(1);
  });

  it("a cursor of the other connector fails bad_cursor", async () => {
    const { calls, deps, http } = emptyMailbox();
    const connector = createGoogleConnector("google_mail", credential, http, {}, deps);
    for (const cursor of [
      calendarCursor({ phase: "list", pageToken: "p2" }),
      calendarCursor({ phase: "sync", syncToken: "fake-sync-token" }),
    ]) {
      expect((await failure(() => connector.listChanges(account, cursor, 10))).code).toBe("bad_cursor");
    }
    expect(calls).toHaveLength(0);
  });

  it("a limit that is not a positive whole number is refused before any call", async () => {
    const { calls, deps, http } = emptyMailbox();
    const connector = createGoogleConnector("google_mail", credential, http, {}, deps);
    for (const limit of [0, -1, 1.5, Number.NaN])
      expect((await failure(() => connector.listChanges(account, null, limit))).code).toBe("bad_request");
    expect(calls).toHaveLength(0);
  });

  it("a since that is not a timestamp is refused with bad_request before any call", async () => {
    const { calls, deps, http } = emptyMailbox();
    const calendar: SourceCredential = { ...credential, connector: "google_calendar" };
    for (const since of ["2026-03-01", "2026-03-01T00:00:00", "yesterday", "", "2026-02-30T00:00:00Z"]) {
      expect(
        (await failure(() => createGoogleConnector("google_mail", credential, http, { since }, deps))).code,
        since,
      ).toBe("bad_request");
      expect(
        (await failure(() => createGoogleConnector("google_calendar", calendar, http, { since }, deps))).code,
        since,
      ).toBe("bad_request");
    }
    expect(calls).toHaveLength(0);

    // The positive control: a timestamp, with Z or an offset, is taken.
    for (const since of ["2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00+02:00"]) {
      const connector = createGoogleConnector("google_mail", credential, http, { since }, deps);
      expect((await connector.listChanges(account, null, 10)).listing).toEqual({ first: true });
    }
  });

  it("resetCursor is a cursor that starts a reconciling listing for mail, and null for a calendar", async () => {
    const { calls, deps, http } = emptyMailbox();
    const mail = createGoogleConnector("google_mail", credential, http, { since: "2026-03-01T00:00:00.000Z" }, deps);
    const reset = mail.resetCursor();
    // It makes no call, is a cursor sync can store, and is the same every time.
    expect(calls).toHaveLength(0);
    expect(ConnectorCursor.safeParse(reset).success).toBe(true);
    expect(mail.resetCursor()).toBe(reset);
    if (reset === null) throw new Error("mail has a reset cursor");
    // Read, it is a new listing's first page: the profile, then the list. The listing goes on
    // past the window's two passes to the older one, and ends complete.
    const first = await mail.listChanges(account, reset, 10);
    expect(first.listing).toEqual({ first: true });
    expect(calls.map((url) => url.pathname.split("/").at(-1))).toEqual(["profile", "messages"]);
    const rest = await mail.listChanges(account, first.next, 10);
    const older = await mail.listChanges(account, rest.next, 10);
    expect([rest.listing, older.listing, older.listed]).toEqual([
      { first: false },
      { first: false, ended: "complete" },
      [],
    ]);
    expect(calls.slice(2).map((url) => url.searchParams.get("q")?.split(" ")[0])).toEqual([
      "after:1772323200",
      "before:1772409600",
    ]);
    // The control: a first listing stops at the window.
    const plain = await mail.listChanges(account, null, 10);
    expect((await mail.listChanges(account, plain.next, 10)).listing).toEqual({ first: false, ended: "window" });

    // A calendar has none: its reset is the cleared cursor. It refuses the mail one.
    const calendarAccount: SourceAccount = { ...account, connector: "google_calendar", sourceKind: "calendar" };
    const calendar = createGoogleConnector(
      "google_calendar",
      { ...credential, connector: "google_calendar" },
      http,
      {},
      deps,
    );
    expect(calendar.resetCursor()).toBeNull();
    expect((await failure(() => calendar.listChanges(calendarAccount, reset, 10))).code).toBe("bad_cursor");
  });

  it("syncAccessList makes no call and returns no change", async () => {
    const { calls, deps, http } = emptyMailbox();
    const connector = createGoogleConnector("google_mail", credential, http, {}, deps);
    const first = await connector.syncAccessList(account, null);
    expect(first.changes).toEqual([]);
    expect(ConnectorCursor.safeParse(first.next).success).toBe(true);
    expect(await connector.syncAccessList(account, first.next)).toEqual(first);
    const given = ConnectorCursor.parse("fake-access-cursor");
    expect(await connector.syncAccessList(account, given)).toEqual({ changes: [], next: given });
    expect(calls).toHaveLength(0);
  });
});
