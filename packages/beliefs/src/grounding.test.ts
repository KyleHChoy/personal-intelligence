import { describe, expect, it } from "vitest";
import { groundDurable, groundName, groundText, groundTexting, normal } from "./grounding.ts";
import { groundNumber, numerals, readings } from "./grounding-numbers.ts";

describe("normal", () => {
  it("keeps, for each character it writes, the code point it came from", () => {
    const { text, origins } = normal("A​—  b");
    expect(text).toBe("a- b");
    expect(origins).toEqual([0, 2, 3, 5]);
  });

  it("counts origins in code points, not code units", () => {
    const { text, origins } = normal("\u{20000}x");
    expect(text).toBe("\u{20000}x");
    expect(origins).toEqual([0, 0, 1]);
  });

  // An emoji is white space and a variation selector is dropped.
  it("reads a pictograph as white space and drops a variation selector, keeping each origin", () => {
    const { text, origins } = normal("a\u{2764}\u{FE0F}\u{1F605} b");
    expect(text).toBe("a b");
    expect(origins).toEqual([0, 1, 5]);
  });
});

// A chat line as people type it in Messages, and a value as a model copies it.
describe("typed chat lines", () => {
  const two = "i can only do weekends \u{1F629}\nbc of work";
  it("finds a phrase copied without the emoji between its words, across two messages, and keeps the passage's own slice", () => {
    expect(groundText("only do weekends bc of work", two, "phrase")).toBe("only do weekends \u{1F629}\nbc of work");
    expect(groundText("love hiking", "i love \u{2764}\u{FE0F} hiking", "phrase")).toBe("love \u{2764}\u{FE0F} hiking");
    expect(groundText("learning to code", "learning to\u{FFFC} code rn", "phrase")).toBe("learning to\u{FFFC} code");
  });

  it("finds a heart written without its emoji selector, and a flag, a skin tone and a family stand for no word", () => {
    expect(groundText("love \u{2764} hiking", "i love \u{2764}\u{FE0F} hiking", "phrase")).toBe(
      "love \u{2764}\u{FE0F} hiking",
    );
    expect(groundText("moving to portland", "moving to \u{1F1FA}\u{1F1F8} portland \u{1F44B}\u{1F3FD}", "phrase")).toBe(
      "moving to \u{1F1FA}\u{1F1F8} portland",
    );
    expect(groundText("new place", "new \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} place", "phrase")).toBe(
      "new \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} place",
    );
    // An emoji alone grounds nothing, and an emoji is no word's boundary inside one.
    expect(groundText("\u{1F605}", "i can throw bowls now \u{1F605}", "phrase")).toBeNull();
    expect(groundText("throw bowl", "i can throw bowls\u{1F605}", "phrase")).toBeNull();
  });

  it("finds a phrase or a line with a final stop the typed line lacks, and keeps the line without it", () => {
    expect(groundText("training for a half.", "i’m training for a half", "phrase")).toBe("training for a half");
    expect(groundText("ok see you at the gym at six.", "ok see you at the gym at six", "statement")).toBe(
      "ok see you at the gym at six",
    );
    expect(groundText("need a new kiln!", "i need a new kiln, mine cracked", "phrase")).toBe("need a new kiln");
    // A stop inside the value is still the value's, and a question mark is never left off.
    expect(groundText("a new kiln. mine cracked", "i need a new kiln, mine cracked", "phrase")).toBeNull();
    expect(groundText("ready?", "i’m ready", "phrase")).toBeNull();
  });

  it("reads the copyright and registered signs as marks of a name, not as white space", () => {
    expect(groundText("acme labs", "Acme\u{A9}Labs", "phrase")).toBeNull();
    expect(groundText("Acme\u{AE} Labs", "Acme\u{AE} Labs", "phrase")).toBe("Acme\u{AE} Labs");
  });
});

