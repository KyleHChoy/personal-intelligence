import { describe, expect, it } from "vitest";
import { checkRole, type Role } from "./env.ts";

// Who may hold what, for every role and every name the rule covers. This is the credentials rule
// written out by hand: the table in the code must agree with it, name by name, so a change to the
// table that widens a role fails here.
const ROLES: readonly Role[] = [
  "none",
  "bootstrap",
  "admin",
  "writer",
  "reader",
  "work",
  "pipeline",
  "proxy",
  "adapter",
  "restricted",
  "notify",
];

const url = (own: Role): readonly Role[] => [own, "none", "bootstrap"];
const MAY_HOLD: Record<string, readonly Role[]> = {
  PI_DATABASE_URL_BOOTSTRAP: ["none", "bootstrap"],
  PI_DATABASE_URL_ADMIN: url("admin"),
  PI_DATABASE_URL_WRITER: url("writer"),
  PI_DATABASE_URL_READER: url("reader"),
  PI_DATABASE_URL_WORK: url("work"),
  PI_DATABASE_URL_PIPELINE: url("pipeline"),
  PI_DATABASE_URL_RESTRICTED: url("restricted"),
  PI_DATABASE_URL_PROXY: ["proxy"],
  PI_DATABASE_URL_NOTIFY: ["notify"],
  PI_EXTRACT_ANTHROPIC_KEY: ["pipeline"],
  PI_SEND_GOOGLE_CLIENT_SECRET: ["proxy"],
  PI_GOOGLE_CLIENT_SECRET: ["none", "bootstrap", "admin", "writer", "work", "pipeline", "restricted"],
  PI_CLIENT_TOKEN: ["none", "bootstrap", "writer", "reader", "work", "pipeline", "restricted"],
  PI_KEY_FILE: ["none", "bootstrap", "admin", "writer", "reader", "pipeline", "proxy", "restricted"],
  PI_RESTRICTED_KEY_FILE: ["none", "bootstrap", "admin", "writer", "reader", "work", "proxy", "adapter", "restricted"],
  PI_REASONER_MODEL_KEY: [],
  PI_OPENROUTER_KEY: [],
};

const refused = (role: Role, env: Record<string, string>, modelKey = false): boolean => {
  try {
    checkRole(role, env, { modelKey });
    return false;
  } catch (error) {
    expect((error as { code?: string }).code).toBe("wrong_role_url");
    return true;
  }
};

describe("what a command's role may hold", () => {
  it("refuses each name for every role but the ones that may hold it", () => {
    const wrong: string[] = [];
    for (const [name, may] of Object.entries(MAY_HOLD))
      for (const role of ROLES)
        if (refused(role, { [name]: "set" }) === may.includes(role))
          wrong.push(`${role} ${may.includes(role) ? "refuses" : "holds"} ${name}`);
    expect(wrong).toEqual([]);
  });

  it("reads an empty variable as an unset one", () => {
    for (const name of Object.keys(MAY_HOLD))
      for (const role of ROLES) expect(refused(role, { [name]: "" }), `${role} ${name}`).toBe(false);
  });

  it("lets only the importing command hold the OpenRouter key, whatever its role", () => {
    for (const role of ROLES) expect(refused(role, { PI_OPENROUTER_KEY: "set" }, true), role).toBe(false);
    // The flag is for that key alone.
    expect(refused("admin", { PI_REASONER_MODEL_KEY: "set" }, true)).toBe(true);
    expect(refused("admin", { PI_DATABASE_URL_WRITER: "set" }, true)).toBe(true);
  });

  it("the roles that hold one URL refuse any other by its prefix, one no table names among them", () => {
    const unnamed = { PI_DATABASE_URL_HARNESS: "set" };
    for (const role of ["work", "proxy", "notify", "adapter"] as const) expect(refused(role, unnamed), role).toBe(true);
    for (const role of ["none", "bootstrap", "admin", "writer", "reader", "pipeline", "restricted"] as const)
      expect(refused(role, unnamed), role).toBe(false);
  });

  it("no pi command holds the outcome test's model key, which the entrypoint may default to the reasoner's", () => {
    for (const role of ROLES) expect(refused(role, { PI_OUTCOME_TEST_MODEL_KEY: "set" }), role).toBe(true);
  });

  it("no pi command holds the dead-man check's URL, which only the timer reads", () => {
    for (const role of ROLES) expect(refused(role, { PI_HEARTBEAT_URL: "set" }), role).toBe(true);
  });
});
