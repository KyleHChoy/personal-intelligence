import { describe, expect, it } from "vitest";
import type { GoogleDeps, TokenSource } from "./index.ts";
import * as root from "./index.ts";

// The two names that are types only, checked by the type check.
const deps: GoogleDeps = { timeoutMs: 1000 };
const tokens: TokenSource = { accessToken: async () => "fake-access-token", invalidate: () => {} };

describe("the package root", () => {
  it("every name of the package's interface is exported from the package root", () => {
    const functions = [
      "createGoogleHttp",
      "pkcePair",
      "pkceChallenge",
      "buildAuthUrl",
      "listenForCode",
      "exchangeCode",
      "tokenSource",
      "gmailProfile",
      "gmailSendAs",
      "createGoogleConnector",
      "createPeopleConnector",
      "driveAbout",
      "driveFolder",
      "scopesFor",
      "grantedScopesFor",
      "createTiesReader",
    ] as const;
    // biome-ignore lint/performance/noDynamicNamespaceImportAccess: the test checks each export by its name, and a test bundle is never tree-shaken
    for (const name of functions) expect(typeof root[name], name).toBe("function");
    expect(new root.GoogleError("bad_cursor")).toBeInstanceOf(Error);
    expect(root.GOOGLE_SCOPES).toHaveLength(2);
    expect(root.MAX_ANSWER_BYTES).toBe(4 * 1024 * 1024);
    expect(root.MAX_DOCUMENT_ANSWER_BYTES).toBe(8 * 1024 * 1024);
    expect(root.createGoogleHttp({ tokens, deps })).toHaveProperty("send");

    // Nothing else: the cursor codec and the helpers stay internal.
    expect(root.PEOPLE_PAGE_SIZE).toBe(1000);
    expect(Object.keys(root).sort()).toEqual(
      [
        ...functions,
        "GoogleError",
        "GOOGLE_SCOPES",
        "MAX_ANSWER_BYTES",
        "MAX_DOCUMENT_ANSWER_BYTES",
        "PEOPLE_FIELDS",
        "PEOPLE_PAGE_SIZE",
        "TIES_MS_PER_MESSAGE",
      ].sort(),
    );
  });
});
