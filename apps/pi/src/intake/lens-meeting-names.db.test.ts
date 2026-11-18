import type { CaptureItem, CaptureMention, ClaimRecord, MeetingItem } from "@intelligence/contracts/personal";
import { meetingText } from "@intelligence/personal-core/lens";
import { runExtraction } from "@intelligence/personal-extract";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { type Admin, createAdmin, createPipeline, createReader, googleSecretName } from "@intelligence/personal-store";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  fingerprint,
  queryAs,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunDeps } from "../command-types.ts";
import { MODEL_ID, quiet } from "../test-support/extract-fixtures.ts";
import { addDevice, insertScope, claimsOf as openClaims } from "../test-support/lens-device.ts";
import { CLIENT, pi } from "../test-support/sync-db-fixtures.ts";

// Pushed as Lens pushes, drained and settled by `pi sync` in-process against a fake Google,
// extracted as `pi extract` runs it with the fake model. No network, no real model. Reserved domains
// only.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;

const OWNER_ADDRESS = "owner@quinn.test";
const MEET = { bundle: "test.example.meet", name: "Meet" };
const DECK_LINE = "I will send the deck by Friday.";
const FILLER = "We went over the agenda and the notes from last week, item by item, and slowly.";
const ROBIN: CaptureMention = { name: "Robin Vale", address: "robin.vale@example.org" };
const ROWAN: CaptureMention = { name: "Rowan Hale", address: "rowan.hale@example.org" };
const OTHER_ROWAN: CaptureMention = { name: "rowan  hale", address: "r.hale@example.net" };

let db: TestDatabase;
let owner: Admin;
const env = (): Record<string, string> => ({ PI_DATABASE_URL_WRITER: db.urls.writer, PI_KEY_FILE: db.keyFile });
const admin = <Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, sql, values);
const one = <Row>(rows: Row[]): Row => {
  expect(rows).toHaveLength(1);
  return rows[0] as Row;
};

let keys = 0;
// A consented call of the owner, S1 on input, and S2 on output known by `name` alone, with the
// calendar entry Lens read for it listing `attendees`.
const meeting = (from: number, name: string, attendees: CaptureMention[]): MeetingItem => ({
  kind: "meeting",
  key: `meeting:01JPKNAM${String((keys += 1)).padStart(18, "0")}`,
  revision: 0,
  startedAt: local(from),
  endedAt: local(from + HOUR),
  app: MEET,
  title: "Deck call",
  consent: true,
  mode: "call",
  calendar: {
    start: local(from),
    end: local(from + HOUR),
    organizer: { address: OWNER_ADDRESS },
    attendees: [{ address: OWNER_ADDRESS }, ...attendees],
  },
  speakers: [
    { label: "S1", owner: true, mention: { address: OWNER_ADDRESS } },
    { label: "S2", owner: false, mention: { name } },
  ],
  segments: [FILLER, FILLER, FILLER, DECK_LINE, FILLER, FILLER, FILLER, FILLER].map((text, n) => ({
    speaker: n % 2 === 0 ? "S1" : "S2",
    fromMs: n * 20_000,
    toMs: n * 20_000 + 19_000,
    channel: n % 2 === 0 ? "input" : "output",
    text,
  })),
});
const NAMED = meeting(-5 * HOUR, "Robin Vale", [ROBIN]);
const NAMESAKES = meeting(-4 * HOUR, "Rowan Hale", [ROWAN, OTHER_ROWAN]);

function google(): RunDeps {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = `${url.host}${url.pathname}`;
    if (path === "oauth2.googleapis.com/token")
      return json({
        access_token: "sentinel-access-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope:
          "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events.readonly",
      });
    if (path === "gmail.googleapis.com/gmail/v1/users/me/profile")
      return json({ emailAddress: OWNER_ADDRESS, historyId: "1000" });
    if (path === "gmail.googleapis.com/gmail/v1/users/me/messages") return json({ resultSizeEstimate: 0 });
    if (path === "gmail.googleapis.com/gmail/v1/users/me/history") return json({ historyId: "1000" });
    if (path === "www.googleapis.com/calendar/v3/calendars/primary/events")
      return json({ items: url.searchParams.has("syncToken") ? [] : [], nextSyncToken: "sync-1" });
    return json({}, 404);
  };
  return { google: { fetch, sleep: async () => {}, now: () => T, random: () => 0.5, timeoutMs: 5000 } };
}

