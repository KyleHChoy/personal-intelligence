import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import type { ClientRegistration } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { keys, log, thrown } from "../test-support/unit.ts";
import { createAdmin } from "./admin.ts";
import { googleSecretName } from "./admin-base.ts";
import { UNBUILT_READ_TOOLS } from "./clients/admin-clients.ts";

// The parts of the admin that need no database. Its database tests are in admin*.db.test.ts.

describe("createAdmin", () => {
  it("a malformed URL is refused without its password", async () => {
    const secret = `canary-${randomBytes(6).toString("hex")}`;
    const malformed = [
      `postgres://pi_admin:${secret}@127.0.0.1:notaport/personal`,
      `postgres://pi_admin:${secret}@[::1/personal`,
      `pi_admin:${secret}@127.0.0.1/personal`,
      `http://pi_admin:${secret}@127.0.0.1:54329/personal`,
      `not a url ${secret}`,
      "",
    ];
    for (const url of malformed) {
      const error = thrown(() => createAdmin({ url, keys, log }));
      expect(error).toBeInstanceOf(Error);
      expect(error?.code).toBe("bad_url");
      // No part of the URL, in the message, the stack, or any property, shown or hidden.
      const shown = `${inspect(error, { depth: 8, showHidden: true })}\n${String(error?.stack)}\n${JSON.stringify(Object.getOwnPropertyDescriptors(error))}`;
      for (const part of [secret, "pi_admin", "127.0.0.1", "notaport", "not a url"]) expect(shown).not.toContain(part);
    }
    // The positive control: a well-formed URL makes an admin. Nothing connects until it is used.
    const admin = createAdmin({ url: `postgres://pi_admin:${secret}@127.0.0.1:54329/personal`, keys, log });
    await admin.close();
  });
});

describe("googleSecretName", () => {
  it("names a label's refresh token and its client", () => {
    expect(googleSecretName("personal", "refresh_token")).toBe("google/personal/refresh_token");
    expect(googleSecretName("work", "client")).toBe("google/work/client");
  });
});

describe("tools nothing serves yet", () => {
  // Refused before any statement, so no database is needed: the URL names a port nothing listens on.
  it("a registration that lists a read tool of read-quotas-and-tools is not_built until its step", async () => {
    const admin = createAdmin({ url: "postgres://pi_admin:unused@127.0.0.1:9/personal", keys, log });
    try {
      for (const tool of UNBUILT_READ_TOOLS) {
        const registration: ClientRegistration = {
          name: "helper",
          runtime: "local",
          vendorRetention: "none",
          compartments: ["own"],
          views: ["self", "people", "work"],
          tools: ["get_self", tool],
        };
        await expect(admin.clients.addClient(registration), tool).rejects.toMatchObject({
          name: "AdminError",
          code: "not_built",
        });
        await expect(admin.clients.addClient({ ...registration, kind: "reasoner" }), tool).rejects.toMatchObject({
          name: "AdminError",
          code: "not_built",
        });
      }
      expect([...UNBUILT_READ_TOOLS].sort()).toEqual(["get_decision_history", "sync_mirror"]);
    } finally {
      await admin.close();
    }
  });
});

describe("the admin's methods of corrections-and-digest", () => {
  it("each is built and reaches the database; none is a stub", async () => {
    const admin = createAdmin({
      url: "postgres://pi_admin:local-only@127.0.0.1:1/pi_test",
      keys,
      log,
      timeoutMs: 1_000,
    });
    const FACT = "c".repeat(64) as never;
    const RULING = "rul_01JABCDEFGHJKMNPQRSTVWXYZ0" as never;
    const options = { requestId: "request-adm-stub-01" };
    const built: Record<string, () => Promise<unknown>> = {
      factShow: () => admin.facts.show(FACT),
      rejectClaim: () => admin.facts.rejectClaim(FACT, options),
      vetoFact: () => admin.facts.vetoFact(FACT, options),
      listRulings: () => admin.facts.listRulings(),
      liftRuling: () => admin.facts.liftRuling(RULING, options),
      declassify: () => admin.releases.declassify(FACT, options),
      listDeclassified: () => admin.releases.listDeclassified(),
      revokeDeclassified: () => admin.releases.revokeDeclassified(RULING, options),
      digest: () => admin.cards.digest(),
    };
    try {
      // A method that is built reaches the closed port.
      for (const [name, call] of Object.entries({ ...built, listVetoes: () => admin.cards.listVetoes() })) {
        const reached = await call().then(
          () => undefined,
          (refused: unknown) => refused as { code?: string },
        );
        expect(reached?.code, name).toBe("unavailable");
      }
    } finally {
      await admin.close();
    }
  });
});

// request_research is in the contracts before anything serves it, so a registration naming it is
// refused.
describe("a registration that lists request_research", () => {
  const registration: ClientRegistration = {
    name: "researcher",
    runtime: "local",
    vendorRetention: "none",
    compartments: ["own"],
    views: ["people"],
    tools: ["get_entity", "request_research"],
  };
  const codeOf = async (call: () => Promise<unknown>): Promise<unknown> =>
    call().then(
      () => "resolved",
      (error: unknown) => ({ name: (error as Error).name, code: (error as { code?: string }).code }),
    );

  it("answers not_built for the commands not built yet, before the database is reached", async () => {
    // Nothing connects: each refusal comes before the database is reached.
    const admin = createAdmin({ url: "postgres://pi_admin:x@127.0.0.1:1/personal", keys, log });
    expect(await codeOf(() => admin.clients.addClient(registration))).toEqual({
      name: "AdminError",
      code: "not_built",
    });
    // Every other check comes first: a registration invalid for another reason says so.
    expect(
      await codeOf(() =>
        admin.clients.addClient({ ...registration, tools: ["get_entity", "draft_message", "request_research"] }),
      ),
    ).toEqual({ name: "AdminError", code: "invalid_registration" });
    expect(
      await codeOf(() =>
        admin.clients.addClient({ ...registration, kind: "reasoner", tools: ["get_entity", "request_research"] }),
      ),
    ).toEqual({ name: "AdminError", code: "invalid_registration" });
    // The control: a tool nothing serves yet is refused as before, as an invalid registration.
    expect(
      await codeOf(() => admin.clients.addClient({ ...registration, tools: ["get_entity", "draft_message"] })),
    ).toEqual({
      name: "AdminError",
      code: "invalid_registration",
    });
    await admin.close();
  });
});
