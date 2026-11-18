import { PersonalLogEvent } from "@intelligence/contracts/personal";
import { createReader, type Reader } from "@intelligence/personal-store";
import { createTestDatabase, queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pi as runPi } from "../test-support/run-pi.ts";

// L17 through the real `pi` and the reader. After `pi lens revoke`, both tokens answer unauthorized
// and write no row, and a device client is in no audience, so no belief is built for it. L17's
// drain clause is lens-drain.db.test.ts's.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let db: TestDatabase;
let reader: Reader;
beforeAll(async () => {
  db = await createTestDatabase();
  const record = (event: PersonalLogEvent): void => void PersonalLogEvent.parse(event);
  reader = createReader({ url: db.urls.reader, keys: db.keys, log: { info: record, warn: record, error: record } });
});
afterAll(async () => {
  await reader?.close();
  await db?.drop();
});

const pi = (argv: string[], { tty = false }: { tty?: boolean } = {}) =>
  runPi(argv, { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: db.keyFile }, { tty });

const count = async (text: string): Promise<number> =>
  (await queryAs<{ n: number }>(db.urls.admin, `select count(*)::int as n from ${text}`))[0]?.n ?? -1;
// The sets policy.audiences() answers, as the pipeline reads them to build beliefs.
const audiences = async (): Promise<string[][]> =>
  (await queryAs<{ audience: string[] }>(db.urls.pipeline, "select policy.audiences() as audience"))
    .map((row) => row.audience)
    .sort();

// A forget alone, as the store would hand policy.push_capture one: under the token, a session of
// its own, then the push, in one simple query of literals. Null when it ran, or its SQLSTATE.
let pushes = 0;
async function rawPush(token: string): Promise<string | null> {
  pushes += 1;
  const n = String(pushes).padStart(3, "0");
  const item = {
    id: `cin_01JABCDEFGHJKMNPQRSTVWX${n}`,
    kind: "forget",
    source_key_fp: "a".repeat(61) + n,
    content_fp: "b".repeat(64),
    revision: 0,
    body_bytes: 2,
    body_enc: { v: 1, nonce: "bm9uY2U", ciphertext: "Y2lwaGVy", tag: "dGFn" },
    surfaces: [],
  };
  const session = `ses_01JABCDEFGHJKMNPQRSTVWX${n}`;
  try {
    await queryAs(
      db.urls.reader,
      `select set_config('pi.client_token', '${token}', false); select policy.open_session('${session}');
       select * from policy.push_capture('${session}', 'batch-revoke-${n}', '${JSON.stringify([item])}'::jsonb, false)`,
    );
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

describe("L17: revocation", () => {
  it("after pi lens revoke, both tokens answer unauthorized and write no row; a device client is in no audience", async () => {
    // The mirror cleared for the employer alone, so a device audience would be the only `{own}`.
    const added = await pi(["lens", "add", "mac", "--compartments", "employer:example", "--views", "self,work"], {
      tty: true,
    });
    expect(added.exit).toBe(0);
    // The mirror's first token is `lens rotate --mirror`'s.
    const issued = await pi(["lens", "rotate", "mac", "--mirror"], { tty: true });
    expect(issued.exit).toBe(0);
    const tokens = { ...(JSON.parse(added.stdout) as { capture: string }), mirror: issued.stdout.trimEnd() };

    expect(await audiences()).toEqual([["employer:example"]]);

    // Before: each token is a client. Neither holds get_self, so each call is not_permitted and
    // logged; a push of the capture client is taken.
    for (const token of [tokens.capture, tokens.mirror]) {
      expect(await reader.client(token)).not.toBeNull();
      expect(await reader.getSelf(token)).toEqual({ ok: false, code: "not_permitted" });
    }
    expect(await rawPush(tokens.capture)).toBeNull();
    expect(await count("ledger.capture_inbox")).toBe(1);

    expect(await pi(["lens", "revoke", "mac"])).toEqual({ exit: 0, stdout: "", stderr: "" });

    // After: unauthorized, and no row of any kind written by either token.
    const calls = await count("policy.calls");
    const sessions = await count("ledger.sessions");
    for (const token of [tokens.capture, tokens.mirror]) {
      expect(await reader.client(token)).toBeNull();
      expect(await reader.getSelf(token)).toEqual({ ok: false, code: "unauthorized" });
    }
    expect(await rawPush(tokens.capture)).toBe("42501");
    expect(await count("policy.calls")).toBe(calls);
    expect(await count("ledger.sessions")).toBe(sessions);
    // The row pushed before the revocation stays, for the drain.
    expect(await count("ledger.capture_inbox")).toBe(1);
    // Revoked, neither is in any audience.
    expect(await audiences()).toEqual([]);

    expect(
      (
        await pi([
          "clients",
          "add",
          "agent",
          "--broad",
          "--views",
          "self",
          "--tools",
          "get_self",
          "--retention",
          "none",
        ])
      ).exit,
    ).toBe(0);
    expect(await audiences()).toEqual([["own"]]);
  });
});