// The model's answer: S2's deck line, as S2's.
const speaker = (label: string) => ({ key: { kind: "source_id", value: `speaker:${label}` }, observedAt: local(0) });
function answerFor(item: MeetingItem) {
  const { spans } = meetingText(item);
  const cited = spans[item.segments.findIndex((one) => one.text === DECK_LINE)];
  return {
    claims: [
      {
        type: "commitment",
        subject: speaker("S2"),
        fields: { counterparty: speaker("S1"), what: DECK_LINE },
        statementKind: "stated_fact",
        basis: "explicit_self",
        span: `seg:${cited?.from}-${cited?.to}`,
      },
    ],
    narrowing: "none",
  };
}

const evidenceOf = async (item: CaptureItem): Promise<string> =>
  one(
    await admin<{ evidence_id: string }>("select evidence_id from knowledge.captures where capture_key = $1", [
      item.key,
    ]),
  ).evidence_id;
const holderOf = async (address: string): Promise<string> =>
  one(
    await admin<{ entity_id: string }>("select entity_id from knowledge.accounts where value_fp = $1", [
      fingerprint(db.keys, "address", address),
    ]),
  ).entity_id;
const claimsOf = async (evidenceId: string): Promise<ClaimRecord[]> =>
  (await openClaims(db, evidenceId)).filter((record) => record.claim.content.type === "commitment");

const evidence: Record<"named" | "namesakes", string> = { named: "", namesakes: "" };

beforeAll(async () => {
  db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  owner = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet });
  const token = await addDevice(db);
  await insertScope(db, "bundle", MEET.bundle, ["meeting"]);
  await owner.secrets.setSecret(googleSecretName("personal", "client"), CLIENT);
  await owner.secrets.setSecret(googleSecretName("personal", "refresh_token"), "sentinel-refresh-token-5c2e17");
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log: quiet });
  try {
    const items: CaptureItem[] = [NAMED, NAMESAKES];
    expect((await reader.pushCapture(token, { batch: "pi-lens-names-0001", items })).ok).toBe(true);
  } finally {
    await reader.close();
  }
  // The drain, then the participant step: each calendar address a person; no name bound.
  const result = await pi(["sync"], env(), google());
  expect(result.exit, result.stderr).toBe(0);
  evidence.named = await evidenceOf(NAMED);
  evidence.namesakes = await evidenceOf(NAMESAKES);
  expect(
    await admin("select id from knowledge.mention_bindings where evidence_id = any($1)", [Object.values(evidence)]),
  ).toEqual([]);
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: quiet });
  try {
    const summary = await runExtraction({
      store: pipeline,
      model: fakeModelClient({ [evidence.named]: answerFor(NAMED), [evidence.namesakes]: answerFor(NAMESAKES) }, []),
      modelId: MODEL_ID,
      log: quiet,
      now: () => new Date(T),
      compartments: ["own", "employer:example"],
      meetings: true,
    });
    expect(summary).not.toBe("already_running");
  } finally {
    await pipeline.close();
  }
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await owner?.close();
  await db?.drop();
});

describe("a speaker known by a name alone, resolved by the calendar entry", { timeout: DB_TEST_TIMEOUT }, () => {
  it("the one calendar attendee of the name is the speaker: the claim is kept, about that person, with no binding by the owner", async () => {
    const claims = await claimsOf(evidence.named);
    expect(claims.map((one) => [one.claim.content.subject, one.claim.content.fields.what])).toEqual([
      [await holderOf(ROBIN.address as string), DECK_LINE],
    ]);
  });

  it("a name the calendar entry gives two people of is no one's: no claim is kept, no binding or person is made for it, and the name is filed", async () => {
    expect(await claimsOf(evidence.namesakes)).toEqual([]);
    const people = await admin<{ id: string }>("select id from knowledge.entities where kind = 'person'");
    // The two addresses' people, the other meeting's one, and nobody made from the name.
    expect(people).toHaveLength(3);
    expect(
      (await admin("select id from vault.unresolved_mentions where evidence_id = $1", [evidence.namesakes])).length,
    ).toBeGreaterThan(0);
  });
});
