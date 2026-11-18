import { describe, expect, it } from "vitest";
import { keyPhrase } from "../key-phrase.ts";
import {
  checkKeyFields,
  factLine,
  listsThree,
  sliceGrounded,
  standsAlone,
  summaryStandsAlone,
  wordGrounded,
} from "./claim-intake.ts";

// The one check of a fact's typed key fields, for every source. The owner's three failing phrases
// are pinned first.

describe("checkKeyFields", () => {
  it("refuses the owner's three examples: a pointer word, a list, and (for the model check) passes a polarity it cannot see", () => {
    expect(checkKeyFields("goal", { domain: "career", objective: "reach out to them instead of apply" })).toEqual({
      reason: "not_standalone",
    });
    expect(
      checkKeyFields("situation", { domain: "travel", state: "I've been to seattle new york new orleans, sf, and la" }),
    ).toEqual({ reason: "multi_fact" });
    // "getting overvalued" names its thing badly but holds no pointer: code cannot see a reversed
    // meaning, which is the model check's (C).
    expect(checkKeyFields("situation", { domain: "money", state: "getting overvalued" })).toEqual({
      fields: { domain: "money", state: "getting overvalued" },
    });
  });

  it("refuses each pronoun and pointer word, and their contractions, but not an acronym", () => {
    for (const word of [
      "them",
      "it",
      "its",
      "this",
      "that",
      "these",
      "those",
      "there",
      "here",
      "he",
      "she",
      "they",
      "him",
      "her",
      "his",
      "hers",
      "their",
      "it's",
      "that's",
      "they're",
    ]) {
      expect(checkKeyFields("need", { domain: "career", object: `a reply about ${word} plan` }), word).toEqual({
        reason: "not_standalone",
      });
    }
    expect(checkKeyFields("goal", { domain: "home", objective: "move to the US" })).toMatchObject({ fields: {} });
    expect(checkKeyFields("capability", { domain: "career", object: "run IT support" })).toMatchObject({ fields: {} });
  });

  it("takes a leading first-person subject, and refuses a first-person word after it", () => {
    expect(checkKeyFields("situation", { domain: "home", state: "I moved to Portland" })).toMatchObject({
      fields: { state: "I moved to Portland" },
    });
    expect(checkKeyFields("situation", { domain: "home", state: "I’m moving to Portland" })).toMatchObject({
      fields: {},
    });
    expect(checkKeyFields("goal", { domain: "family", objective: "visit my parents" })).toEqual({
      reason: "not_standalone",
    });
    expect(checkKeyFields("goal", { domain: "ventures", objective: "we raise our seed round" })).toEqual({
      reason: "not_standalone",
    });
    expect(checkKeyFields("goal", { domain: "ventures", objective: "me" })).toEqual({ reason: "not_standalone" });
  });

  it("refuses a relative time word unless a since, until or by date is given", () => {
    for (const phrase of [
      "at the dentist today",
      "flying out tomorrow",
      "back from Lisbon last week",
      "launching soon",
      "started running lately",
      "today's demo",
    ]) {
      expect(checkKeyFields("situation", { domain: "health", state: phrase }), phrase).toEqual({
        reason: "not_standalone",
      });
    }
    expect(
      checkKeyFields("situation", { domain: "health", state: "at the dentist today", until: "2026-03-02" }),
    ).toMatchObject({ fields: {} });
    expect(
      checkKeyFields("goal", { domain: "ventures", objective: "launch the beta soon", by: "2026-06-01" }),
    ).toMatchObject({ fields: {} });
    expect(checkKeyFields("preference", { domain: "career", object: "replies soon", polarity: "prefers" })).toEqual({
      reason: "not_standalone",
    });
  });

  it("refuses a phrase with no word that carries meaning", () => {
    expect(checkKeyFields("goal", { domain: "career", objective: "to be" })).toEqual({ reason: "not_standalone" });
    expect(checkKeyFields("goal", { domain: "career", objective: "I am" })).toEqual({ reason: "not_standalone" });
  });

  it("refuses a list of three or more as multi_fact, and two items or a number's commas pass", () => {
    expect(checkKeyFields("capability", { domain: "career", object: "Python, Go, and Rust" })).toEqual({
      reason: "multi_fact",
    });
    expect(checkKeyFields("situation", { domain: "home", state: "moved to Portland, OR" })).toMatchObject({
      fields: {},
    });
    expect(checkKeyFields("goal", { domain: "ventures", objective: "raise $1,000,000" })).toMatchObject({ fields: {} });
  });

  it("keeps the atomic checks: the bounds, two facts, the negation moved into the polarity, a double negative refused, and the domain", () => {
    expect(
      checkKeyFields("goal", { domain: "ventures", objective: Array.from({ length: 13 }, () => "word").join(" ") }),
    ).toEqual({ reason: "bad_fields" });
    expect(checkKeyFields("goal", { domain: "ventures", objective: "🙂" })).toEqual({ reason: "bad_fields" });
    expect(
      checkKeyFields("goal", { domain: "ventures", objective: "raise a seed round and hire two engineers" }),
    ).toEqual({ reason: "multi_fact" });
    expect(checkKeyFields("preference", { domain: "career", object: "no em dashes", polarity: "prefers" })).toEqual({
      fields: { domain: "career", object: "em dashes", polarity: "avoids" },
    });
    expect(checkKeyFields("preference", { domain: "career", object: "never em dashes", polarity: "avoids" })).toEqual({
      reason: "negated_object",
    });
    expect(checkKeyFields("goal", { domain: "hobbies", objective: "learn to sail" })).toEqual({ reason: "bad_fields" });
    expect(checkKeyFields("goal", { objective: "learn to sail" })).toEqual({ reason: "bad_fields" });
  });

  // A rule typed over two messages with emoji between its words is held to the
  // bounds by its words alone; thirteen words are still too many, emoji or none.
  it("counts no emoji toward the bounds, in words or in code points", () => {
    const rule = "no calls before ten on weekdays \u{1F629} \u{1F629}\nuntil the baby sleeps through";
    expect(checkKeyFields("constraint", { domain: "family", rule })).toEqual({ fields: { domain: "family", rule } });
    const family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";
    const long = `only take calls after the kids are asleep at night ${family.repeat(6)}`;
    expect([...long].length).toBeGreaterThan(90);
    expect(checkKeyFields("constraint", { domain: "family", rule: long })).toEqual({
      fields: { domain: "family", rule: long },
    });
    expect(
      checkKeyFields("constraint", {
        domain: "family",
        rule: `${Array.from({ length: 13 }, () => "word").join(" ")} \u{1F629}`,
      }),
    ).toEqual({ reason: "bad_fields" });
    // Pictures included, at most twice the code points, so no run of emoji is unbounded.
    expect(
      checkKeyFields("constraint", { domain: "family", rule: `no calls ${"\u{2615}".repeat(200)} before ten` }),
    ).toEqual({ reason: "bad_fields" });
  });
});

