import { describe, expect, it } from "vitest";
import { phoneDigits, phonesIn } from "../phones.ts";
import {
  afterAnswers,
  againstSame,
  employersDiffer,
  intoBatches,
  questionRules,
  quoteRefusal,
  type RecordValue,
  recordsRefusal,
  ruleAllowed,
  rulesDue,
  spanningPairs,
} from "./same-person.ts";

const sides = (pair: readonly [string, string]): readonly [string, string] => pair;

describe("an agent's answer needs more than a shared name", () => {
  const text = "Dara Vance here, writing from my new work address at Northwind. Dara Vance, Head of Growth";
  it("takes a quote in the message that says something beyond the name", () => {
    expect(quoteRefusal([{ quote: "writing from my new work address", text }], ["Dara Vance"])).toBeNull();
  });
  it("refuses a quote that is only the name, in any case or spacing", () => {
    expect(quoteRefusal([{ quote: "DARA  vance", text }], ["Dara Vance"])).toBe("name_only");
  });
  it("refuses a signature line and stock phrases, however they are dressed", () => {
    const signed = "Best regards, Dara Vance. Sent from my iPhone";
    expect(quoteRefusal([{ quote: "Best regards, Dara Vance", text: signed }], ["Dara Vance"])).toBe("name_only");
    expect(quoteRefusal([{ quote: "Sent from my iPhone", text: signed }], ["Dara Vance"])).toBe("name_only");
  });
  it("needs every quote to say more than the name, not just one", () => {
    expect(
      quoteRefusal(
        [
          { quote: "writing from my new work address", text },
          { quote: "Dara Vance", text },
        ],
        ["Dara Vance"],
      ),
    ).toBe("name_only");
  });
  it("shared_address needs the other person's address in the quote; a phone alone is never enough", () => {
    const text2 = "Please note my other inbox is dv-home@example.net from now on";
    const addresses = { a: ["dara.work@example.org"], b: ["dv-home@example.net"] };
    const quote = { quote: "my other inbox is dv-home@example.net from now on", text: text2 };
    expect(
      quoteRefusal([{ ...quote, side: "a" }], ["Dara Vance"], { because: "shared_address", addresses }),
    ).toBeNull();
    expect(quoteRefusal([{ ...quote, side: "b" }], ["Dara Vance"], { because: "shared_address", addresses })).toBe(
      "claim_unproved",
    );
    const call = "call my desk line 415 555 0100 anytime";
    const a = { quote: call, text: call, side: "a" as const };
    expect(quoteRefusal([a], ["Dara Vance"], { because: "shared_phone", addresses })).toBe("claim_unproved");
  });
  it("refuses a quote the message does not hold, and a message that does not open", () => {
    expect(quoteRefusal([{ quote: "my phone is the same", text }], ["Dara Vance"])).toBe("quote_not_found");
    expect(quoteRefusal([{ quote: "writing", text: null }], ["Dara Vance"])).toBe("quote_not_found");
  });
});

describe("a cluster is asked once per join", () => {
  it("keeps one pair per join, not every pair", () => {
    const pairs = [
      ["a", "b"],
      ["b", "c"],
      ["a", "c"],
      ["d", "e"],
    ] as const;
    const { kept, left } = spanningPairs(pairs, sides);
    expect(kept).toEqual([pairs[0], pairs[1], pairs[3]]);
    expect(left).toBe(1);
  });
  it("a pair under a wider label never hides one under a narrower", () => {
    const pairs = [
      { sides: ["a", "b"] as const, label: ["own", "work"] },
      { sides: ["a", "c"] as const, label: ["own"] },
      { sides: ["b", "c"] as const, label: ["own"] },
    ];
    const { kept } = spanningPairs(
      pairs,
      (one) => one.sides,
      (one) => one.label,
    );
    expect(kept).toEqual(pairs);
    const { kept: narrowFirst } = spanningPairs(
      [pairs[1], pairs[2], pairs[0]] as typeof pairs,
      (one) => one.sides,
      (one) => one.label,
    );
    expect(narrowFirst).toEqual([pairs[1], pairs[2]]);
  });
  it("batches keep a cluster whole and split only one larger than a batch", () => {
    const pairs = [
      ["a", "b"],
      ["b", "c"],
      ["d", "e"],
      ["f", "g"],
    ] as const;
    expect(intoBatches(pairs, sides, 3).map((one) => one.length)).toEqual([3, 1]);
    expect(intoBatches(pairs.slice(0, 2), sides, 1).map((one) => one.length)).toEqual([1, 1]);
  });
});

