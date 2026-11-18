import type { PersonalLogger } from "@intelligence/contracts/personal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { testId } from "../test-support/clients.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Settings' Autonomy shows each standing rule as it is now, from `workStatus`: the
// merges switch, the owner's release of commitment closes to agents and the grouping setting, each as
// the command that sets it left it.

const quiet: PersonalLogger = { info() {}, warn() {}, error() {} };
const databases: TestDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) await database.drop();
});

describe("the owner's standing rules in workStatus", () => {
  it("reads each rule's default, then each as the owner set it", async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet });
    try {
      expect((await admin.work.status()).rules).toEqual({ merges: "off", agentCloses: "off", grouping: "shadow" });
      await admin.identity.setIdentityMerges("on");
      await admin.commitments.setAgentCloses(true, { requestId: testId("req") });
      await admin.facts.setGroupingMode("off");
      expect((await admin.work.status()).rules).toEqual({ merges: "on", agentCloses: "on", grouping: "off" });
    } finally {
      await admin.close();
    }
  });
});
