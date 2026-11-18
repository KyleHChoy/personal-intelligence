import type { ContactCandidate } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { revealedContacts } from "./disclosure.ts";

// Pure.

const maren: ContactCandidate = {
  id: "con_1",
  names: ["Maren Holt", "Mare"],
  phones: ["+1 555 555 0101", "5550102"],
  organizations: [
    { name: "Holt Ceramics Studio", title: "Founder and principal" },
    { name: "Kilnworks Cooperative", title: null },
  ],
  birthday: { month: 3, day: 14 },
};

const check = (
  body: string,
  candidates: ContactCandidate[] = [maren],
  released: Parameters<typeof revealedContacts>[0]["released"] = [],
  subject = "Hello",
) => revealedContacts({ subject, body, candidates, released });

describe("revealedContacts", () => {
  it("a phone in the body with spaces and dashes is revealed, with field phone and its index", () => {
    expect(check("Call her on 555-555-0101 tomorrow.")).toEqual([{ id: "con_1", field: "phone", index: 0 }]);
    expect(check("Call (555) 555 01 01.")).toEqual([{ id: "con_1", field: "phone", index: 0 }]);
    expect(check("Her other line is 555.0102")).toEqual([{ id: "con_1", field: "phone", index: 1 }]);
    // With a country code before it.
    expect(check("+1 (555) 555-0101")).toEqual([{ id: "con_1", field: "phone", index: 0 }]);
  });

  it("a phone of 6 digits ties nothing", () => {
    const short = { ...maren, phones: ["555 010"] };
    expect(check("ring 555010 now", [short])).toEqual([]);
  });

  it("a phone number ties with no name in the text", () => {
    expect(check("The number is 5555550101")).toEqual([{ id: "con_1", field: "phone", index: 0 }]);
  });

  it("an organization of 12 code points beside the contact's name ties, and the same text without the name does not", () => {
    // Named Maren alone, so the organization's own words name nobody.
    const twelve = { ...maren, names: ["Maren"], organizations: [{ name: "Holt Ceramic", title: null }] };
    expect([..."holt ceramic"].length).toBe(12);
    expect(check("Maren is at Holt Ceramic now.", [twelve])).toEqual([
      { id: "con_1", field: "organization", index: 0 },
    ]);
    expect(check("Someone is at Holt Ceramic now.", [twelve])).toEqual([]);
  });

  it("an organization of 11 code points beside the name does not tie", () => {
    const eleven = { ...maren, names: ["Maren"], organizations: [{ name: "Holt Cerami", title: null }] };
    expect(check("Maren is at Holt Cerami now.", [eleven])).toEqual([]);
  });

  it("a title ties beside the name, with the index of its organization", () => {
    expect(check("Maren Holt, founder and principal")).toEqual([{ id: "con_1", field: "title", index: 0 }]);
    expect(check("Maren moved to Kilnworks Cooperative")).toEqual([{ id: "con_1", field: "organization", index: 1 }]);
  });

  it("a birthday as month name and day beside the contact's name ties in either order, and in figures does not", () => {
    const birthday = [{ id: "con_1", field: "birthday", index: null }];
    expect(check("Maren turns a year older on March 14.")).toEqual(birthday);
    expect(check("Maren's party is the 14th of March")).toEqual([]);
    expect(check("Maren's party: 14th March")).toEqual(birthday);
    expect(check("Maren, mar 14th")).toEqual(birthday);
    expect(check("Maren on 3/14")).toEqual([]);
    expect(check("Maren on 14.03")).toEqual([]);
  });

  it("a birthday beside another person's name ties nothing", () => {
    expect(check("Ivo turns a year older on March 14.")).toEqual([]);
  });

  it("a word of a name of 4 code points ties and one of 3 does not", () => {
    const ivo = { ...maren, names: ["Ivo Lund"] };
    expect(check("Lund turns a year older on March 14.", [ivo])).toEqual([
      { id: "con_1", field: "birthday", index: null },
    ]);
    expect(check("Ivo turns a year older on March 14.", [ivo])).toEqual([]);
    // A whole name ties, as whole tokens.
    expect(check("ivo lund, March 14", [ivo])).toEqual([{ id: "con_1", field: "birthday", index: null }]);
  });

  it("a contact with no name word of 4 code points ties by phone alone", () => {
    const ek = { ...maren, names: ["Al Ek"] };
    expect(check("Al Ek, founder and principal, March 14, 555 555 0101", [ek])).toEqual([
      { id: "con_1", field: "phone", index: 0 },
    ]);
  });

  it("mark beside the title does not tie inside marked", () => {
    const mark = { ...maren, names: ["Mark Ode"], organizations: [{ name: null, title: "Head of research" }] };
    expect(check("She marked the head of research post as filled", [mark])).toEqual([]);
    expect(check("Mark, head of research", [mark])).toEqual([{ id: "con_1", field: "title", index: 0 }]);
    // "maren's" holds the token "maren".
    expect(check("maren's title is founder and principal")).toEqual([{ id: "con_1", field: "title", index: 0 }]);
  });

  it("March 3 does not tie March 30", () => {
    const third = { ...maren, birthday: { month: 3, day: 3 } };
    expect(check("Maren, March 30", [third])).toEqual([]);
    expect(check("Maren, March 3", [third])).toEqual([{ id: "con_1", field: "birthday", index: null }]);
    expect(check("Maren, 3rd March", [third])).toEqual([{ id: "con_1", field: "birthday", index: null }]);
  });

  it("a phone followed, past a separator, by another number still ties", () => {
    const phone = [{ id: "con_1", field: "phone", index: 0 }];
    expect(check("My cell is 555-555-0101.\n10am works?")).toEqual(phone);
    expect(check("call 555-555-0101 2 times")).toEqual(phone);
    expect(check("call 555\u2013555\u20130101 today")).toEqual(phone);
    expect(check("call 555/555/0101 today")).toEqual(phone);
  });

  it("a 7-digit tail inside a longer number followed by digits does not tie", () => {
    expect(check("Order 55555501019 shipped")).toEqual([]);
    expect(check("Order 5555550101, shipped")).toEqual([{ id: "con_1", field: "phone", index: 0 }]);
  });

  it("a released field is not returned, and an unreleased one beside it still is", () => {
    const body = "Maren Holt, founder and principal, 555 555 0101";
    expect(check(body)).toEqual([
      { id: "con_1", field: "phone", index: 0 },
      { id: "con_1", field: "title", index: 0 },
    ]);
    expect(check(body, [maren], [{ id: "con_1", field: "phone", index: 0 }])).toEqual([
      { id: "con_1", field: "title", index: 0 },
    ]);
    // Another contact's release, or another index, releases nothing here.
    expect(check(body, [maren], [{ id: "con_other", field: "phone", index: 0 }])).toHaveLength(2);
    expect(check(body, [maren], [{ id: "con_1", field: "phone", index: 1 }])).toHaveLength(2);
  });

  it("the subject is read with the body", () => {
    expect(check("nothing here", [maren], [], "Maren: March 14")).toEqual([
      { id: "con_1", field: "birthday", index: null },
    ]);
  });

  it("what is returned holds no value", () => {
    const result = check("Maren Holt, founder and principal, Holt Ceramics Studio, March 14, 555 555 0101 and 5550102");
    expect(result).toHaveLength(5);
    for (const one of result) expect(Object.keys(one).sort()).toEqual(["field", "id", "index"]);
    const printed = JSON.stringify(result);
    for (const value of ["Maren", "Holt", "Founder", "555", "March"])
      expect(printed.toLowerCase()).not.toContain(value.toLowerCase());
  });

  it("a candidate that does not parse throws, so the caller's check fails and never passes", () => {
    expect(() => check("Maren", [{ ...maren, birthday: { month: 13, day: 1 } }])).toThrow();
  });

  // A link ties by its host and path, however the draft writes its scheme, `www.` or
  // case, with no name beside it; a link of under twelve code points ties nothing.
  it("a link in the text ties with no name, whatever its scheme or www., and a short one does not", () => {
    const linked: ContactCandidate = {
      ...maren,
      links: ["https://linkedin.com/in/maren-holt-example", "https://mh.example"],
    };
    expect(check("See https://www.LinkedIn.com/in/Maren-Holt-Example/ for more.", [linked])).toEqual([
      { id: "con_1", field: "link", index: 0 },
    ]);
    expect(check("Her page: linkedin.com/in/maren-holt-example", [linked])).toEqual([
      { id: "con_1", field: "link", index: 0 },
    ]);
    expect(check("Try mh.example today.", [linked])).toEqual([]);
    expect(check("linkedin.com/in/someone-else", [linked])).toEqual([]);
    expect(
      check("See linkedin.com/in/maren-holt-example", [linked], [{ id: "con_1", field: "link", index: 0 }]),
    ).toEqual([]);
  });

  // Whole links only, and a host alone only beside the name.
  it("a link ties only as a whole link: not inside a longer path, a subdomain or an address", () => {
    const at = (links: string[]): ContactCandidate[] => [{ ...maren, names: ["Ines Varga"], links }];
    expect(check("See github.com/janet-other", at(["https://github.com/jane"]))).toEqual([]);
    expect(check("See linkedin.com/in/john-smith", at(["https://linkedin.com/in/jo"]))).toEqual([]);
    expect(check("Read foo.substack.com/p/1", at(["https://substack.com/p/1"]))).toEqual([]);
    for (const text of [
      "See github.com/jane.",
      "See (https://github.com/jane)",
      "github.com/jane/repo",
      "See github.com/jane?tab=1",
    ]) {
      expect(check(text, at(["https://github.com/jane"])), text).toEqual([{ id: "con_1", field: "link", index: 0 }]);
    }
  });

  // A link ends wherever a path does not go on.
  it("a link ties whatever markup or punctuation closes it, and a folded host's subdomain ties its link", () => {
    const at = (links: string[]): ContactCandidate[] => [{ ...maren, names: ["Ines Varga"], links }];
    const jane = at(["https://github.com/jane"]);
    for (const text of [
      "**github.com/jane**",
      "`github.com/jane`",
      "_github.com/jane_",
      "~~github.com/jane~~",
      "“github.com/jane”",
      "‘github.com/jane’",
      "«github.com/jane»",
      "github.com/jane—her code",
      "github.com/jane…",
      "github.com/jane...",
      "github.com/jane。",
      "| github.com/jane |",
      "*github.com/jane*",
      "github.com/jane&more",
      "github.com/jane=x",
      "[code](https://github.com/jane)",
      "See github.com/jane, then",
      "See GITHUB.COM/JANE.",
      "http://www.github.com/jane/",
      "github.com/jane#readme",
      "github.com/jane?tab=1",
      "<github.com/jane>",
      "github.com/​jane",
    ]) {
      expect(check(text, jane), text).toEqual([{ id: "con_1", field: "link", index: 0 }]);
    }
    for (const text of [
      "github.com/jane_doe",
      "github.com/jane.example",
      "github.com/jane-doe-example",
      "github.com/jane%20doe",
      "github.com/janet",
    ])
      expect(check(text, jane), text).toEqual([]);
    const linkedin = at(["https://linkedin.com/in/maren-holt-example"]);
    for (const text of [
      "uk.linkedin.com/in/maren-holt-example",
      "https://m.linkedin.com/in/maren-holt-example/",
      "https://de.linkedin.com/in/maren-holt-example?trk=1",
    ]) {
      expect(check(text, linkedin), text).toEqual([{ id: "con_1", field: "link", index: 0 }]);
    }
    expect(check("https://mobile.twitter.com/maren_h_example", at(["https://x.com/maren_h_example"]))).toEqual([
      { id: "con_1", field: "link", index: 0 },
    ]);
    expect(check("x.com/maren_h_example", at(["https://mobile.twitter.com/maren_h_example"]))).toEqual([
      { id: "con_1", field: "link", index: 0 },
    ]);
  });

  // Text in a language written without spaces sits flush against a link on either side.
  it("a link flush against Han, Hiragana, Katakana or Hangul text ties", () => {
    const at = (links: string[]): ContactCandidate[] => [{ ...maren, names: ["Ines Varga"], links }];
    const jane = at(["https://linkedin.com/in/jane-doe-example"]);
    for (const text of [
      "詳細はlinkedin.com/in/jane-doe-example",
      "linkedin.com/in/jane-doe-exampleさん",
      "linkedin.com/in/jane-doe-example은",
      "プロフィールhttps://www.linkedin.com/in/jane-doe-exampleです",
    ]) {
      expect(check(text, jane), text).toEqual([{ id: "con_1", field: "link", index: 0 }]);
    }
    expect(check("linkedin.com/in/jane-doe-examplex", jane)).toEqual([]);
    // A path that ends in such a letter goes on with another.
    expect(check("x.com/山田太郎", at(["https://x.com/山田"]))).toEqual([]);
  });

  it("a port is left out only right after a host, never a `:` inside a path", () => {
    const at = (links: string[]): ContactCandidate[] => [{ ...maren, names: ["Ines Varga"], links }];
    expect(check("example.com/a:1/b", at(["https://example.com/a/b"]))).toEqual([]);
    expect(check("example.com/a:1/b", at(["https://example.com/a:1/b"]))).toEqual([
      { id: "con_1", field: "link", index: 0 },
    ]);
    expect(check("https://example.com:8443/a/b", at(["https://example.com/a/b"]))).toEqual([
      { id: "con_1", field: "link", index: 0 },
    ]);
  });

  it("a link to a host alone ties only beside the contact's name, never in an address at that domain", () => {
    const company: ContactCandidate[] = [{ ...maren, links: ["https://www.kilnworks-studio.example"] }];
    expect(check("Best, Owner\nowner@kilnworks-studio.example\nwww.kilnworks-studio.example", company)).toEqual([]);
    expect(check("Maren is at kilnworks-studio.example now.", company)).toEqual([
      { id: "con_1", field: "link", index: 0 },
    ]);
  });

  it("a short site with a path ties with no minimum; percent-encoded paths, x.com and twitter.com, and ports tie as one", () => {
    const other: ContactCandidate = { ...maren, names: ["Ines Varga"] };
    expect(check("Her notes: jane.example/notes", [{ ...other, links: ["https://jane.example/notes"] }])).toEqual([
      { id: "con_1", field: "link", index: 0 },
    ]);
    expect(check("linkedin.com/in/jürgen", [{ ...other, links: ["https://linkedin.com/in/j%C3%BCrgen"] }])).toEqual([
      { id: "con_1", field: "link", index: 0 },
    ]);
    expect(
      check("https://twitter.com/maren_h_example", [{ ...other, links: ["https://x.com/maren_h_example"] }]),
    ).toEqual([{ id: "con_1", field: "link", index: 0 }]);
    expect(check("x.com/maren_h_example", [{ ...other, links: ["https://twitter.com/maren_h_example"] }])).toEqual([
      { id: "con_1", field: "link", index: 0 },
    ]);
    expect(check("http://jane.example:8080/notes", [{ ...other, links: ["https://jane.example/notes"] }])).toEqual([
      { id: "con_1", field: "link", index: 0 },
    ]);
    expect(check("jane.example/notes", [{ ...other, links: ["https://jane.example:8443/notes"] }])).toEqual([
      { id: "con_1", field: "link", index: 0 },
    ]);
  });
});