describe("what a same on a person's records can rest on", () => {
  const v = (field: RecordValue["field"], value: string): RecordValue => ({ field, value });
  const none = {
    sharedName: true,
    otherHolders: 0,
    nameUncounted: false,
    companies: { a: [], b: [] },
    sharedPhone: false,
  };
  it("an address at a firm and a card at that firm; a mail provider is no firm", () => {
    const at = [v("address", "dara@northwind.example")];
    expect(recordsRefusal("address_matches_company", at, [v("company", "Northwind Capital")], none)).toBeNull();
    expect(recordsRefusal("address_matches_company", [v("company", "Northwind")], at, none)).toBeNull();
    expect(
      recordsRefusal("address_matches_company", [v("address", "dara@gmail.com")], [v("company", "Gmail Inc")], none),
    ).toBe("no_agreement");
    expect(recordsRefusal("address_matches_company", at, [v("company", "Acme")], none)).toBe("no_agreement");
  });
  it("a firm's name is a whole word, and a school's or a government's address is no employer", () => {
    const no = (address: string, company: string) =>
      expect(recordsRefusal("address_matches_company", [v("address", address)], [v("company", company)], none)).toBe(
        "no_agreement",
      );
    no("x@state.gov", "State Farm");
    no("x@state.example", "State Farm");
    no("x@ace.example", "Acendi");
    no("x@stanford.edu", "Stanford");
    no("x@ox.ac.uk", "Ox");
    no("x@hmrc.gov.uk", "HMRC");
    no("x@alumni.northwind.example", "Northwind");
    no("x@northwind.example", "Northwind University");
  });
  it("one company, one profile, one address, by what they mean rather than how they are written", () => {
    expect(
      recordsRefusal("same_company", [v("company", "Northwind, Inc.")], [v("company", "northwind")], none),
    ).toBeNull();
    expect(recordsRefusal("same_company", [v("company", "Northwind")], [v("company", "Southwind")], none)).toBe(
      "no_agreement",
    );
    expect(
      recordsRefusal(
        "same_link",
        [v("link", "https://www.linkedin.com/in/dara-example/")],
        [v("link", "http://linkedin.com/in/dara-example")],
        none,
      ),
    ).toBeNull();
    expect(recordsRefusal("shared_address", [v("address", "D@x.org")], [v("address", "d@x.org")], none)).toBeNull();
  });
  it("what is no employer agrees with nothing and differs from nothing", () => {
    for (const company of ["Self-employed", "Student", "Northwind University", "N/A"]) {
      expect(recordsRefusal("same_company", [v("company", company)], [v("company", company)], none)).toBe(
        "no_agreement",
      );
      expect(employersDiffer([company], ["Northwind"])).toBe(false);
    }
    expect(employersDiffer(["Acme, Inc."], ["Acme Inc"])).toBe(false);
    expect(employersDiffer(["Acme"], ["Beta"])).toBe(true);
  });
  it("a firm's homepage names nobody, so colleagues' cards don't agree on it", () => {
    const home = [v("link", "https://northwind.example")];
    expect(recordsRefusal("same_link", home, home, none)).toBe("no_agreement");
    const page = [v("link", "https://linkedin.com/company/northwind")];
    expect(recordsRefusal("same_link", page, page, none)).toBe("no_agreement");
  });
  it("a third holder, one line or differing employers hold back every same but an exact address or a profile", () => {
    const company = [v("company", "Smith Plumbing")];
    const line = { ...none, sharedPhone: true };
    expect(recordsRefusal("same_company", company, company, line)).toBe("shared_line");
    expect(recordsRefusal("same_company", company, company, { ...none, otherHolders: 1 })).toBe("common_name");
    expect(recordsRefusal("same_company", company, company, { ...none, nameUncounted: true })).toBe("common_name");
    expect(
      recordsRefusal("same_company", company, company, {
        ...none,
        companies: { a: ["Smith Plumbing", "Acme"], b: ["Beta"] },
      }),
    ).toBe("differing_companies");
    const address = [v("address", "d@x.org")];
    expect(recordsRefusal("shared_address", address, address, line)).toBeNull();
    const profile = [v("link", "https://linkedin.com/in/dara-example")];
    expect(recordsRefusal("same_link", profile, profile, line)).toBeNull();
    expect(againstSame(line)).toBe("shared_line");
    expect(againstSame(none)).toBeNull();
  });
  it("only a LinkedIn profile outranks a hold; an x or github account can be a firm's, and is weighed", () => {
    const line = { ...none, sharedPhone: true };
    for (const url of [
      "https://github.com/northwind",
      "https://github.com/features",
      "https://x.com/northwindhq_example",
    ]) {
      const link = [v("link", url)];
      expect(recordsRefusal("same_link", link, link, none)).toBeNull();
      expect(recordsRefusal("same_link", link, link, line)).toBe("shared_line");
      expect(recordsRefusal("same_link", link, link, { ...none, sharedName: false })).toBe("no_agreement");
    }
    const profile = [v("link", "https://linkedin.com/in/dara-example")];
    expect(recordsRefusal("same_link", profile, profile, { ...line, sharedName: false })).toBeNull();
    expect(
      recordsRefusal("same_link", [v("link", "https://www.twitter.com/dara")], [v("link", "https://x.com/dara")], none),
    ).toBeNull();
  });
  it("values from one row agree on nothing: a card listing both people", () => {
    const one = { field: "company", value: "Northwind", row: "con_1" } as const;
    expect(recordsRefusal("same_company", [one], [one], none)).toBe("no_agreement");
    expect(recordsRefusal("same_company", [one], [{ ...one, row: "con_2" }], none)).toBeNull();
    const link = { field: "link", value: "https://linkedin.com/in/dara-example", row: "con_1" } as const;
    expect(recordsRefusal("same_link", [link], [link], none)).toBe("no_agreement");
  });
  it("what agrees without outranking a hold takes a name they share", () => {
    const off = { ...none, sharedName: false };
    const firm = [v("company", "Northwind")];
    expect(recordsRefusal("same_company", firm, firm, off)).toBe("no_agreement");
    expect(recordsRefusal("address_matches_company", [v("address", "d@northwind.example")], firm, off)).toBe(
      "no_agreement",
    );
    expect(recordsRefusal("shared_address", [v("address", "d@x.org")], [v("address", "d@x.org")], off)).toBeNull();
  });
  it("a name alone is no answer while the owner's switch is off, as it ships", () => {
    const name = [v("name", "Ignatius Vellacott")];
    expect(questionRules().rareFullName).toBe(false);
    expect(recordsRefusal("rare_full_name", name, name, none)).toBe("no_agreement");
  });
  it("turned on, a rare full name stands only with nothing against it", () => {
    const on = { ...none, rareFullName: true };
    const name = [v("name", "Ignatius Vellacott")];
    expect(recordsRefusal("rare_full_name", name, name, on)).toBeNull();
    expect(recordsRefusal("rare_full_name", [v("name", "Ignatius")], [v("name", "Ignatius")], on)).toBe("no_agreement");
    expect(recordsRefusal("rare_full_name", name, name, { ...on, otherHolders: 1 })).toBe("common_name");
    expect(recordsRefusal("rare_full_name", name, name, { ...on, sharedPhone: true })).toBe("shared_line");
    expect(
      recordsRefusal("rare_full_name", name, name, { ...on, companies: { a: ["Northwind"], b: ["Southwind"] } }),
    ).toBe("differing_companies");
    expect(recordsRefusal("rare_full_name", name, name, { ...on, companies: { a: ["Northwind"], b: [] } })).toBeNull();
  });
  it("a shared phone alone never stands", () => {
    expect(recordsRefusal("shared_phone", [v("phone", "+15550100")], [v("phone", "+15550100")], none)).toBe(
      "no_agreement",
    );
  });
  it("a signature's phone line says nothing beyond the name, and a phone reads the same however it is written", () => {
    const line = "Phone: +1 (555) 010-0199";
    expect(quoteRefusal([{ quote: line, text: line }], ["Dara"])).toBe("name_only");
    expect(phonesIn("call +1 (555) 010-0199 today")).toEqual([phoneDigits("5550100199")]);
    expect(phoneDigits("12")).toBe("");
  });
});