// A key phrase a model tidied when it copied it from a chat as people type one. Each rule's
// positive and a near miss it must refuse; the slice kept is always the passage's own, and the rule
// is the first of the ladder that finds it.
describe("texting-tolerant grounding", () => {
  const found = (value: string, passage: string) => groundTexting(value, passage);

  it("punctuation: a phrase whose words the passage runs together after a stop or a comma", () => {
    expect(found("ok, see you at the gym", "ok,see you at the gym tmrw")).toEqual({
      slice: "ok,see you at the gym",
      rule: "punctuation",
    });
    expect(found("love hiking, biking", "love hiking,biking")).toEqual({
      slice: "love hiking,biking",
      rule: "punctuation",
    });
    // A word the passage does not hold is no punctuation.
    expect(found("moving to Boston", "moving to portland")).toBeNull();
  });

  it("apostrophe: one added, dropped or curled, with case folded", () => {
    expect(found("I'm training for a half", "im training for a half")).toEqual({
      slice: "im training for a half",
      rule: "apostrophe",
    });
    expect(found("dont eat gluten", "I don’t eat gluten")).toEqual({ slice: "don’t eat gluten", rule: "apostrophe" });
    expect(found("Sam's old bike", "fixing up sams old bike")).toEqual({ slice: "sams old bike", rule: "apostrophe" });
    // An apostrophe is no letter: "im" is never "I am" by this rule alone, nor "him".
    expect(found("him training", "im training")).toBeNull();
  });

  it("contraction: a fixed set expanded both ways, and the ambiguous ones only with their apostrophe", () => {
    expect(found("I am training for a half", "im training for a half")).toEqual({
      slice: "im training for a half",
      rule: "contraction",
    });
    expect(found("do not eat gluten", "i dont eat gluten")).toEqual({ slice: "dont eat gluten", rule: "contraction" });
    expect(found("can't drive at night", "i cannot drive at night")).toEqual({
      slice: "cannot drive at night",
      rule: "contraction",
    });
    expect(found("going to learn piano", "gonna learn piano this year")).toEqual({
      slice: "gonna learn piano",
      rule: "contraction",
    });
    expect(found("it is too far", "it's too far")).toEqual({ slice: "it's too far", rule: "contraction" });
    // "ill", "were", "well" and "its" are words of their own: never a contraction without the
    // apostrophe, though the apostrophe rung still finds the model's "I'll" in a typed "ill".
    expect(found("I will be there", "ill be there")).toBeNull();
    expect(found("I'll be there", "ill be there")).toEqual({ slice: "ill be there", rule: "apostrophe" });
    expect(found("we are moving", "were moving")).toBeNull();
    expect(found("it is too far", "its too far")).toBeNull();
    // Half of an expansion is no match.
    expect(found("do", "dont")).toBeNull();
  });

  it("abbreviation: u, ur, w/, w/o, & and + standing alone, and a few more, both ways", () => {
    expect(found("pizza with you and your sister", "pizza w/ u & ur sister")).toEqual({
      slice: "pizza w/ u & ur sister",
      rule: "abbreviation",
    });
    expect(found("coffee without sugar", "coffee w/o sugar")).toEqual({
      slice: "coffee w/o sugar",
      rule: "abbreviation",
    });
    expect(found("bread and butter", "bread + butter")).toEqual({ slice: "bread + butter", rule: "abbreviation" });
    expect(found("dinner w/ the team", "dinner with the team")).toEqual({
      slice: "dinner with the team",
      rule: "abbreviation",
    });
    expect(found("busy right now", "busy rn")).toEqual({ slice: "busy rn", rule: "abbreviation" });
    // A sign between digits or inside a word is not "and"; a word's letters are not an abbreviation.
    expect(found("2 and 2", "2+2")).toBeNull();
    expect(found("at and t", "AT&T")).toBeNull();
    expect(found("you", "menu")).toBeNull();
  });

  it("one_edit: one letter added, dropped, changed or swapped in a word of at least five letters", () => {
    expect(found("really into climbing", "realy into climbing")).toEqual({
      slice: "realy into climbing",
      rule: "one_edit",
    });
    expect(found("tomorrow morning", "tommorrow morning")).toEqual({ slice: "tommorrow morning", rule: "one_edit" });
    expect(found("receive the grant", "recieve the grant")).toEqual({ slice: "recieve the grant", rule: "one_edit" });
    expect(found("learning spanish", "learnign spanish")).toEqual({ slice: "learnign spanish", rule: "one_edit" });
    // Under five letters a word is another word; two edits are another word; so is another first
    // letter, and a number.
    expect(found("feed the car", "feed the cat")).toBeNull();
    expect(found("climbing", "climing")).toEqual({ slice: "climing", rule: "one_edit" });
    expect(found("climbing", "clmbng")).toBeNull();
    expect(found("would move", "could move")).toBeNull();
    expect(found("saving 20000", "saving 20001")).toBeNull();
  });

  it("keeps the phrase bounds: whole words only, and the first place the phrase stands", () => {
    expect(found("u", "menu")).toBeNull();
    expect(found("im training", "swim training")).toBeNull();
    expect(found("I'm in", "im in. im in for real")).toEqual({ slice: "im in", rule: "apostrophe" });
    expect(found("", "anything")).toBeNull();
    expect(found("\u{1F605}", "lol \u{1F605}")).toBeNull();
  });

  it("reads an emoji, a variation selector and an escape as the exact match does", () => {
    expect(found("I'm learning pottery", "im learning \u{2615}\u{FE0F} pottery")).toEqual({
      slice: "im learning \u{2615}\u{FE0F} pottery",
      rule: "apostrophe",
    });
    expect(found("bread &amp; butter", "bread and butter")).toEqual({
      slice: "bread and butter",
      rule: "abbreviation",
    });
  });
});