describe("checkKeyFields of a role and an affiliation", () => {
  it("takes no domain, bounds the title and the organization's name, and holds the title to the stand-alone rules", () => {
    expect(checkKeyFields("role", { title: "Research & Ops intern", organization_name: "Alder Labs" })).toEqual({
      fields: { title: "Research & Ops intern", organization_name: "Alder Labs" },
    });
    expect(
      checkKeyFields("affiliation", { relation: "employee", organization_name: "Here Technologies" }),
    ).toMatchObject({ fields: {} });
    expect(checkKeyFields("role", { title: "her assistant", organization_name: "Alder Labs" })).toEqual({
      reason: "not_standalone",
    });
    expect(checkKeyFields("role", { organization_name: "Alder Labs" })).toEqual({ reason: "bad_fields" });
    expect(checkKeyFields("role", { title: Array.from({ length: 13 }, () => "word").join(" ") })).toEqual({
      reason: "bad_fields",
    });
  });

  it("factLine renders a role and an affiliation as lines.ts does", () => {
    expect(factLine("role", { title: "intern", organization_name: "Alder Labs" })).toBe("intern at Alder Labs");
    expect(factLine("affiliation", { relation: "alumnus", organization_name: "Alder University" })).toBe(
      "Alumnus at Alder University",
    );
  });
});

