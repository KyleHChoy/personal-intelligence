import { describe, expect, it } from "vitest";
import { mailAuthOf } from "./mail-auth.ts";

// Fixed header strings, on reserved domains.

const block = (...lines: string[]): string => `${lines.join("\r\n")}\r\n\r\n`;
const FROM = "quinn@example.com";

describe("mailAuthOf", () => {
  it("an aligned DKIM pass is pass", () => {
    expect(
      mailAuthOf(
        block(
          "Authentication-Results: mx.example.net; dkim=pass header.i=@example.com header.s=s1 header.b=abc",
          "From: Quinn <quinn@example.com>",
        ),
        FROM,
      ),
    ).toBe("pass");
    expect(mailAuthOf(block("Authentication-Results: mx.example.net; dkim=pass header.d=example.com"), FROM)).toBe(
      "pass",
    );
  });

  it("an aligned SPF pass and a DMARC pass are pass", () => {
    expect(
      mailAuthOf(
        block(
          "Authentication-Results: mx.example.net; spf=pass (sender is permitted) smtp.mailfrom=bounce@mail.example.com",
        ),
        FROM,
      ),
    ).toBe("pass");
    expect(
      mailAuthOf(
        block("Authentication-Results: mx.example.net; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com"),
        FROM,
      ),
    ).toBe("pass");
  });

  it("a pass for another domain counts as fail", () => {
    expect(
      mailAuthOf(
        block(
          "Authentication-Results: mx.example.net; dkim=pass header.i=@example.org; spf=pass smtp.mailfrom=bounce@example.org",
        ),
        FROM,
      ),
    ).toBe("fail");
    // A domain that only ends in the From domain's letters is another domain.
    expect(mailAuthOf(block("Authentication-Results: mx.example.net; dkim=pass header.d=badexample.com"), FROM)).toBe(
      "fail",
    );
  });

  it("a present header with no pass is fail", () => {
    expect(
      mailAuthOf(
        block(
          "Authentication-Results: mx.example.net; dkim=fail header.d=example.com; spf=softfail smtp.mailfrom=example.com; dmarc=fail header.from=example.com",
        ),
        FROM,
      ),
    ).toBe("fail");
    expect(mailAuthOf(block("Authentication-Results: mx.example.net; none"), FROM)).toBe("fail");
  });

  it("no header is none", () => {
    expect(mailAuthOf(block("From: quinn@example.com", "Subject: hello"), FROM)).toBe("none");
    expect(
      mailAuthOf(block("ARC-Authentication-Results: i=1; mx.example.net; dkim=pass header.d=example.com"), FROM),
    ).toBe("none");
  });

  it("only the topmost header counts: one the sender wrote below it is never read", () => {
    const forged = block(
      "Authentication-Results: mx.example.net; dkim=none; spf=neutral smtp.mailfrom=other.example.org",
      "Authentication-Results: mx.example.net; dkim=pass header.d=example.com",
    );
    expect(mailAuthOf(forged, FROM)).toBe("fail");
  });

  it("reads a folded header and no body", () => {
    expect(
      mailAuthOf(
        block(
          "Authentication-Results: mx.example.net;",
          "\tdkim=pass header.i=@example.com;",
          "\tspf=fail smtp.mailfrom=example.com",
        ),
        FROM,
      ),
    ).toBe("pass");
    expect(
      mailAuthOf("Subject: x\r\n\r\nAuthentication-Results: mx.example.net; dkim=pass header.d=example.com\r\n", FROM),
    ).toBe("none");
  });

  it("a header with no From address is fail", () => {
    expect(mailAuthOf(block("Authentication-Results: mx.example.net; dkim=pass header.d=example.com"), undefined)).toBe(
      "fail",
    );
  });
});
