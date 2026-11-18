// The test vectors that pin the canonical encoding. Each is a value and the exact text its bytes
// spell in UTF-8. A change to the encoding that breaks one of these breaks every signature already
// made, so a vector is never edited to make a change pass.

export const vectors: [name: string, value: unknown, text: string][] = [
  ["null", null, "null"],
  ["true", true, "true"],
  ["false", false, "false"],
  ["zero", 0, "0"],
  ["a negative integer", -1, "-1"],
  ["a fraction", 1.5, "1.5"],
  ["a sum with a rounding tail", 0.1 + 0.2, "0.30000000000000004"],
  ["the largest safe integer", 9007199254740991, "9007199254740991"],
  ["a large number", 1e21, "1e+21"],
  ["a small number", 1e-7, "1e-7"],
  ["an empty text", "", '""'],
  ["plain text", "people", '"people"'],
  ["text with escapes", 'a"b\\c/\b\f\n\r\t\u0001\u001f', String.raw`"a\"b\\c/\b\f\n\r\t\u0001\u001f"`],
  ["text beyond ASCII is written as itself", "é 名 𐍈 \u2028", '"é 名 𐍈 \u2028"'],
  ["a lone surrogate is escaped", "\ud800", String.raw`"\ud800"`],
  ["an empty list", [], "[]"],
  ["an empty object", {}, "{}"],
  ["a list keeps its order and its repeats", ["b", "a", "b", 2, null, [true]], '["b","a","b",2,null,[true]]'],
  ["keys are sorted", { b: 1, a: 2, aa: 3, A: 4, "": 5 }, '{"":5,"A":4,"a":2,"aa":3,"b":1}'],
  [
    "keys are sorted at every depth",
    { z: { y: 1, x: { w: 2, v: 3 } }, a: [{ c: 1, b: 2 }] },
    '{"a":[{"b":2,"c":1}],"z":{"x":{"v":3,"w":2},"y":1}}',
  ],
  ["keys are sorted by UTF-16 code unit", { "～": 2, 𐍈: 1, é: 0 }, '{"é":0,"𐍈":1,"～":2}'],
  ["an undefined field is left out and a null field is kept", { a: undefined, b: null }, '{"b":null}'],
  [
    "a set is sorted and loses its repeats, and an ordinary list is left alone",
    { readers: ["m-b", "m-a", "m-b"], compartments: ["people", "org", "org"], other: ["b", "a", "b"] },
    '{"compartments":["org","people"],"other":["b","a","b"],"readers":["m-a","m-b"]}',
  ],
  [
    "each of the five set fields",
    { stores: ["work", "people"], roles: ["match_broker", "grant_authority"], items: ["ev-2", "ev-1", "ev-2"] },
    '{"items":["ev-1","ev-2"],"roles":["grant_authority","match_broker"],"stores":["people","work"]}',
  ],
  [
    "a set is sorted by the encoding of its entries",
    { readers: ["a", "a b", "a#", 'a"'] },
    String.raw`{"readers":["a b","a","a#","a\""]}`,
  ],
  [
    "a set of objects",
    {
      compartments: [
        { kind: "base", id: "people" },
        { id: "org", kind: "base" },
        { id: "people", kind: "base" },
      ],
    },
    '{"compartments":[{"id":"org","kind":"base"},{"id":"people","kind":"base"}]}',
  ],
  [
    "a set inside a nested object and inside a list",
    { matchingGrant: { id: "g-1", compartments: ["people", "deal:alder"] }, grants: [{ compartments: ["b", "a"] }] },
    '{"grants":[{"compartments":["a","b"]}],"matchingGrant":{"compartments":["deal:alder","people"],"id":"g-1"}}',
  ],
  ["a set key that does not hold a list", { items: 3, readers: "m-a" }, '{"items":3,"readers":"m-a"}'],
];