describe("wordGrounded", () => {
  const quote = "Honestly I'd rather reach out to the founders directly than apply through the portal.";
  it("takes the quote's words in the quote's order, with function words added and plurals folded", () => {
    expect(wordGrounded("reach out to founders directly", quote)).toBe(true);
    expect(wordGrounded("rather reach out to a founder directly than apply", quote)).toBe(true);
    expect(wordGrounded("apply through the portal", quote)).toBe(true);
  });

  it("refuses a reordering, and an added modal, quantifier, comparison or negation", () => {
    expect(wordGrounded("reach out directly to a founder rather than apply", quote)).toBe(false);
    expect(wordGrounded("office over remote", "I like remote over office.")).toBe(false);
    expect(wordGrounded("remote over office", "I like remote over office.")).toBe(true);
    expect(wordGrounded("must move to Denver", "I might move to Denver.")).toBe(false);
    expect(wordGrounded("not Denver", "Denver, not Portland.")).toBe(false);
    expect(wordGrounded("Denver not Portland", "Denver, not Portland.")).toBe(true);
    expect(wordGrounded("all of the meetings", "some of the meetings")).toBe(false);
    expect(wordGrounded("tea over coffee", "tea than coffee")).toBe(false);
  });

  it("refuses a word the quote lacks, and an added negation", () => {
    expect(wordGrounded("email the founders", quote)).toBe(false);
    expect(wordGrounded("not apply through the portal", quote)).toBe(false);
    expect(wordGrounded("the", quote)).toBe(false);
  });

  it("folds case, punctuation, possessives and simple plurals", () => {
    expect(wordGrounded("no meetings on Friday", "No meetings on Fridays, please.")).toBe(true);
    expect(wordGrounded("party", "Two parties this month.")).toBe(true);
    expect(wordGrounded("the launch Sam's", "the launch Sam runs")).toBe(true);
  });

  it("adds only articles and the owner's possessives; every other word, a function word too, is the quote's, in order", () => {
    expect(wordGrounded("move to Portland from Denver", "I will move from Portland to Denver.")).toBe(false);
    expect(wordGrounded("remote or hybrid", "remote and hybrid both work")).toBe(false);
    expect(wordGrounded("work with Alder Labs", "I work for Alder Labs")).toBe(false);
    expect(wordGrounded("finish the thesis", "I need to finish thesis edits")).toBe(true);
    expect(wordGrounded("finish my thesis", "I need to finish thesis edits")).toBe(true);
  });

  it("refuses a phrase with a negation before it anywhere in its clause, or one that skips a negation or a word of contrast", () => {
    expect(wordGrounded("want to manage people", "I don't want to manage people.")).toBe(false);
    expect(wordGrounded("want to manage people", "I do not really want to manage people.")).toBe(false);
    expect(wordGrounded("work weekends", "I am hoping to never work weekends.")).toBe(false);
    expect(wordGrounded("prefer remote", "I prefer office over remote.")).toBe(false);
    expect(wordGrounded("remote and hybrid", "remote and not hybrid")).toBe(false);
    expect(wordGrounded("move to Denver", "Not Portland, I want to move to Denver.")).toBe(true);
    expect(wordGrounded("don't want to manage people", "I don't want to manage people.")).toBe(true);
    expect(wordGrounded("never work weekends", "I am hoping to never work weekends.")).toBe(true);
  });

  it("a modal is no refusal, and the key drops it; nor are maybe and if, whose tentativeness is the type's", () => {
    expect(wordGrounded("move to Denver", "I'd move to Denver.")).toBe(true);
    expect(wordGrounded("write Python", "I can write Python")).toBe(true);
    expect(sliceGrounded("learn Rust", "I should learn Rust")).toBe(true);
    expect(sliceGrounded("raise a seed round", "We may raise a seed round")).toBe(true);
    expect(sliceGrounded("move to Denver", "I might move to Denver.")).toBe(true);
    expect(sliceGrounded("move to Denver", "Maybe I will move to Denver.")).toBe(true);
    expect(sliceGrounded("raise a seed round", "If the demo lands we raise a seed round")).toBe(true);
    expect(keyPhrase("can write Python")).toBe(keyPhrase("write Python"));
    expect(keyPhrase("I should learn Rust")).toBe(keyPhrase("learn Rust"));
    expect(keyPhrase("may raise a seed round")).toBe(keyPhrase("raise a seed round"));
    expect(keyPhrase("will")).toBe("will");
  });
});