describe("what a question's answers leave it", () => {
  const says = (client: string, verdict: "same" | "different" | "cant_tell") => ({ client, verdict });
  it("one same is not enough: it goes to a second agent, or the owner when there is none", () => {
    expect(afterAnswers([says("x", "same")], ["x", "y"])).toBe("second");
    expect(afterAnswers([says("x", "same")], ["x"])).toBe("owner");
  });
  it("two agreeing make a same or a different; a lone different is checked too; a disagreement is the owner's", () => {
    expect(afterAnswers([says("x", "same"), says("y", "same")], ["x", "y"])).toBe("same");
    expect(afterAnswers([says("x", "different"), says("y", "different")], ["x", "y"])).toBe("different");
    expect(afterAnswers([says("x", "different")], ["x", "y"])).toBe("second");
    expect(afterAnswers([says("x", "different")], ["x"])).toBe("owner");
    expect(afterAnswers([says("x", "different"), says("y", "cant_tell")], ["x", "y"])).toBe("owner");
    expect(afterAnswers([says("x", "same"), says("y", "different")], ["x", "y"])).toBe("owner");
    expect(afterAnswers([says("x", "same"), says("y", "cant_tell")], ["x", "y"])).toBe("owner");
  });
  it("a can't-tell goes to a second agent where there is one", () => {
    expect(afterAnswers([says("x", "cant_tell")], ["x", "y"])).toBe("second");
  });
  it("reaches the owner after two, or when there is no second", () => {
    expect(afterAnswers([says("x", "cant_tell"), says("y", "cant_tell")], ["x", "y"])).toBe("owner");
    expect(afterAnswers([says("x", "cant_tell")], ["x"])).toBe("owner");
  });
  it("waits while nobody answered, unless nobody can be asked", () => {
    expect(afterAnswers([], ["x"])).toBe("wait");
    expect(afterAnswers([], [])).toBe("owner");
  });
});

