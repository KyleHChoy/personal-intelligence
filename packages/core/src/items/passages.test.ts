import { describe, expect, it } from "vitest";
import { documentPassages, PASSAGE_CHARS } from "./passages.ts";

type Section = { heading: string; start: number; end: number };

// Sections over a text made of headed bodies joined as the shared parse joins them.
function made(bodies: string[]): { text: string; sections: Section[] } {
  let text = "";
  const sections: Section[] = [];
  for (const [i, body] of bodies.entries()) {
    if (i > 0) text += "\n\n";
    const start = text.length;
    text += body;
    sections.push({ heading: `h${i}`, start, end: text.length });
  }
  return { text, sections };
}

const range = (span: string): [number, number] => {
  const [start, end] = span.slice("chars:".length).split("-").map(Number);
  return [start ?? -1, end ?? -1];
};

describe("documentPassages", () => {
  it("passages cover the text with no gap and no overlap, each inside one section", () => {
    const paragraph = "word ".repeat(300).trim();
    const { text, sections } = made([
      "short",
      Array.from({ length: 12 }, () => paragraph).join("\n\n"),
      "x".repeat(9_000),
      "",
    ]);
    const passages = documentPassages(sections, text);
    for (const [index, section] of sections.entries()) {
      const own = passages.filter((one) => one.section === index).map((one) => range(one.span));
      if (section.start === section.end) {
        expect(own).toEqual([]);
        continue;
      }
      expect(own[0]?.[0]).toBe(section.start);
      expect(own[own.length - 1]?.[1]).toBe(section.end);
      for (const [i, [start, end]] of own.entries()) {
        expect(end - start).toBeLessThanOrEqual(PASSAGE_CHARS);
        expect(end).toBeGreaterThan(start);
        if (i > 0) expect(start).toBe(own[i - 1]?.[1]);
      }
    }
    for (const one of passages) expect(one.heading).toBe(sections[one.section]?.heading);
  });

  it("a section that fits is one passage", () => {
    const { text, sections } = made(["a".repeat(PASSAGE_CHARS), "b"]);
    expect(documentPassages(sections, text)).toEqual([
      { span: `chars:0-${PASSAGE_CHARS}`, section: 0, heading: "h0" },
      { span: `chars:${PASSAGE_CHARS + 2}-${PASSAGE_CHARS + 3}`, section: 1, heading: "h1" },
    ]);
  });

  it("a long section is cut at paragraph ends", () => {
    const paragraph = "p".repeat(1_500);
    const { text, sections } = made([[paragraph, paragraph, paragraph].join("\n\n")]);
    const cuts = documentPassages(sections, text).map((one) => text.slice(...range(one.span)));
    // Two whole paragraphs fit, the third does not.
    expect(cuts).toHaveLength(2);
    expect(cuts[0]?.trimEnd()).toBe(`${paragraph}\n\n${paragraph}`);
    expect(cuts[1]).toBe(paragraph);
  });

  it("a long paragraph is cut at white space and never inside a surrogate pair", () => {
    const words = `${"abc ".repeat(1_100)}`.trim();
    const { text, sections } = made([words]);
    const [first] = documentPassages(sections, text);
    const cut = text.slice(...range(first?.span ?? ""));
    expect(cut.endsWith(" ")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(PASSAGE_CHARS);
    // No white space: cut at the bound, one unit short when the bound splits a pair.
    const emoji = made([`a${"😀".repeat(3_000)}`]);
    for (const one of documentPassages(emoji.sections, emoji.text)) {
      const [start, end] = range(one.span);
      const last = emoji.text.charCodeAt(end - 1);
      expect(last >= 0xd800 && last <= 0xdbff, one.span).toBe(false);
      expect(end - start).toBeLessThanOrEqual(PASSAGE_CHARS);
    }
  });

  it("the same text gives the same passages", () => {
    const { text, sections } = made(["one ".repeat(3_000), "two"]);
    expect(documentPassages(sections, text)).toEqual(documentPassages(sections, text));
  });
});
