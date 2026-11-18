// Whether a message authenticates for its From domain, read from its `Authentication-Results`
// header (RFC 8601). `pass`: an aligned DKIM, SPF or DMARC pass; `fail`: the header is there and
// holds none; `none`: no such header. Only the topmost one is read, the one the receiving server
// added last: a header the sender wrote below it is the sender's word, untrusted evidence, and
// never counts. Alignment is relaxed: the passing domain is the From domain, or one is a subdomain
// of the other. Nothing else of the header is kept.

export type MailAuth = "pass" | "fail" | "none";

const HEADER = "authentication-results";

// The header block's lines, each folded continuation joined to the line it continues.
function unfolded(block: string): string[] {
  const lines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line === "") break;
    if (/^[ \t]/.test(line) && lines.length > 0) lines[lines.length - 1] += ` ${line.trim()}`;
    else lines.push(line);
  }
  return lines;
}

// The topmost Authentication-Results value, or undefined.
function topmost(block: string): string | undefined {
  for (const line of unfolded(block)) {
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === HEADER) return line.slice(colon + 1);
  }
  return undefined;
}

const domainOf = (value: string): string => {
  const at = value.lastIndexOf("@");
  return (at < 0 ? value : value.slice(at + 1)).replace(/^<|>$/g, "").replace(/\.$/, "").toLowerCase();
};

const aligned = (from: string, domain: string): boolean =>
  domain !== "" && (domain === from || from.endsWith(`.${domain}`) || domain.endsWith(`.${from}`));

// Which property of each method names the domain it passed for.
const PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  dkim: ["header.d", "header.i"],
  spf: ["smtp.mailfrom", "smtp.helo"],
  dmarc: ["header.from"],
};

// `block` is the message's header block; `from` its From address, when it has one.
export function mailAuthOf(block: string, from: string | undefined): MailAuth {
  const value = topmost(block);
  if (value === undefined) return "none";
  if (from === undefined || !from.includes("@")) return "fail";
  const fromDomain = domainOf(from);
  // Comments in parentheses say nothing a result rests on (RFC 8601 section 2.2).
  const results = value
    .replace(/\([^()]*\)/g, " ")
    .split(";")
    .slice(1);
  for (const result of results) {
    const method = /^\s*(dkim|spf|dmarc)\s*=\s*([a-z]+)/i.exec(result);
    if (method === null || method[2]?.toLowerCase() !== "pass") continue;
    const names = PROPERTIES[(method[1] as string).toLowerCase()] ?? [];
    for (const match of result.matchAll(/([a-z]+\.[a-z]+)\s*=\s*("?)([^\s";]+)\2/gi)) {
      const [, name, , said] = match;
      if (
        name !== undefined &&
        said !== undefined &&
        names.includes(name.toLowerCase()) &&
        aligned(fromDomain, domainOf(said))
      )
        return "pass";
    }
  }
  return "fail";
}
