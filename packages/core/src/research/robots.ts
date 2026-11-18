// robots.txt, read by code. No third-party parser. Only the group for every agent, `User-agent: *`,
// is read, and only its `Disallow` rules: an `Allow` would let more be fetched than the site's wish
// not to be, so it is not read.

const MAX_LINES = 500;
const MAX_RULE = 512;

// The `Disallow` rules of the `User-agent: *` groups, from the file's first 500 lines, each cut to
// its first 512 characters (a shorter prefix refuses more, never less). A group is one or more
// `User-agent` lines and the lines after them, up to the next `User-agent` line that follows a
// rule. Keys are read in any case; a `#` starts a comment. An empty `Disallow` allows all and is
// not kept.
export function robotsDisallow(text: string): string[] {
  const rules: string[] = [];
  let agents: string[] = [];
  let inRules = false;
  for (const raw of text.split(/\r\n|\r|\n/).slice(0, MAX_LINES)) {
    const line = raw.split("#")[0] ?? "";
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value);
      continue;
    }
    inRules = true;
    if (key === "disallow" && value !== "" && agents.includes("*")) rules.push(value.slice(0, MAX_RULE));
  }
  return rules;
}

// Whether a pattern, where `*` matches any run of characters, matches the whole of a text. The
// greedy walk that goes back only to the last `*`: at most the product of the two lengths, never
// the backtracking a regular expression of a site's choosing could cost.
function wholeMatch(pattern: string, text: string): boolean {
  let [p, t, star, mark] = [0, 0, -1, 0];
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === text[t]) [p, t] = [p + 1, t + 1];
    else if (p < pattern.length && pattern[p] === "*") [star, mark, p] = [p, t, p + 1];
    else if (star >= 0) [p, mark, t] = [star + 1, mark + 1, mark + 1];
    else return false;
  }
  while (pattern[p] === "*") p += 1;
  return p === pattern.length;
}

// Whether one rule matches a path (with its query, as sent): by prefix, where `*` matches any run
// of characters and a final `$` anchors the rule at the path's end.
function matches(rule: string, path: string): boolean {
  if (!rule.includes("*") && !rule.endsWith("$")) return path.startsWith(rule);
  return rule.endsWith("$") ? wholeMatch(rule.slice(0, -1), path) : wholeMatch(`${rule}*`, path);
}

// Whether a path may be fetched: no rule matches it. With only `Disallow` rules read, the longest
// match and any match decide alike.
export const robotsAllows = (disallow: readonly string[], path: string): boolean =>
  !disallow.some((rule) => matches(rule, path));