describe("text grounding", () => {
  it("a text value not in its passage is unmapped", () => {
    expect(groundText("Brightwater Coffee", "Copperfield Tea\nTotal: USD 18.00", "phrase")).toBeNull();
  });

  it("a value that matches only inside a longer word is unmapped", () => {
    expect(groundText("Wick", "Thistlewick Garden", "phrase")).toBeNull();
    expect(groundText("Thistle", "Thistlewick Garden", "phrase")).toBeNull();
    expect(groundText("Thistlewick", "Thistlewick Garden", "phrase")).toBe("Thistlewick");
  });

  it("the stored value is the passage's own slice", () => {
    const passage = "Thanks for shopping at Hale & Marlow’s.\nTotal: GBP 42.80";
    expect(groundText("Hale &amp; Marlow's", passage, "phrase")).toBe("Hale & Marlow’s");
    expect(groundText("Hale & Marlow’s Ltd", passage, "phrase")).toBeNull();
    expect(groundText("HALE & marlow's", passage, "phrase")).toBe("Hale & Marlow’s");
  });

  it("a value that holds the escaped form in the passage itself is found as given", () => {
    expect(groundText("R&amp;D Supplies", "Paid to R&amp;D Supplies today", "phrase")).toBe("R&amp;D Supplies");
  });

  it("a zero-width character, a soft hyphen and a long dash in the passage do not stop a match", () => {
    const passage = "From Thistle­wick — Gar​den Supplies, thanks";
    expect(groundText("Thistlewick - Garden Supplies", passage, "phrase")).toBe("Thistle­wick — Gar​den Supplies");
  });

  it("a statement cut from inside a sentence is unmapped, and the whole sentence is not", () => {
    const passage = "I can't send the report. I will call you on Monday.";
    expect(groundText("send the report", passage, "statement")).toBeNull();
    expect(groundText("I can’t send the report.", passage, "statement")).toBe("I can't send the report.");
    expect(groundText("I will call you", passage, "statement")).toBeNull();
    expect(groundText("send the report", passage, "phrase")).toBe("send the report");
  });

  it("a statement is found without its full stop and after a list mark", () => {
    expect(
      groundText("I will call you on Monday", "I can't send the report. I will call you on Monday.", "statement"),
    ).toBe("I will call you on Monday");
    expect(groundText("Bring the chairs", "Plan:\n- Bring the chairs\n- Water the plants", "statement")).toBe(
      "Bring the chairs",
    );
    expect(groundText("Water the plants", "1. Bring the chairs\r\n2. Water the plants", "statement")).toBe(
      "Water the plants",
    );
  });

  it("a sentence that runs over a line break is still whole, and an empty value matches nothing", () => {
    expect(groundText("I will send it by Friday.", "Hello.\nI will send it\nby Friday.", "statement")).toBe(
      "I will send it\nby Friday.",
    );
    expect(groundText("  ", "anything", "phrase")).toBeNull();
    expect(groundText("​", "anything", "phrase")).toBeNull();
  });
});