describe("sliceGrounded", () => {
  it("takes a run of the quote's words, case and punctuation aside, and refuses any reordering or added word", () => {
    expect(sliceGrounded("rather fly than drive", "I'd rather fly than drive.")).toBe(true);
    expect(sliceGrounded("Rather fly, than drive", "I'd rather fly than drive.")).toBe(true);
    expect(sliceGrounded("rather drive than fly", "I'd rather fly than drive.")).toBe(false);
    expect(sliceGrounded("rather fly than to drive", "I'd rather fly than drive.")).toBe(false);
    expect(sliceGrounded("", "I'd rather fly than drive.")).toBe(false);
  });

  it("punctuation and hyphens aside, no negation before it in its clause", () => {
    expect(sliceGrounded("move to Portland Oregon", "I want to move to Portland, Oregon.")).toBe(true);
    expect(sliceGrounded("follow up with investors", "Remember to follow-up with investors.")).toBe(true);
    expect(sliceGrounded("run a half marathon", "I want to run a half-marathon.")).toBe(true);
    expect(sliceGrounded("want to manage people", "I don't want to manage people.")).toBe(false);
    expect(sliceGrounded("want to manage people", "I dont think I want to manage people.")).toBe(false);
    expect(sliceGrounded("move to Denver", "I won't stay. I plan to move to Denver.")).toBe(true);
  });
});

describe("standsAlone: mail's regressions", () => {
  it("takes that as a relative only after a noun and before its clause's subject; this never; when unsure, refuses", () => {
    expect(standsAlone("a job that the team likes", false)).toBe(true);
    expect(standsAlone("a job that pays well", false)).toBe(false);
    expect(standsAlone("a lab this group runs", false)).toBe(false);
    for (const phrase of [
      "contact that investor",
      "email that recruiter",
      "approve this budget",
      "grow revenue this year",
      "introduce him/her to investors",
      "it/them",
    ]) {
      expect(standsAlone(phrase, false), phrase).toBe(false);
    }
    expect(standsAlone("that pays well", false)).toBe(false);
    expect(standsAlone("that", false)).toBe(false);
    expect(standsAlone("finish that project", false)).toBe(false);
    expect(standsAlone("a reply about that plan", false)).toBe(false);
    expect(standsAlone("a job like that", false)).toBe(false);
  });

  it("takes my and our after the first word of a fact about the owner, and nowhere else", () => {
    expect(standsAlone("finish my thesis", false, true)).toBe(true);
    expect(standsAlone("grow our revenue", false, true)).toBe(true);
    expect(
      checkKeyFields("goal", { domain: "education", objective: "finish my thesis" }, { owner: true }),
    ).toMatchObject({ fields: {} });
    expect(checkKeyFields("goal", { domain: "education", objective: "finish my thesis" })).toEqual({
      reason: "not_standalone",
    });
    expect(standsAlone("help me move", false, true)).toBe(false);
    expect(standsAlone("visit where I grew up", false, true)).toBe(false);
    expect(standsAlone("visit where I'm from", false, true)).toBe(false);
    expect(standsAlone("my", false, true)).toBe(false);
  });

  it("reads I as first person only standing as its own word: I/O is no pronoun", () => {
    expect(standsAlone("reduce I/O latency", false)).toBe(true);
    expect(standsAlone("I/O latency", false)).toBe(true);
    expect(standsAlone("reduce latency I saw", false)).toBe(false);
  });
});

