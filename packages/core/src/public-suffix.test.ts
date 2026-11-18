import { describe, expect, it } from "vitest";
import { parseSuffixRules, publicSuffixRules, registrableDomain, registrableDomainIn } from "./public-suffix.ts";

// The list's own test cases (https://github.com/publicsuffix/list/blob/main/tests/tests.txt,
// dedicated to the public domain), all but the commented-out `.local` ones and the null input,
// run against the vendored list: host, then its registrable domain or null.
const CASES: [string, string | null][] = [
  // Mixed case.
  ["COM", null],
  ["example.COM", "example.com"],
  ["WwW.example.COM", "example.com"],
  // Leading dot.
  [".com", null],
  [".example", null],
  [".example.com", null],
  [".example.example", null],
  // Unlisted TLD.
  ["example", null],
  ["example.example", "example.example"],
  ["b.example.example", "example.example"],
  ["a.b.example.example", "example.example"],
  // TLD with only 1 rule.
  ["biz", null],
  ["domain.biz", "domain.biz"],
  ["b.domain.biz", "domain.biz"],
  ["a.b.domain.biz", "domain.biz"],
  // TLD with some 2-level rules.
  ["com", null],
  ["example.com", "example.com"],
  ["b.example.com", "example.com"],
  ["a.b.example.com", "example.com"],
  ["uk.com", null],
  ["example.uk.com", "example.uk.com"],
  ["b.example.uk.com", "example.uk.com"],
  ["a.b.example.uk.com", "example.uk.com"],
  ["test.ac", "test.ac"],
  // TLD with only 1 (wildcard) rule.
  ["mm", null],
  ["c.mm", null],
  ["b.c.mm", "b.c.mm"],
  ["a.b.c.mm", "b.c.mm"],
  // More complex TLD.
  ["jp", null],
  ["test.jp", "test.jp"],
  ["www.test.jp", "test.jp"],
  ["ac.jp", null],
  ["test.ac.jp", "test.ac.jp"],
  ["www.test.ac.jp", "test.ac.jp"],
  ["kyoto.jp", null],
  ["test.kyoto.jp", "test.kyoto.jp"],
  ["ide.kyoto.jp", null],
  ["b.ide.kyoto.jp", "b.ide.kyoto.jp"],
  ["a.b.ide.kyoto.jp", "b.ide.kyoto.jp"],
  ["c.kobe.jp", null],
  ["b.c.kobe.jp", "b.c.kobe.jp"],
  ["a.b.c.kobe.jp", "b.c.kobe.jp"],
  ["city.kobe.jp", "city.kobe.jp"],
  ["www.city.kobe.jp", "city.kobe.jp"],
  // TLD with a wildcard rule and exceptions.
  ["ck", null],
  ["test.ck", null],
  ["b.test.ck", "b.test.ck"],
  ["a.b.test.ck", "b.test.ck"],
  ["www.ck", "www.ck"],
  ["www.www.ck", "www.ck"],
  // US K12.
  ["us", null],
  ["test.us", "test.us"],
  ["www.test.us", "test.us"],
  ["ak.us", null],
  ["test.ak.us", "test.ak.us"],
  ["www.test.ak.us", "test.ak.us"],
  ["k12.ak.us", null],
  ["test.k12.ak.us", "test.k12.ak.us"],
  ["www.test.k12.ak.us", "test.k12.ak.us"],
  // IDN labels.
  ["食狮.com.cn", "食狮.com.cn"],
  ["食狮.公司.cn", "食狮.公司.cn"],
  ["www.食狮.公司.cn", "食狮.公司.cn"],
  ["shishi.公司.cn", "shishi.公司.cn"],
  ["公司.cn", null],
  ["食狮.中国", "食狮.中国"],
  ["www.食狮.中国", "食狮.中国"],
  ["shishi.中国", "shishi.中国"],
  ["中国", null],
  // Same as above, but punycoded.
  ["xn--85x722f.com.cn", "xn--85x722f.com.cn"],
  ["xn--85x722f.xn--55qx5d.cn", "xn--85x722f.xn--55qx5d.cn"],
  ["www.xn--85x722f.xn--55qx5d.cn", "xn--85x722f.xn--55qx5d.cn"],
  ["shishi.xn--55qx5d.cn", "shishi.xn--55qx5d.cn"],
  ["xn--55qx5d.cn", null],
  ["xn--85x722f.xn--fiqs8s", "xn--85x722f.xn--fiqs8s"],
  ["www.xn--85x722f.xn--fiqs8s", "xn--85x722f.xn--fiqs8s"],
  ["shishi.xn--fiqs8s", "shishi.xn--fiqs8s"],
  ["xn--fiqs8s", null],
];

describe("registrableDomain", () => {
  it("answers the public suffix list's own test cases", () => {
    for (const [host, expected] of CASES) expect(registrableDomain(host), host).toBe(expected);
  });

  it("folds the subdomains of a synthetic organization, and of a two-level suffix, to one domain", () => {
    expect(registrableDomain("mail.lab.example.org")).toBe("example.org");
    expect(registrableDomain("mail.alder.test")).toBe("alder.test");
    expect(registrableDomain("mail.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("co.uk")).toBeNull();
    expect(registrableDomain("a..example.org")).toBeNull();
  });

  it("reads the vendored list's two sections", () => {
    const rules = publicSuffixRules();
    // One ICANN rule, one private one, one wildcard and one exception.
    expect(rules.exact.has("co.uk")).toBe(true);
    expect(rules.exact.has("github.io")).toBe(true);
    expect(rules.wildcard.has("ck")).toBe(true);
    expect(rules.exception.has("www.ck")).toBe(true);
  });
});

describe("parseSuffixRules", () => {
  it("takes the first word of each line that is no comment, in ASCII form", () => {
    const rules = parseSuffixRules(
      "// a comment\nalpha\n  beta.alpha  trailing words\n*.gamma\n!keep.gamma\n公司.cn\n\n",
    );
    expect([...rules.exact].sort()).toEqual(["alpha", "beta.alpha", "xn--55qx5d.cn"]);
    expect([...rules.wildcard]).toEqual(["gamma"]);
    expect([...rules.exception]).toEqual(["keep.gamma"]);
    expect(registrableDomainIn(rules, "x.y.beta.alpha")).toBe("y.beta.alpha");
    expect(registrableDomainIn(rules, "x.y.gamma")).toBe("x.y.gamma");
    expect(registrableDomainIn(rules, "y.gamma")).toBeNull();
    expect(registrableDomainIn(rules, "a.keep.gamma")).toBe("keep.gamma");
  });
});
