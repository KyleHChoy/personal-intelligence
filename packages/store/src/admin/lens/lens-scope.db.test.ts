import { BROWSER_BUNDLES, CaptureScopeRule, MULTI_ACCOUNT_SURFACES } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint } from "../../core/fingerprint.ts";
import { openRow } from "../../core/seal.ts";
import { sqlState } from "../../test-support/connections.ts";
import { queryAs, scanForPlaintext } from "../../test-support/database.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { refusedWith } from "../../test-support/values.ts";
import type { ScopeRuleInput } from "./lens-scope.ts";

// One store for the file, with the key file's own and employer:example. Every refusal has its
// control in the same test.

const TIMEOUT = 120_000;
const KINDS: ScopeRuleInput["kinds"][] = [["meeting"], ["moment"], ["block"], ["meeting", "moment", "block"]];
const WORK = "avery.quinn@employer.test";

let store: TestStore;
beforeAll(async () => {
  store = await openStore();
}, TIMEOUT);
afterAll(async () => {
  await store?.close();
});

const add = (rule: ScopeRuleInput) => store.admin.lens.addScope(rule);
const refused = (rule: ScopeRuleInput) => refusedWith(() => add(rule));
const code = (value: string) => ({ name: "AdminError", code: value });
type Row = {
  id: string;
  match: string;
  value_fp: string;
  value_enc: unknown;
  account_fp: string | null;
  account_enc: unknown;
  compartment: string;
  kinds: string[];
};
const rowOf = async (id: string): Promise<Row | undefined> =>
  (
    await queryAs<Row>(
      store.db.urls.admin,
      "select id, match, value_fp, value_enc, account_fp, account_enc, compartment, kinds from policy.capture_scope where id = $1",
      [id],
    )
  )[0];
const count = async (): Promise<number> =>
  (await queryAs(store.db.urls.admin, "select id from policy.capture_scope")).length;

