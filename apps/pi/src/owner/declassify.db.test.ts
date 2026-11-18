import { DeclassificationView, type PersonalLogger } from "@intelligence/contracts/personal";
import { createAdmin, createPipeline, createWriter } from "@intelligence/personal-store";
import {
  batchOf,
  claimRecord,
  createTestDatabase,
  fingerprint,
  MAIL,
  queryAs,
  stored,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pi } from "../test-support/run-pi.ts";

// `pi declassify add`, `list` and `revoke` through `run`, on a database of their own whose key file holds
// `declassified`.

type Env = Record<string, string>;

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const quiet: PersonalLogger = { info() {}, warn() {}, error() {} };
const databases: TestDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) await database.drop();
});

const WHAT = "canary-declassify-command";
const CLIENT = "heron-client-name";

// A database with one claim of the owner's on the canary's message, whose counterparty is the
// owner, and one active client cleared for `declassified`; the owner environment and the claim id.
async function owner(): Promise<{ db: TestDatabase; env: Env; claim: string }> {
  const db = await createTestDatabase({ compartments: ["own", "employer:example", "declassified"] });
  databases.push(db);
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log: quiet });
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: quiet });
  const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet });
  try {
    const address = MAIL.canary.to?.[0]?.address ?? "";
    const account = await writer.ensureSourceAccount("personal", "google_mail", "own", address);
    const evidence = await stored(writer, account, MAIL.canary);
    const [row] = await queryAs<{ id: string }>(
      db.urls.admin,
      "select id from knowledge.entities where kind = 'owner'",
    );
    const ownerId = row?.id ?? "";
    const record = claimRecord(evidence, "own", ownerId);
    const claim = {
      ...record,
      claim: { ...record.claim, content: { ...record.claim.content, fields: { counterparty: ownerId, what: WHAT } } },
      fieldKinds: { counterparty: "entity", what: "text" },
    };
    expect(await pipeline.commit(batchOf(evidence, [claim as never]))).toBe("committed");
    await admin.clients.addClient({
      name: CLIENT,
      runtime: "local",
      vendorRetention: "none",
      compartments: ["declassified"],
      views: ["self", "people", "work"],
      tools: ["get_self", "find_facts"],
    });
    return {
      db,
      env: { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: db.keyFile },
      claim: fingerprint(db.keys, "claim", record.claim.id),
    };
  } finally {
    await admin.close();
    await pipeline.close();
    await writer.close();
  }
}

describe("pi declassify", () => {
  it("add prints the ruling id and no content", async () => {
    const { db, env, claim } = await owner();
    const added = await pi(["declassify", "add", claim], env);
    expect(added.exit).toBe(0);
    const { ruling } = JSON.parse(added.stdout) as { ruling: string };
    expect(ruling).toMatch(/^rul_/);
    expect(added.stdout).toBe(`${JSON.stringify({ ruling })}\n`);
    expect(`${added.stdout}${added.stderr}`).not.toContain(WHAT);
    expect(await queryAs(db.urls.admin, "select ruling_id, claim_fp from projections.declassified_facts")).toEqual([
      { ruling_id: ruling, claim_fp: claim },
    ]);
    // A second is refused with its code, and writes nothing.
    const again = await pi(["declassify", "add", claim], env);
    expect(again.exit).toBe(1);
    expect(again.stderr).toContain("already_declassified");
    // list names it as standing.
    const listed = await pi(["declassify", "list"], env);
    expect(listed.exit).toBe(0);
    const views = (JSON.parse(listed.stdout) as unknown[]).map((one) => DeclassificationView.parse(one));
    expect(views.map((one) => [one.id, one.claim, one.state])).toEqual([[ruling, claim, "standing"]]);
    expect(listed.stdout).not.toContain(WHAT);
  });

  it("revoke prints the count and no client name", async () => {
    const { db, env, claim } = await owner();
    const { ruling } = JSON.parse((await pi(["declassify", "add", claim], env)).stdout) as { ruling: string };
    const revoked = await pi(["declassify", "revoke", ruling], env);
    expect(revoked.exit).toBe(0);
    expect(revoked.stdout).toBe(`${JSON.stringify({ exposed: 1 })}\n`);
    expect(`${revoked.stdout}${revoked.stderr}`).not.toContain(CLIENT);
    expect(await queryAs(db.urls.admin, "select count(*)::int as n from projections.declassified_facts")).toEqual([
      { n: 0 },
    ]);
    // An id that names no standing declassification is not_found.
    const again = await pi(["declassify", "revoke", ruling], env);
    expect(again.exit).toBe(1);
    expect(again.stderr).toContain("not_found");
  });

  it("an id that does not parse is a usage error, before any connection", async () => {
    const env = {
      PI_DATABASE_URL_ADMIN: "postgres://pi_admin:sentinel@127.0.0.1:1/pi_test",
      PI_KEY_FILE: "/nonexistent/pi/keys.json",
    };
    for (const argv of [
      ["declassify", "add", "not-a-claim"],
      ["declassify", "add", "C".repeat(64)],
      ["declassify", "revoke", "rul_short"],
      ["declassify", "revoke", "c".repeat(64)],
    ]) {
      const result = await pi(argv, env);
      expect(result.exit, argv.join(" ")).toBe(2);
      expect(result.stderr, argv.join(" ")).toContain("usage");
    }
  });
});