describe("a pattern the owner answers alike becomes a proposal", () => {
  const answers = (answer: string, n: number, pattern = "about_you:situation", kind = "about_you") =>
    Array.from({ length: n }, (_, i) => ({ kind, pattern, answer, at: `2026-10-${String(10 + i).padStart(2, "0")}` }));
  it("after the last N agree", () => {
    expect(rulesDue(answers("reject", 4), new Set(), 4)).toEqual([
      { kind: "about_you", pattern: "about_you:situation", answer: "reject", answers: 4 },
    ]);
  });
  it("by the rule file, the last five agreeing are enough and four are not", () => {
    expect(questionRules().ruleAfterAnswers).toBe(5);
    expect(rulesDue(answers("reject", 5), new Set())).toHaveLength(1);
    expect(rulesDue(answers("reject", 4), new Set())).toEqual([]);
  });
  it("not when a recent answer differs, and an old one does not count against it", () => {
    const mixed = [
      ...answers("reject", 4),
      { kind: "about_you", pattern: "about_you:situation", answer: "confirm", at: "2026-11-01" },
    ];
    expect(rulesDue(mixed, new Set(), 4)).toEqual([]);
    const old = [
      { kind: "about_you", pattern: "about_you:situation", answer: "confirm", at: "2026-01-01" },
      ...answers("reject", 4),
    ];
    expect(rulesDue(old, new Set(), 4)).toHaveLength(1);
  });
  it("not when a rule row holds it: the owner declined or lifted it", () => {
    expect(rulesDue(answers("reject", 4), new Set(["about_you\nabout_you:situation\nreject"]), 4)).toEqual([]);
  });
  it("a yes that would release or start work is never a rule", () => {
    expect(rulesDue(answers("confirm", 4), new Set(), 4)).toEqual([]);
    expect(ruleAllowed("opportunity_decision", "opportunity_decision:reply", "go")).toBe(false);
  });
  it("a same on a shared name alone is never a rule", () => {
    expect(ruleAllowed("same_person", "same_person:name:1", "same")).toBe(false);
    expect(ruleAllowed("same_person", "same_person:contact:2", "same")).toBe(false);
    expect(ruleAllowed("same_person", "same_person:local_part:1", "same")).toBe(false);
    expect(ruleAllowed("same_person", "same_person:local_part:2", "same")).toBe(true);
    expect(ruleAllowed("same_person", "same_person:name:1", "different")).toBe(true);
  });
});
