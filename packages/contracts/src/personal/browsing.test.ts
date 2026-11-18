import {
  AGENT_HOSTS,
  CaptureAccountView,
  CaptureExcludeView,
  ExcludeHost,
  excludeSuffixes,
  isAgentHost,
  isExcluded,
  isSignInHost,
  isSignInUrl,
  LensBrowsingMode,
  LensBrowsingView,
  MappedAccount,
  MappedCompartment,
  SIGN_IN_WORDS,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// Browsing. Synthetic values on reserved domains.

const AT = "2026-10-22T12:00:00Z";
const ULID = "01JB0000000000000000000000";

describe("the mode", () => {
  it("is allow or deny", () => {
    expect(LensBrowsingMode.options).toEqual(["allow", "deny"]);
    expect(LensBrowsingMode.safeParse("all").success).toBe(false);
  });
});

describe("SIGN_IN_WORDS and isSignInHost", () => {
  it("is frozen and holds the sign-in, token, reset and invitation words Lens's pages.rs holds", () => {
    expect(Object.isFrozen(SIGN_IN_WORDS)).toBe(true);
    for (const word of [
      "login",
      "signin",
      "oauth",
      "callback",
      "token",
      "auth",
      "sso",
      "reset",
      "invite",
      "verify",
      "magic-link",
    ])
      expect(SIGN_IN_WORDS).toContain(word);
  });

  it("reads the first label alone, case-folded, with a trailing dot dropped", () => {
    expect(isSignInHost("login.example.com")).toBe(true);
    expect(isSignInHost("Auth.Example.com.")).toBe(true);
    expect(isSignInHost("sso.example.org")).toBe(true);
    expect(isSignInHost("www.example.com")).toBe(false);
    expect(isSignInHost("example.login.com")).toBe(false);
    expect(isSignInHost("logins.example.com")).toBe(false);
  });

  it("knows identity providers' hosts by their first label, and only hosts", () => {
    for (const host of ["accounts.example.com", "account.example.org", "id.example.com", "signup.example.com"])
      expect(isSignInHost(host), host).toBe(true);
    expect(isSignInUrl("https://www.example.com/account/settings")).toBe(false);
    expect(isSignInUrl("https://accounts.example.com/home")).toBe(true);
  });
});

describe("excludeSuffixes and isExcluded", () => {
  it("gives the host and each host above it with a dot, longest first, in the normal form", () => {
    expect(excludeSuffixes("Docs.Bank.Example.com.")).toEqual([
      "docs.bank.example.com",
      "bank.example.com",
      "example.com",
    ]);
    expect(excludeSuffixes("example.com")).toEqual(["example.com"]);
    expect(excludeSuffixes("localhost")).toEqual([]);
  });

  it("matches the host itself and every host under it, never a sibling or a host above", () => {
    const list = ["bank.example.com"];
    expect(isExcluded("bank.example.com", list)).toBe(true);
    expect(isExcluded("www.bank.example.com", list)).toBe(true);
    expect(isExcluded("WWW.Bank.Example.COM.", list)).toBe(true);
    expect(isExcluded("example.com", list)).toBe(false);
    expect(isExcluded("notbank.example.com", list)).toBe(false);
    expect(isExcluded("bank.example.com.test", list)).toBe(false);
  });
});

describe("ExcludeHost", () => {
  it("takes a lower-case host of two labels or more and nothing else", () => {
    for (const host of ["example.com", "bank.example.com", "a-b.example.org"])
      expect(ExcludeHost.safeParse(host).success, host).toBe(true);
    for (const host of [
      "com",
      "Example.com",
      "example.com.",
      "-x.example.com",
      "x-.example.com",
      "exa mple.com",
      "*.example.com",
      "https://example.com",
      "",
    ]) {
      expect(ExcludeHost.safeParse(host).success, host).toBe(false);
    }
  });
});

describe("MappedAccount and MappedCompartment", () => {
  it("takes an account in the normal form only", () => {
    expect(MappedAccount.safeParse("owner@example.com").success).toBe(true);
    expect(MappedAccount.safeParse("Owner@example.com").success).toBe(false);
    expect(MappedAccount.safeParse("owner@example.com.").success).toBe(false);
    expect(MappedAccount.safeParse("owner\t@example.com").success).toBe(false);
    expect(MappedAccount.safeParse("").success).toBe(false);
    expect(MappedAccount.safeParse("a".repeat(321)).success).toBe(false);
  });

  it("labels with own or an employer's compartment, never another", () => {
    for (const ok of ["own", "employer:example"]) expect(MappedCompartment.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["public", "restricted:health", "employer:example-released", "agent:helper", "declassified"])
      expect(MappedCompartment.safeParse(bad).success, bad).toBe(false);
  });
});

describe("isSignInUrl", () => {
  it("reads the host's first label and every path segment, as Lens's pages.rs does", () => {
    expect(isSignInUrl("https://login.example.com/home")).toBe(true);
    expect(isSignInUrl("https://www.example.com/account/Reset/step")).toBe(true);
    expect(isSignInUrl("https://www.example.com/oauth2/callback")).toBe(true);
    expect(isSignInUrl("https://www.example.com/articles/resetting-a-router")).toBe(false);
    expect(isSignInUrl("https://www.example.com/")).toBe(false);
  });

  it("counts a URL that does not parse as one", () => {
    expect(isSignInUrl("not a url")).toBe(true);
  });
});

describe("AGENT_HOSTS and isAgentHost", () => {
  it("is frozen and holds the catalog's agent hosts", () => {
    expect(Object.isFrozen(AGENT_HOSTS)).toBe(true);
    for (const host of ["claude.ai", "chatgpt.com", "chat.openai.com", "gemini.google.com", "perplexity.ai"])
      expect(AGENT_HOSTS).toContain(host);
  });

  it("matches an agent host and the hosts under it, never a host above", () => {
    expect(isAgentHost("claude.ai")).toBe(true);
    expect(isAgentHost("www.ChatGPT.com.")).toBe(true);
    expect(isAgentHost("google.com")).toBe(false);
    expect(isAgentHost("docs.example.com")).toBe(false);
  });
});

describe("the owner's views", () => {
  it("carry ids, counts and compartments, never a value", () => {
    expect(LensBrowsingView.safeParse({ device: "studio-mac", mode: "deny", excludes: 2, accounts: 1 }).success).toBe(
      true,
    );
    expect(
      LensBrowsingView.safeParse({
        device: "studio-mac",
        mode: "deny",
        excludes: 2,
        accounts: 1,
        values: ["bank.example.com"],
      }).success,
    ).toBe(false);
    expect(CaptureExcludeView.safeParse({ id: `cex_${ULID}`, createdAt: AT }).success).toBe(true);
    expect(CaptureExcludeView.safeParse({ id: `cex_${ULID}`, createdAt: AT, value: "bank.example.com" }).success).toBe(
      false,
    );
    expect(
      CaptureAccountView.safeParse({ id: `cac_${ULID}`, compartment: "employer:example", createdAt: AT }).success,
    ).toBe(true);
    expect(CaptureAccountView.safeParse({ id: `csr_${ULID}`, compartment: "own", createdAt: AT }).success).toBe(false);
  });
});