describe("the capture scope's admin functions", { timeout: TIMEOUT }, () => {
  it("a scope rule's compartment is own or an employer the key file holds, and public or restricted is refused", async () => {
    const before = await count();
    expect(
      await refused({ match: "host", value: "public.example.org", compartment: "public" as never, kinds: ["moment"] }),
    ).toEqual(code("invalid_argument"));
    expect(
      await refused({
        match: "host",
        value: "public.example.org",
        compartment: "restricted:health" as never,
        kinds: ["moment"],
      }),
    ).toEqual(code("invalid_argument"));
    expect(
      await refused({
        match: "host",
        value: "public.example.org",
        compartment: "employer:absent" as never,
        kinds: ["moment"],
      }),
    ).toEqual(code("unknown_compartment"));
    expect(await count()).toBe(before);
    // The controls: own, and the employer the key file holds.
    const own = await add({ match: "host", value: "own.example.org", compartment: "own", kinds: ["moment"] });
    const employer = await add({
      match: "bundle",
      value: "test.example.work",
      compartment: "employer:example",
      kinds: ["meeting", "block"],
    });
    expect(own).toMatch(/^csr_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(employer).toMatch(/^csr_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect((await rowOf(employer))?.compartment).toBe("employer:example");
  });

  it("a scope rule for mail.google.com with no account is refused account_required, for every kind", async () => {
    for (const kinds of KINDS)
      expect(
        await refused({ match: "host", value: "mail.google.com", compartment: "own", kinds }),
        kinds.join(),
      ).toEqual(code("account_required"));
    // The same for every multi-account surface, host or bundle, written in any case.
    for (const value of MULTI_ACCOUNT_SURFACES.hosts)
      expect(
        await refused({ match: "host", value: value.toUpperCase(), compartment: "own", kinds: ["moment"] }),
        value,
      ).toEqual(code("account_required"));
    for (const value of MULTI_ACCOUNT_SURFACES.bundles)
      expect(await refused({ match: "bundle", value, compartment: "own", kinds: ["meeting"] }), value).toEqual(
        code("account_required"),
      );
    // The control: naming the account is accepted, one rule for each account.
    const work = await add({
      match: "host",
      value: "mail.google.com",
      account: WORK,
      compartment: "employer:example",
      kinds: ["moment"],
    });
    const personal = await add({
      match: "host",
      value: "mail.google.com",
      account: "avery@quinn.test",
      compartment: "own",
      kinds: ["moment"],
    });
    expect(work).not.toBe(personal);
    await add({
      match: "bundle",
      value: "us.zoom.xos",
      account: WORK,
      compartment: "employer:example",
      kinds: ["meeting", "block"],
    });
  });

  it("a bundle rule for a BROWSER_BUNDLES bundle is refused browser_bundle, for any kind", async () => {
    const before = await count();
    for (const value of BROWSER_BUNDLES) {
      for (const kinds of KINDS)
        expect(
          await refused({ match: "bundle", value, compartment: "own", kinds }),
          `${value} ${kinds.join()}`,
        ).toEqual(code("browser_bundle"));
      expect(
        await refused({
          match: "bundle",
          value: value.toLowerCase(),
          account: WORK,
          compartment: "own",
          kinds: ["meeting"],
        }),
        value,
      ).toEqual(code("browser_bundle"));
    }
    expect(await count()).toBe(before);
    // The controls: a host rule, and a bundle that is no browser.
    await add({ match: "host", value: "pages.example.org", compartment: "own", kinds: ["moment", "meeting"] });
    await add({ match: "bundle", value: "test.example.notes", compartment: "own", kinds: ["moment"] });
  });

  it("a value of the wrong form, no kinds or an unknown kind is invalid_argument", async () => {
    const before = await count();
    for (const rule of [
      { match: "host", value: "not a host!", compartment: "own", kinds: ["moment"] },
      { match: "host", value: "", compartment: "own", kinds: ["moment"] },
      { match: "bundle", value: "", compartment: "own", kinds: ["moment"] },
      { match: "host", value: "kinds.example.org", compartment: "own", kinds: [] },
      { match: "host", value: "kinds.example.org", compartment: "own", kinds: ["note"] },
      { match: "url", value: "kinds.example.org", compartment: "own", kinds: ["moment"] },
    ]) {
      expect(await refused(rule as never), JSON.stringify(rule)).toEqual(code("invalid_argument"));
    }
    expect(await count()).toBe(before);
    await add({ match: "host", value: "kinds.example.org", compartment: "own", kinds: ["moment"] });
  });

  it("its value is sealed and fingerprinted under capture_scope, normalized, and the account too when given", async () => {
    const id = await add({
      match: "host",
      value: "Sealed.Example.TEST.",
      account: "Sealed.Owner@example.org",
      compartment: "own",
      kinds: ["moment"],
    });
    const row = await rowOf(id);
    if (row === undefined) throw new Error("no row");
    expect(row).toMatchObject({ match: "host", compartment: "own", kinds: ["moment"] });
    expect(row.value_fp).toBe(fingerprint(store.db.keys, "capture_scope", "sealed.example.test"));
    expect(row.account_fp).toBe(fingerprint(store.db.keys, "capture_scope", "Sealed.Owner@example.org"));
    const opened = openRow(
      store.db.keys,
      "own",
      { table: "policy.capture_scope", id, column: "value_enc" },
      row.value_enc as never,
    );
    expect(opened.toLowerCase()).toContain("sealed.example.test");
    expect(
      openRow(
        store.db.keys,
        "own",
        { table: "policy.capture_scope", id, column: "account_enc" },
        row.account_enc as never,
      ).toLowerCase(),
    ).toContain("sealed.owner@example.org");
    expect(() =>
      openRow(
        store.db.keys,
        "employer:example",
        { table: "policy.capture_scope", id, column: "value_enc" },
        row.value_enc as never,
      ),
    ).toThrow();
    // A rule with no account has neither.
    const bare = await rowOf(
      await add({ match: "bundle", value: "test.example.sealed", compartment: "own", kinds: ["moment"] }),
    );
    expect([bare?.account_fp, bare?.account_enc]).toEqual([null, null]);
    // No value is in plaintext anywhere, nor its keyed form under another kind.
    expect(
      await scanForPlaintext(store.db.urls.admin, [
        "sealed.example.test",
        "sealed.owner@example.org",
        "test.example.sealed",
      ]),
    ).toEqual([]);
  });

  it("rules are unique by match, value and account, after normalization: the same again is duplicate_name", async () => {
    await add({ match: "host", value: "unique.example.org", compartment: "own", kinds: ["moment"] });
    expect(
      await refused({ match: "host", value: "UNIQUE.example.org.", compartment: "own", kinds: ["block"] }),
    ).toEqual(code("duplicate_name"));
    expect(
      await refused({ match: "host", value: "unique.example.org", compartment: "employer:example", kinds: ["moment"] }),
    ).toEqual(code("duplicate_name"));
    await add({ match: "bundle", value: "test.example.unique", compartment: "own", kinds: ["moment"] });
    expect(
      await refused({ match: "bundle", value: "Test.Example.Unique", compartment: "own", kinds: ["moment"] }),
    ).toEqual(code("duplicate_name"));
    // The controls: the same value with an account, or as a bundle, is another rule.
    await add({
      match: "host",
      value: "unique.example.org",
      account: WORK,
      compartment: "employer:example",
      kinds: ["moment"],
    });
    await add({ match: "bundle", value: "unique.example.org", compartment: "own", kinds: ["moment"] });
    expect(
      await refused({
        match: "host",
        value: "unique.example.org",
        account: WORK,
        compartment: "own",
        kinds: ["moment"],
      }),
    ).toEqual(code("duplicate_name"));
  });

  it("scope() answers a CaptureScopeRule for each rule, with no value or account", async () => {
    const named = await add({
      match: "host",
      value: "listed.example.org",
      account: WORK,
      compartment: "employer:example",
      kinds: ["moment", "block"],
    });
    const plain = await add({ match: "bundle", value: "test.example.listed", compartment: "own", kinds: ["meeting"] });
    const rules = await store.admin.lens.scope();
    expect(rules).toHaveLength(await count());
    for (const rule of rules) expect(CaptureScopeRule.parse(rule)).toEqual(rule);
    expect(rules.find((rule) => rule.id === named)).toEqual({
      id: named,
      match: "host",
      account: true,
      compartment: "employer:example",
      kinds: ["moment", "block"],
      agentApp: false,
      client: null,
    });
    expect(rules.find((rule) => rule.id === plain)).toEqual({
      id: plain,
      match: "bundle",
      account: false,
      compartment: "own",
      kinds: ["meeting"],
      agentApp: false,
      client: null,
    });
    const text = JSON.stringify(rules).toLowerCase();
    for (const needle of ["listed.example.org", "test.example.listed", WORK, "mail.google.com"])
      expect(text, needle).not.toContain(needle);
  });

  it("a source rule is a plain bundle rule of its source's app admitting moments alone, unique beside a plain rule of the bundle", async () => {
    const MESSAGES = "com.apple.MobileSMS";
    const source: ScopeRuleInput = {
      match: "bundle",
      value: MESSAGES,
      compartment: "own",
      kinds: ["moment"],
      source: "imessage",
    };
    const before = await count();
    expect(await refused({ ...source, value: "test.example.chat" })).toEqual(code("source_bundle"));
    for (const rule of [
      { ...source, match: "host", value: "messages.example.test" },
      { ...source, agentApp: true },
      { ...source, kinds: ["block"] },
      { ...source, kinds: ["moment", "block"] },
      { ...source, account: "avery@quinn.test" },
      { ...source, source: "screen" },
    ]) {
      expect(await refused(rule as never), JSON.stringify(rule)).toEqual(code("invalid_argument"));
    }
    expect(await count()).toBe(before);
    // The controls: a plain rule of the bundle and a source rule are two rules; each again is a
    // duplicate, the bundle in any case.
    const plain = await add({ match: "bundle", value: MESSAGES, compartment: "own", kinds: ["moment", "block"] });
    const marked = await add(source);
    expect(plain).not.toBe(marked);
    expect(await refused({ ...source, value: "COM.apple.mobilesms", kinds: ["moment"] })).toEqual(
      code("duplicate_name"),
    );
    expect(await refused({ match: "bundle", value: MESSAGES, compartment: "own", kinds: ["block"] })).toEqual(
      code("duplicate_name"),
    );
    expect(
      await queryAs(
        store.db.urls.admin,
        "select source from policy.capture_scope where id = any($1) order by source nulls first",
        [[plain, marked]],
      ),
    ).toEqual([{ source: null }, { source: "imessage" }]);
    // scope() shows the source only on the source rule, and no bundle.
    const rules = await store.admin.lens.scope();
    expect(rules.find((rule) => rule.id === marked)).toEqual({
      id: marked,
      match: "bundle",
      account: false,
      compartment: "own",
      kinds: ["moment"],
      agentApp: false,
      client: null,
      source: "imessage",
    });
    expect(rules.find((rule) => rule.id === plain)).not.toHaveProperty("source");
    // The database holds the same rule whoever writes it: a source rule of another kind is refused.
    expect(
      await sqlState(() =>
        queryAs(store.db.urls.admin, "update policy.capture_scope set kinds = '{moment,block}' where id = $1", [
          marked,
        ]),
      ),
    ).toBe("23514");
  });

  it("removeScope(id) removes the rule, and an unknown id is not_found", async () => {
    const id = await add({ match: "host", value: "gone.example.org", compartment: "own", kinds: ["moment"] });
    expect(await refusedWith(() => store.admin.lens.removeScope("csr_7ZZZZZZZZZZZZZZZZZZZZZZZZZ"))).toEqual(
      code("not_found"),
    );
    expect(await rowOf(id)).toBeDefined();
    await store.admin.lens.removeScope(id);
    expect(await rowOf(id)).toBeUndefined();
    expect((await store.admin.lens.scope()).some((rule) => rule.id === id)).toBe(false);
    expect(await refusedWith(() => store.admin.lens.removeScope(id))).toEqual(code("not_found"));
    // The value is free again.
    await add({ match: "host", value: "gone.example.org", compartment: "own", kinds: ["moment"] });
  });
});