describe("name grounding", () => {
  const segment = "Mira Okafor and Teo will send the deck.";

  it("grounds a whole name, a maximal run of capitalised words", () => {
    expect(groundName("Mira Okafor", segment)).toBe("Mira Okafor");
    expect(groundName("teo", segment)).toBe("Teo");
  });

  it("refuses part of a name: a capitalised word against it past one space", () => {
    expect(groundName("Mira", segment)).toBeNull();
    expect(groundName("Okafor", segment)).toBeNull();
    expect(groundText("Mira", segment, "phrase")).toBe("Mira");
  });

  it("refuses part of a name past any white space within a line, never across a line break", () => {
    expect(groundName("Mira", "Mira  Okafor will call.")).toBeNull();
    expect(groundName("Mira", "Mira\u00a0Okafor will call.")).toBeNull();
    expect(groundName("Mira Okafor", "Thanks\nMira Okafor")).toBe("Mira Okafor");
  });

  it("a statement's first word before a name of two words, and the pronoun I after one, are not the name's", () => {
    expect(groundName("Bryn Calder", "Yesterday Bryn Calder took the audit.")).toBe("Bryn Calder");
    expect(groundName("Bryn Calder", "Ask Bryn Calder about it.")).toBe("Bryn Calder");
    expect(groundName("Bryn Calder", "Bryn Calder I think will lead.")).toBe("Bryn Calder");
    // Before a name of one word it may be a first name: refused, the safe side.
    expect(groundName("Bryn", "Hi Bryn, the audit is yours.")).toBeNull();
    expect(groundName("Okafor", "Mira Okafor will call.")).toBeNull();
  });

  it("takes a later place where the name stands whole", () => {
    expect(groundName("Mira", `${segment} Then Mira, alone.`)).toBeNull();
    expect(groundName("Mira", `${segment} Thanks, Mira.`)).toBe("Mira");
  });
});

describe("number grounding", () => {
  it("1,234.56 reads as 1234.56 alone", () => {
    expect(readings("1,234.56")).toEqual(["1234.56"]);
  });

  it("1.234,56 reads as 1234.56 alone", () => {
    expect(readings("1.234,56")).toEqual(["1234.56"]);
  });

  it("1 234,56 reads as 1234.56, and by its pieces as 1 and 234.56", () => {
    expect(new Set(readings("1 234,56"))).toEqual(new Set(["1234.56", "1", "234.56"]));
    expect(numerals("Total 1 234,56 EUR")).toEqual(["1 234,56"]);
  });

  it("12,50 reads as 12.5", () => {
    expect(readings("12,50")).toEqual(["12.5"]);
  });

  it("1,299 reads as 1299 and as 1.299", () => {
    expect(new Set(readings("1,299"))).toEqual(new Set(["1299", "1.299"]));
  });

  it("a quantity and a price a space apart ground either number", () => {
    expect(numerals("Qty 2 499.00")).toEqual(["2 499.00"]);
    expect(new Set(readings("2 499.00"))).toEqual(new Set(["2499", "2", "499"]));
    expect(groundNumber(2, "Qty 2 499.00")).toBe(true);
    expect(groundNumber(499, "Qty 2 499.00")).toBe(true);
    expect(groundNumber(2499, "Qty 2 499.00")).toBe(true);
  });

  it("a refund in brackets or with a minus grounds its magnitude with either sign", () => {
    for (const passage of ["Refund: -12.50", "Refund: 12.50-", "Refund: (12.50)"]) {
      expect(numerals(passage)).toEqual(["12.50"]);
      expect(groundNumber(12.5, passage)).toBe(true);
      expect(groundNumber(-12.5, passage)).toBe(true);
    }
  });

  it("a currency code against a number leaves a token, and a digit run inside a word is none", () => {
    expect(numerals("USD1,299.00")).toEqual(["1,299.00"]);
    expect(numerals("1299EUR")).toEqual(["1299"]);
    expect(numerals("INV1234")).toEqual([]);
    expect(numerals("abc123def")).toEqual([]);
    expect(numerals("usd1299")).toEqual([]);
    expect(numerals("XUSD1299")).toEqual([]);
    expect(groundNumber(1234, "Invoice INV1234")).toBe(false);
  });

  it("a number not in its passage is unmapped", () => {
    expect(groundNumber(18.5, "Copperfield Tea\nTotal: USD 18.00")).toBe(false);
    expect(groundNumber(18, "Copperfield Tea\nTotal: USD 18.00")).toBe(true);
    expect(groundNumber(1e21, "1000000000000000000000")).toBe(false);
  });

  it("a space or an apostrophe separates only before exactly three digits", () => {
    expect(numerals("1'234.50 and 12 3456")).toEqual(["1'234.50", "12", "3456"]);
    expect(readings("1'234.50")).toEqual(["1234.5"]);
    expect(readings("1.234.567")).toEqual(["1234567"]);
    expect(readings("007")).toEqual(["7"]);
    expect(numerals("1,,2 3.")).toEqual(["1", "2", "3"]);
  });

  it("the canary amount and the grouped total ground", () => {
    expect(groundNumber(6184.27, "Merchant: x\r\nTotal: USD 6184.27\r\n")).toBe(true);
    expect(groundNumber(1234.56, "Larkspur Garden\r\nTotal: EUR 1.234,56\r\n")).toBe(true);
    expect(groundNumber(42.8, "Total: GBP 42.80")).toBe(true);
  });
});

