import type { EvidenceId, Mention } from "@intelligence/contracts";
import { describe, expect, it, vi } from "vitest";
import { QUENTIN, WORK_ONLY } from "../test-support/cast.ts";
import { one, sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { MAIL } from "../test-support/items-named.ts";
import { countOf, rowsOf, stored, withPipeline } from "../test-support/pipeline-fixtures.ts";
import { lines, snapshot } from "../test-support/snapshot.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Each refusal has its positive control.

const AT = "2026-09-01T09:00:00.000Z";
const source = (value: string): Mention => ({ key: { kind: "source_id", value }, observedAt: AT }) as Mention;
const evidence = (value: string): EvidenceId => value as EvidenceId;

const organizationOf = async (db: TestDatabase, domain: string, compartment: string): Promise<string> =>
  one(
    await rowsOf<{ entity_id: string }>(
      db,
      "select entity_id from knowledge.domains where domain_fp = $1 and compartments = $2::text[]",
      [fingerprint(db.keys, "domain", domain), [compartment]],
    ),
  ).entity_id;

describe("the identity port's organization mention", () => {
  it("a domain mention resolves only to an organization whose domain row is under the item's compartment, and writes nothing", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      const lighthouse = await organizationOf(db, "lighthouse.test", "own");
      const item = await pipeline.open(evidence(id));
      if (item === null) throw new Error("no item");
      const before = lines(await snapshot(db));
      const ask = (mention: Mention) => item.context.identity.resolve(mention, "personal", "r" as never);
      expect(await ask(source("domain:lighthouse.test"))).toEqual({ outcome: "linked", entity: lighthouse, epoch: 0 });
      // The domain is read in lower case, as an address's is.
      expect(await ask(source("domain:Lighthouse.TEST"))).toEqual({ outcome: "linked", entity: lighthouse, epoch: 0 });
      expect(item.kindOf(lighthouse as never)).toBe("organization");
      // Not a domain, or not a domain mention: nobody.
      for (const value of [
        "lighthouse.test",
        "domain:",
        "domain:lighthouse",
        "domain:quentin@lighthouse.test",
        "project:this",
        "crm-41",
      ]) {
        expect(await ask(source(value)), value).toEqual({ outcome: "not_a_person" });
      }
      expect(lines(await snapshot(db))).toEqual(before);
    }));

  it("a domain known only under another compartment resolves to nobody", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const own = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      const work = await stored(writer, accounts.workMail, MAIL.workOnly);
      const domain = WORK_ONLY.address.split("@")[1] as string;
      const partner = await organizationOf(db, domain, "employer:example");
      const ownItem = await pipeline.open(evidence(own));
      expect(await ownItem?.context.identity.resolve(source(`domain:${domain}`), "personal", "r" as never)).toEqual({
        outcome: "not_a_person",
      });
      // The positive control: under the work item's own compartment it is that organization.
      const workItem = await pipeline.open(evidence(work));
      expect(await workItem?.context.identity.resolve(source(`domain:${domain}`), "personal", "r" as never)).toEqual({
        outcome: "linked",
        entity: partner,
        epoch: 0,
      });
    }));

  it("a public mail domain the store keeps no organization for resolves to nobody", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      expect(
        await countOf(db, "knowledge.domains", "domain_fp = $1", [fingerprint(db.keys, "domain", "gmail.com")]),
      ).toBe(0);
      const item = await pipeline.open(evidence(id));
      expect(await item?.context.identity.resolve(source("domain:gmail.com"), "personal", "r" as never)).toEqual({
        outcome: "not_a_person",
      });
      expect(
        await item?.context.identity.resolve(source("domain:lighthouse.test"), "personal", "r" as never),
      ).toMatchObject({ outcome: "linked" });
    }));

  it("a name mention resolves nobody, a person's or an organization's", () =>
    withPipeline(async ({ pipeline, writer, accounts }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      const item = await pipeline.open(evidence(id));
      for (const value of [QUENTIN.name, "Lighthouse", "lighthouse.test"]) {
        expect(
          await item?.context.identity.resolve(
            { key: { kind: "name", value }, observedAt: AT } as Mention,
            "personal",
            "r" as never,
          ),
          value,
        ).toEqual({ outcome: "not_a_person" });
      }
    }));

  it("the pipeline reads a domain row's clear columns and never its sealed one", () =>
    withPipeline(async ({ db, writer, accounts }) => {
      await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      expect(
        (
          await queryAs<{ n: number }>(db.urls.pipeline, "select count(entity_id)::int as n from knowledge.domains", [])
        )[0]?.n,
      ).toBeGreaterThan(0);
      expect(await sqlState(() => queryAs(db.urls.pipeline, "select domain_enc from knowledge.domains", []))).toBe(
        "42501",
      );
    }));
});
