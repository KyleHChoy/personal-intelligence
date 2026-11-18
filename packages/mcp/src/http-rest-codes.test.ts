import { CLAIM_REFUSAL_HINTS, type PersonalToolError } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createRoutes } from "./http.ts";
import { AT_ONCE, clientView, fakeLog, fakeProvider, NO_WORK, TOKEN, ulid } from "./test-support/fakes.ts";

// How REST answers each code a tool can answer: its status, and whether the hint rides along. The
// same answer whichever port said it.

const ENTITY = `ent_${ulid(9)}`;
const HOLDER = clientView({ tools: ["get_self"], views: ["self"] });
const EXPECTED: Record<PersonalToolError, { status: number; error: string; hint: boolean }> = {
  unauthorized: { status: 403, error: "not_permitted", hint: true },
  not_permitted: { status: 403, error: "not_permitted", hint: true },
  invalid_request: { status: 400, error: "invalid_request", hint: true },
  not_found: { status: 404, error: "not_found", hint: true },
  unavailable: { status: 503, error: "unavailable", hint: false },
  rate_limited: { status: 429, error: "rate_limited", hint: true },
  stale_cursor: { status: 409, error: "stale_cursor", hint: true },
  unsupported_template: { status: 406, error: "unsupported_template", hint: true },
  unknown_role: { status: 422, error: "unknown_role", hint: true },
};

describe("REST's answer to each code", () => {
  it("documents unknown_role's 422 response", async () => {
    const { provider } = fakeProvider(clientView({ tools: ["hand_off"], views: ["work"] }));
    const routes = createRoutes({ provider, work: NO_WORK }, fakeLog().log, AT_ONCE);
    const answer = await routes({
      method: "GET",
      path: "/openapi.json",
      address: "203.0.113.1",
      authorization: `Bearer ${TOKEN}`,
      body: "",
    });
    const spec = JSON.parse(answer.body);
    expect(spec.paths["/v1/tools/hand_off"].post.responses["422"]).toBeDefined();
  });
  for (const [code, expected] of Object.entries(EXPECTED)) {
    it(`${code} is ${expected.status}`, async () => {
      const { provider } = fakeProvider(HOLDER, {
        getSelf: async () => ({ ok: false, code: code as PersonalToolError }),
      });
      const routes = createRoutes({ provider, work: NO_WORK }, fakeLog().log, AT_ONCE);
      const answer = await routes({
        method: "POST",
        path: "/v1/tools/get_self",
        address: "203.0.113.1",
        authorization: `Bearer ${TOKEN}`,
        body: "{}",
      });
      const body = JSON.parse(answer.body) as { error: string; hint?: string };
      expect(answer.status).toBe(expected.status);
      expect(body.error).toBe(expected.error);
      expect(typeof body.hint === "string").toBe(expected.hint);
    });
  }

  it("a call the tool's schema refuses names the argument", async () => {
    const { provider } = fakeProvider(HOLDER);
    const routes = createRoutes({ provider, work: NO_WORK }, fakeLog().log, AT_ONCE);
    const answer = await routes({
      method: "POST",
      path: "/v1/tools/get_self",
      address: "203.0.113.1",
      authorization: `Bearer ${TOKEN}`,
      body: '{"nope":1}',
    });
    const body = JSON.parse(answer.body) as { error: string; arguments: { name: string }[]; hint: string };
    expect(answer.status).toBe(400);
    expect(body.arguments.map((one) => one.name)).toEqual(["nope"]);
    expect(typeof body.hint).toBe("string");
  });

  // An id in prose is refused as any call is: 400 with its code, the field that held the id, and
  // the hint that says names go in prose and ids in refs and cites.
  it("an id in a record's body is refused ids_in_prose with the field and its hint", async () => {
    const writer = clientView({ tools: ["record"], views: ["self"] });
    const { provider, calls } = fakeProvider(writer);
    const routes = createRoutes({ provider, work: NO_WORK }, fakeLog().log, AT_ONCE);
    const answer = await routes({
      method: "POST",
      path: "/v1/tools/record",
      address: "203.0.113.1",
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify({
        kind: "finding",
        body: `The owner met ${ENTITY} on 2026-10-20.`,
        requestId: "rest-ids-0001",
      }),
    });
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body)).toEqual({
      error: "invalid_request",
      refusal: "ids_in_prose",
      field: "body",
      hint: expect.stringContaining(CLAIM_REFUSAL_HINTS.ids_in_prose),
    });
    expect(answer.body).not.toContain(ENTITY);
    expect(calls.map((one) => one.method)).not.toContain("record");
  });

  // The older shape an agent may still try: a key the published schema lacks is named, and the
  // hint says what the call takes.
  it("a propose_about_you call in an older shape names the key and says to send statement", async () => {
    const proposer = clientView({ tools: ["propose_about_you"], views: ["self"] });
    const { provider } = fakeProvider(proposer);
    const routes = createRoutes({ provider, work: NO_WORK }, fakeLog().log, AT_ONCE);
    const answer = await routes({
      method: "POST",
      path: "/v1/tools/propose_about_you",
      address: "203.0.113.1",
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify({ kind: "preference", what: "Meetings before 10am", requestId: "rest-old-0001" }),
    });
    const body = JSON.parse(answer.body) as { error: string; arguments: { name: string }[]; hint: string };
    expect(answer.status).toBe(400);
    expect(body.arguments.map((one) => one.name)).toContain("what");
    expect(body.hint).toContain("statement is the one fact about the owner in your words");
  });
});