describe("the parts", () => {
  it("listsThree counts comma-separated items, and a comma in a number is none", () => {
    expect(listsThree("a, b, and c")).toBe(true);
    expect(listsThree("a, b")).toBe(false);
    expect(listsThree("10,000,000 users")).toBe(false);
  });

  it("standsAlone: a pronoun inside a word is no pronoun", () => {
    expect(standsAlone("theme park tickets", false)).toBe(true);
    expect(standsAlone("hereditary condition", false)).toBe(true);
  });

  it("the key drops a leading first-person subject, and only one standing on its own", () => {
    expect(keyPhrase("I moved to Portland")).toBe(keyPhrase("moved to Portland"));
    expect(keyPhrase("I’ll launch the beta")).toBe("launch beta");
    expect(keyPhrase("ill health")).toBe("ill health");
    expect(keyPhrase("Islands trip")).toBe("islands trip");
    expect(keyPhrase("me")).toBe("me");
  });

  it("factLine renders R13's template from the typed fields", () => {
    expect(factLine("goal", { domain: "ventures", objective: "raise a seed round", by: "2026-06-30" })).toBe(
      "Goal: raise a seed round, by 2026-06-30",
    );
    expect(factLine("preference", { domain: "career", object: "em dashes", polarity: "avoids" })).toBe(
      "Avoids: em dashes",
    );
    expect(factLine("situation", { domain: "home", state: "moved to Portland" })).toBe("Situation: moved to Portland");
  });
});

// A work summary (propose_opportunity, propose_task, propose_hypothesis) names the
// work itself: 3 words or more with letters, 2 distinct of them carrying meaning, not placeholders.
describe("summaryStandsAlone", () => {
  it("refuses the live case and placeholder-only text", () => {
    for (const text of [
      "x",
      "X",
      "test",
      "tbd",
      "TODO",
      "...",
      "?!",
      "---",
      "",
      "   ",
      "x y z",
      "test test test",
      "todo: tbd, wip",
      "foo bar baz",
      "n/a",
      "lorem ipsum dolor sit amet",
      "测试",
    ]) {
      expect(summaryStandsAlone(text), JSON.stringify(text)).toBe(false);
    }
  });

  it("refuses fewer than 3 words, and fewer than 2 distinct words that carry meaning", () => {
    for (const text of [
      "Email Dana",
      "follow up",
      "reply to them",
      "do it",
      "follow follows follow",
      "it is what it is",
    ]) {
      expect(summaryStandsAlone(text), text).toBe(false);
    }
  });

  it("takes a summary that names the work, pronouns, first person and relative time included", () => {
    for (const text of [
      "Reply to Dana",
      "Ask Dana Ortiz whether she can introduce the owner to the Acme team",
      "Prepare the Q3 board deck",
      "Find a warm intro to Fernway Logistics",
      "Are you free Friday?",
      "I found a conflict with the dentist tomorrow",
      "Register for the bar exam",
      "Schedule the driving test",
    ]) {
      expect(summaryStandsAlone(text), text).toBe(true);
    }
  });

  it("reads words as the claim checks do: NFKC, format characters dropped, and a script without spaces letter by letter", () => {
    expect(summaryStandsAlone("x\u200b\u200b\u200b")).toBe(false);
    expect(summaryStandsAlone("ＴＥＳＴ ｔｅｓｔ ｔｅｓｔ")).toBe(false);
    expect(summaryStandsAlone("Préparer le dossier Fernway")).toBe(true);
    // A script written without spaces: each letter is a word.
    expect(summaryStandsAlone("回复王先生关于合同的邮件")).toBe(true);
    expect(summaryStandsAlone("会議の準備")).toBe(true);
  });
});