// The meeting lane's durable grounding, over one cited passage or run of
// transcribed speech. Exact first; then a phrase may skip hesitations, and a statement may be a
// short faithful restatement of a sentence. What is kept is always the transcript's own words.
describe("durable grounding", () => {
  const turn = "yeah so I'll, uh, I will send you the deck by Friday, okay, and the numbers too";

  it("an exact match is kept as R11 keeps it", () => {
    expect(groundDurable("the deck by Friday", turn, "phrase")).toBe("the deck by Friday");
    expect(groundDurable("I will send the plans by Friday.", "I will send the plans by Friday.", "statement")).toBe(
      "I will send the plans by Friday.",
    );
  });

  it("a phrase may skip at most two hesitations, and keeps the transcript's words, its hesitations left out", () => {
    expect(
      groundDurable("raise a seed round", "this year I want to raise a, uh, seed round for the studio", "phrase"),
    ).toBe("raise a seed round");
    expect(groundDurable("raise a seed round", "I want to raise a, um, er, uh, seed round", "phrase")).toBeNull();
    // A word that is not a hesitation is never skipped: it may change the fact.
    expect(groundDurable("raise a seed round", "I want to raise a second seed round", "phrase")).toBeNull();
    expect(groundDurable("deep drilling", "we do deep well drilling now", "phrase")).toBeNull();
    // A word's ending may differ; the transcript's own word is kept.
    expect(groundDurable("negotiate term sheets", "I am good at negotiating term sheets.", "phrase")).toBe(
      "negotiating term sheets",
    );
    // Only an inflection, never another word that shares the letters.
    expect(groundDurable("plan the launch", "we planned the launch", "phrase")).toBe("planned the launch");
    expect(groundDurable("Stripe", "we stripped the budget", "phrase")).toBeNull();
    expect(groundDurable("the store", "tell me the story", "phrase")).toBeNull();
    expect(groundDurable("there", "he went into therapy", "phrase")).toBeNull();
    // Plan review: never another word by er, ers or ly.
    expect(groundDurable("the bank", "she is the banker here", "phrase")).toBeNull();
    expect(groundDurable("works hard", "works hardly at all", "phrase")).toBeNull();
    expect(groundDurable("run marathons", "I want to run a marathon.", "phrase")).toBeNull();
    // A hyphen between kept words is kept; only the skipped hesitation closes up.
    expect(
      groundDurable("a workshop with three-phase power", "I need a workshop with three-phase, um, power", "phrase"),
    ).toBe("a workshop with three-phase power");
    expect(groundDurable("two triangles", "draw two right triangles", "phrase")).toBeNull();
  });

  it("a statement may restate a sentence; the stored text is the whole sentence the restatement stands on", () => {
    expect(groundDurable("I will send you the deck by Friday.", turn, "statement")).toBe(turn);
    expect(
      groundDurable(
        "I will send you my notes by Friday.",
        "Fine. I will send you my, uh, notes by Friday, okay? Thanks.",
        "statement",
      ),
    ).toBe("I will send you my, uh, notes by Friday, okay?");
    // A word ending may differ.
    expect(groundDurable("I will send the startup deck.", "so I'm sending the startups deck over", "statement")).toBe(
      "so I'm sending the startups deck over",
    );
  });

  it("a restatement must agree with its sentence on every name, number, negation, hedge, time and the first person", () => {
    expect(groundDurable("I will send Robin the deck by Friday.", turn, "statement")).toBeNull();
    expect(
      groundDurable("I will send the deck in 3 days.", "I will send the deck in 2 days, okay", "statement"),
    ).toBeNull();
    expect(groundDurable("I will send the deck.", "I will send the deck at 3.", "statement")).toBeNull();
    expect(groundDurable("I will not send the deck by Friday.", turn, "statement")).toBeNull();
    expect(
      groundDurable("I will send the deck by Friday.", "I won't send the deck by Friday, sorry", "statement"),
    ).toBeNull();
    // A negation far from the words it governs (outside voice, plan review).
    expect(
      groundDurable("I will send the deck.", "I will not under any circumstances send the deck.", "statement"),
    ).toBeNull();
    // Another person's promise is not the speaker's, and a condition is kept.
    expect(groundDurable("I will send the deck.", "Robin will send the deck.", "statement")).toBeNull();
    expect(
      groundDurable("I will send the deck.", "I will send the deck if the board approves it.", "statement"),
    ).toBeNull();
    expect(
      groundDurable(
        "I will send the deck if the board approves it.",
        "I will send the deck if the board approves it, okay.",
        "statement",
      ),
    ).toBe("I will send the deck if the board approves it, okay.");
    expect(groundDurable("I will send the deck tomorrow.", "I will send the deck next week.", "statement")).toBeNull();
    // An actor at a sentence's start is held too, and a negation of the sentence
    // beside it does not stand for the restatement's.
    expect(groundDurable("Bob will send the deck.", "Alice will send the deck.", "statement")).toBeNull();
    expect(groundDurable("I will send the report Tuesday.", "Send the report Tuesday, I will.", "statement")).toBe(
      "Send the report Tuesday, I will.",
    );
    expect(
      groundDurable(
        "I won't send the report Tuesday.",
        "I won't be there Monday. Send the report Tuesday.",
        "statement",
      ),
    ).toBeNull();
    // A name the speaker addresses at a sentence's start is no part of the fact.
    expect(groundDurable("I will send you the deck.", "Robin, I will send you the deck, okay.", "statement")).toBe(
      "Robin, I will send you the deck, okay.",
    );
  });

  // What the live check refused of the models' answers.
  it("a restatement may leave out a date the sentence names, which the claim's date field carries; a date it names must be the sentence's", () => {
    expect(
      groundDurable(
        "I will prune the hedge by Thursday.",
        "I will prune the hedge by Thursday, March 5, 2026.",
        "statement",
      ),
    ).toBe("I will prune the hedge by Thursday, March 5, 2026.");
    expect(
      groundDurable(
        "Let's have lunch at the harbour cafe on March 18.",
        "Let's have lunch at the harbour cafe on March 18, 2026 and go through them.",
        "statement",
      ),
    ).toBe("Let's have lunch at the harbour cafe on March 18, 2026 and go through them.");
    expect(
      groundDurable(
        "Let's have lunch at the harbour cafe on March 19.",
        "Let's have lunch at the harbour cafe on March 18, 2026 and go through them.",
        "statement",
      ),
    ).toBeNull();
    // A number that is no date still has to be kept.
    expect(groundDurable("I will send the deck.", "I will send the deck at 3.", "statement")).toBeNull();
  });

  it("a negation is read up to the end of the clause that holds the restated words, and every hedge of the sentence is kept", () => {
    expect(
      groundDurable(
        "I will take the cuttings away.",
        "Good, and I will take the cuttings away so you do not have to deal with them.",
        "statement",
      ),
    ).toBe("Good, and I will take the cuttings away so you do not have to deal with them.");
    expect(
      groundDurable("I will send the deck.", "I will not under any circumstances send the deck.", "statement"),
    ).toBeNull();
    expect(
      groundDurable("I will send the deck.", "I will send the deck if the board approves it.", "statement"),
    ).toBeNull();
    // A negation or a condition before the restated words, or set off by a comma
    // inside them, still counts; a number that is no date is no year.
    expect(groundDurable("I will send the deck.", "I will never, ever send the deck.", "statement")).toBeNull();
    expect(groundDurable("I will send the deck.", "I am not so sure I will send the deck.", "statement")).toBeNull();
    expect(
      groundDurable("I will send the deck.", "If the board approves, I will send the deck.", "statement"),
    ).toBeNull();
    expect(groundDurable("I will pay the invoice.", "I will pay the 2000 dollar invoice.", "statement")).toBeNull();
    expect(groundDurable("I will send the deck.", "I will send the deck in January 2027.", "statement")).toBe(
      "I will send the deck in January 2027.",
    );
  });

  // A statement's words never cross a sentence's end inside one joined turn: the
  // next sentence's negation, actor or day would be lent to it.
  it("a restatement standing on two sentences of one turn is refused, though each word is in the turn", () => {
    const turn = "I will not be in the office on Monday. Lena will send the report on Tuesday.";
    expect(groundDurable("I will send the report on Monday.", turn, "statement")).toBeNull();
    expect(groundDurable("I will not send the report on Tuesday.", turn, "statement")).toBeNull();
    expect(groundDurable("Lena will send the report on Tuesday.", turn, "statement")).toBe(
      "Lena will send the report on Tuesday.",
    );
  });

  // A clause set off after the promise by a mark may take it back.
  it("a promise taken back later in its sentence is refused; a reason that follows it is not read", () => {
    expect(
      groundDurable(
        "I'll send you the contract tomorrow.",
        "I'll send you the contract tomorrow, actually no, I won't.",
        "statement",
      ),
    ).toBeNull();
    expect(groundDurable("I will pay the invoice.", "I will pay the invoice; I can't, sorry.", "statement")).toBeNull();
    // Plan review: a contrast may take it back too.
    expect(
      groundDurable(
        "I will send the deck on Friday.",
        "I will send the deck on Friday, though actually no, I won't.",
        "statement",
      ),
    ).toBeNull();
    expect(
      groundDurable(
        "I will send the deck on Friday.",
        "I will send the deck on Friday though I won't be in.",
        "statement",
      ),
    ).toBeNull();
    expect(
      groundDurable(
        "I will take the cuttings away.",
        "I will take the cuttings away so you do not have to deal with them.",
        "statement",
      ),
    ).toBe("I will take the cuttings away so you do not have to deal with them.");
  });

  it("a restatement with too few of the sentence's words is refused", () => {
    expect(groundDurable("I will email the slides to the partners on Friday.", turn, "statement")).toBeNull();
    // One content word alone grounds nothing.
    expect(groundDurable("I will do it.", "I will see, I will do what I can", "statement")).toBeNull();
  });

  it("a sentence longer than RESTATE_SLICE_MAX is refused: it would be no quote", () => {
    const long = `I will send ${"and then we talked about many other things for a long time ".repeat(8)}the deck`;
    expect(groundDurable("I will send the deck.", long, "statement")).toBeNull();
  });

  it("a homophone the transcript misheard grounds only when copied as transcribed", () => {
    const garbled = "I want to raise a fondant for climate startups next year";
    expect(groundDurable("raise a fund for climate startups", garbled, "phrase")).toBeNull();
    expect(groundDurable("raise a fondant for climate startups", garbled, "phrase")).toBe(
      "raise a fondant for climate startups",
    );
  });
});
