import type { CardId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { newId } from "../core/ids.ts";
import { queryAs } from "../test-support/database.ts";
import { type RulingStore, withRulings } from "../test-support/ruling-fixtures.ts";

// Same-fact cards, on Postgres: same_fact cards have their own cap, so pending ones never defer
// another kind of system:extract's cards, in raiseCard or in ledger.admit_deferred; and `pi facts
// grouping apply` is refused until the accept band meets D12's agreement.

const TIMEOUT = 180_000;
let request = 0;
const requestId = (): string => `request-k3a-cap-${String((request += 1)).padStart(8, "0")}`;
const caseKey = (n: number): string => n.toString(16).padStart(64, "0");

async function raise(
  store: RulingStore,
  kind: "same_fact" | "about_you",
  n: number,
): Promise<{ id: CardId; state: string }> {
  return store.admin.cards.raiseCard({
    id: newId("crd") as CardId,
    requestId: requestId(),
    kind,
    author: "system:extract",
    options: kind === "same_fact" ? ["same", "different", "skip"] : ["confirm", "reject"],
    target: { kind: "claim", id: caseKey(1000 + n) },
    refs: [],
    compartments: ["own"],
    expiresAt: null,
    expiresAfterDays: 14,
    caseKey: kind === "same_fact" ? caseKey(n) : null,
    run: null,
    body: null,
    bodyFrom: null,
  } as never);
}

describe("no cap holds system:extract's cards back", { timeout: TIMEOUT }, () => {
  it("twelve pending same_fact cards and twelve of another kind are all pending", () =>
    withRulings(async (store) => {
      for (let n = 1; n <= 12; n += 1) expect((await raise(store, "same_fact", n)).state).toBe("pending");
      for (let n = 1; n <= 12; n += 1) expect((await raise(store, "about_you", n)).state).toBe("pending");
    }));
});

describe("apply waits for the accept band's agreement", { timeout: TIMEOUT }, () => {
  it("apply is refused with agreement_unmet with no answers; off and shadow are set", () =>
    withRulings(async (store) => {
      const refused = await store.admin.facts.setGroupingMode("apply").then(
        () => "set",
        (error: unknown) => (error as { code?: string }).code,
      );
      expect(refused).toBe("agreement_unmet");
      const mode = async () =>
        (await queryAs<{ grouping: string }>(store.db.urls.admin, "select grouping from policy.owner_settings"))[0]
          ?.grouping;
      expect(await mode()).toBe("shadow");
      await store.admin.facts.setGroupingMode("off");
      expect(await mode()).toBe("off");
      await store.admin.facts.setGroupingMode("shadow");
      expect(await mode()).toBe("shadow");
    }));
});
