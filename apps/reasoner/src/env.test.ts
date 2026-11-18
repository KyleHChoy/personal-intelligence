import { describe, expect, it } from "vitest";
import { assertNoDataAccess, Refusal, requireEnv } from "./env.ts";

const OWN = {
  PATH: "/usr/bin:/bin",
  PI_AGENT_API_COMMAND: "/usr/bin/true",
  PI_REASONER_MODEL: "vendor/model",
  PI_REASONER_MODEL_KEY: "sk-synthetic",
};

const refusedWith = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof Refusal) return error.code;
    throw error;
  }
  return undefined;
};

describe("the reasoner's environment", () => {
  const REFUSED = [
    "PGHOST",
    "PGUSER",
    "PGPASSWORD",
    "PGDATABASE",
    "PGPASSFILE",
    "PGSERVICEFILE",
    "PI_DATABASE_URL_READER",
    "PI_DATABASE_URL_WORK",
    "PI_DATABASE_URL_ADMIN",
    "DATABASE_URL",
    "PI_KEY_FILE",
    "PI_ERASURE_JOURNAL",
    "PI_GOOGLE_CLIENT_SECRET",
    "PI_CLIENT_TOKEN",
  ];

  it("the reasoner refuses each database setting, the key file, the journal path, a Google client secret and a client token", () => {
    for (const name of REFUSED) {
      expect(
        refusedWith(() => assertNoDataAccess({ ...OWN, [name]: "x" })),
        name,
      ).toBe("wrong_role_url");
    }
  });

  it("the reasoner refuses a Postgres connection URL under any variable name", () => {
    for (const value of ["postgres://u:p@h/db", "postgresql://u:p@h:5432/db", "  POSTGRESQL://h/db", "PostgreS://h"]) {
      expect(
        refusedWith(() => assertNoDataAccess({ ...OWN, SOME_OTHER_SETTING: value })),
        value,
      ).toBe("wrong_role_url");
    }
  });

  it("a value that only mentions postgres is not a connection URL", () => {
    expect(
      refusedWith(() => assertNoDataAccess({ ...OWN, NOTE: "uses postgres", LINK: "https://postgres.example/x" })),
    ).toBeUndefined();
  });

  it("an environment of the path and the reasoner's own variables passes", () => {
    expect(refusedWith(() => assertNoDataAccess(OWN))).toBeUndefined();
  });

  it("a name set to the empty string is an unset one", () => {
    expect(refusedWith(() => assertNoDataAccess({ ...OWN, PGPASSWORD: "", PI_CLIENT_TOKEN: "" }))).toBeUndefined();
  });

  it("the refusal carries no value", () => {
    try {
      assertNoDataAccess({ ...OWN, PI_DATABASE_URL_READER: "postgres://u:secret-password@h/db" });
      expect.unreachable();
    } catch (error) {
      expect(JSON.stringify({ message: (error as Error).message, hint: (error as Refusal).hint })).not.toContain(
        "secret-password",
      );
    }
  });

  it("requireEnv names the first unset variable, never a value", () => {
    try {
      requireEnv({ PI_REASONER_MODEL: "vendor/model", PI_REASONER_MODEL_KEY: "" }, [
        "PI_REASONER_MODEL",
        "PI_REASONER_MODEL_KEY",
      ]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Refusal);
      expect((error as Refusal).code).toBe("missing_env");
      expect((error as Refusal).hint).toBe("set PI_REASONER_MODEL_KEY");
      expect(JSON.stringify((error as Refusal).hint)).not.toContain("vendor/model");
    }
    expect(requireEnv(OWN, ["PI_REASONER_MODEL", "PI_REASONER_MODEL_KEY"])).toEqual({
      PI_REASONER_MODEL: "vendor/model",
      PI_REASONER_MODEL_KEY: "sk-synthetic",
    });
  });
});
