// The label algebra: normalize, combine, isAtLeastAsStrict and narrow. Two label rules have no
// function of their own here: widening needs a person, which is the absence of any export that
// widens, as the boundaries test holds; and outcomes are labelled too, which is combine, applied by
// its callers.
//
// Readings chosen where the spec leaves a detail open. The implementation conforms to these.
// - normalize sorts each set ascending by code unit, as Array.prototype.sort() does, returns a
//   new label with exactly the keys compartments and readers, and leaves its input unchanged.
// - combine and narrow normalize their inputs and return a normalized label.
// - A function that returns a label refuses by throwing an Error whose message is one lower-case
//   code and nothing else, as the signing package does. The message holds none of the input.
//   The code is pinned only where a rule below names it: `malformed` for combine handed something
//   that is not a list, `bad_narrow_request` for the two narrow refusals below.
// - narrow refuses any request that fails the NarrowRequest schema: an unknown key, a value that
//   is not a list, a request that is not an object.
//
// Further rules these tests pin.
// - narrow(base, request, allowedAdditions) refuses, with `bad_narrow_request`, any compartment
//   in addCompartments that is not in allowedAdditions. Read literally: a compartment the base
//   already carries is refused too when it is not allowed. An allowedAdditions that is not a
//   list refuses every addition; it is never matched as text.
// - keepReaders is an intersection: the result's readers are the base's readers that are in it,
//   ALL_MEMBERS intersected with a set gives that set, and an empty result is allowed.
// - removeReaders takes readers out by id, with no directory. Removing ALL_MEMBERS from a label
//   that holds it leaves no readers. Removing a reader the base does not list changes nothing.
//   Naming a member on a base whose readers are ALL_MEMBERS cannot be applied, and is refused
//   with `bad_narrow_request`. Two cases are left to the implementation, and the property test
//   accepts a refusal or a result that is no wider: such a removal sent together with
//   keepReaders, and one sent together with ALL_MEMBERS itself.
// - isAtLeastAsStrict answers false when either label fails the Label schema.

import type { Compartment, Label, NarrowRequest, ReaderId } from "@intelligence/contracts";
import { ALL_MEMBERS } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import * as api from "./labels.ts";
import { combine, isAtLeastAsStrict, narrow, normalize } from "./labels.ts";
import {
  ACTIVE_MEMBERS,
  admits,
  asha,
  bo,
  COMPARTMENTS,
  cleo,
  DEAL_X,
  DEAL_Y,
  dov,
  egon,
  expectRefusal,
  genLabel,
  genLabels,
  ghost,
  HR,
  KNOWN_MEMBERS,
  label,
  ORG,
  PEOPLE,
  pick,
  rng,
  SPECIAL,
  SRC_ASHA,
  SRC_BO,
  SRC_CORRECTIONS,
  shuffle,
  someOf,
  strictOracle,
  unlessRefused,
} from "./test-support/label-world.ts";

const RUNS = 300;

describe("normalize", () => {
  it("normalize: sorts and removes repeats", () => {
    expect(normalize(label([PEOPLE, ORG, PEOPLE], [bo, asha, bo]))).toStrictEqual({
      compartments: [ORG, PEOPLE],
      readers: [asha, bo],
    });
  });

  it("normalize: a reader set that holds ALL_MEMBERS becomes that group alone", () => {
    expect(normalize(label([ORG], [bo, ALL_MEMBERS, asha])).readers).toStrictEqual([ALL_MEMBERS]);
    expect(normalize(label([ORG], [ALL_MEMBERS, ALL_MEMBERS])).readers).toStrictEqual([ALL_MEMBERS]);
  });

  it("normalize: keeps a label with no readers as it is", () => {
    expect(normalize(label([ORG], []))).toStrictEqual({ compartments: [ORG], readers: [] });
  });

  it("normalize: the same sets in any order give the same label, and it is idempotent", () => {
    const next = rng(11);
    for (let run = 0; run < RUNS; run++) {
      const l = genLabel(next);
      const once = normalize(l);
      expect(normalize(label(shuffle(next, l.compartments), shuffle(next, l.readers))), `run ${run}`).toStrictEqual(
        once,
      );
      expect(normalize(once), `run ${run}`).toStrictEqual(once);
      expect(once.compartments, `run ${run}`).toStrictEqual([...new Set(l.compartments)].sort());
    }
  });

  it("normalize: leaves its input unchanged", () => {
    const input = label([PEOPLE, ORG], [bo, ALL_MEMBERS, asha]);
    Object.freeze(input.compartments);
    Object.freeze(input.readers);
    Object.freeze(input);
    normalize(input);
    expect(input).toStrictEqual({ compartments: [PEOPLE, ORG], readers: [bo, ALL_MEMBERS, asha] });
  });
});

describe("combine", () => {
  it("combine takes the union of compartments and the intersection of readers", () => {
    const message = label([ORG, SRC_ASHA], [asha, bo, cleo]);
    const forward = label([ORG, DEAL_X, SRC_BO], [bo, cleo, dov]);
    expect(combine([message, forward])).toStrictEqual(normalize(label([ORG, DEAL_X, SRC_ASHA, SRC_BO], [bo, cleo])));
  });

  it("input order and repeated inputs do not change the result", () => {
    const a = label([ORG, SRC_ASHA], [asha, bo, cleo]);
    const b = label([PEOPLE, SRC_BO], [cleo, bo]);
    const c = label([DEAL_X, ORG], [ALL_MEMBERS]);
    const result = combine([a, b, c]);
    expect(combine([c, a, b])).toStrictEqual(result);
    expect(combine([b, c, a, a, b, c, c])).toStrictEqual(result);
    expect(combine([label([SRC_ASHA, ORG, ORG], [cleo, bo, asha, bo]), b, c])).toStrictEqual(result);
  });

  it("a single label combines to itself, normalized", () => {
    const next = rng(12);
    for (let run = 0; run < RUNS; run++) {
      const l = genLabel(next);
      expect(combine([l]), `run ${run}`).toStrictEqual(normalize(l));
    }
  });

  it("property: union of compartments and intersection of readers over generated labels", () => {
    const next = rng(13);
    for (let run = 0; run < RUNS; run++) {
      const inputs = genLabels(next);
      const result: Label = combine(inputs);
      const at = `run ${run}`;
      expect(new Set(result.compartments), at).toStrictEqual(new Set(inputs.flatMap((l) => l.compartments)));
      for (const member of KNOWN_MEMBERS) {
        expect(admits(result, member), `${at} ${member}`).toBe(inputs.every((l) => admits(l, member)));
      }
      expect(result.readers.includes(ALL_MEMBERS), at).toBe(inputs.every((l) => l.readers.includes(ALL_MEMBERS)));
      // No reader comes from nowhere.
      for (const reader of result.readers)
        expect(
          inputs.every((l) => admits(l, reader)),
          at,
        ).toBe(true);
      expect(result, at).toStrictEqual(normalize(result));
    }
  });

  it("property: combine is commutative, associative and idempotent", () => {
    const next = rng(14);
    for (let run = 0; run < RUNS; run++) {
      const [a, b, c] = [genLabel(next), genLabel(next), genLabel(next)];
      const at = `run ${run}`;
      const all = combine([a, b, c]);
      expect(combine([a, b]), at).toStrictEqual(combine([b, a]));
      expect(combine([combine([a, b]), c]), at).toStrictEqual(all);
      expect(combine([a, combine([b, c])]), at).toStrictEqual(all);
      expect(combine([a, a]), at).toStrictEqual(combine([a]));
      expect(combine([all, all, a]), at).toStrictEqual(all);
      expect(combine(shuffle(next, [a, b, c, pick(next, [a, b, c])])), at).toStrictEqual(all);
    }
  });

  it("a run's output takes the label of everything it read, cited or not", () => {
    const cited = label([PEOPLE, SRC_ASHA], [ALL_MEMBERS]);
    const alsoCited = label([PEOPLE, SRC_BO], [asha, bo, cleo]);
    const toolResultNotCited = label([PEOPLE, DEAL_X, SRC_BO], [bo]);
    expect(combine([cited, alsoCited, toolResultNotCited])).toStrictEqual(
      normalize(label([PEOPLE, DEAL_X, SRC_ASHA, SRC_BO], [bo])),
    );
  });

  it("combine refuses an empty list", () => {
    expectRefusal(() => combine([]));
  });

  const notLists: [name: string, value: unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["one label, not in a list", label([ORG], [ALL_MEMBERS])],
    ["a string", ORG],
    ["a number", 3],
  ];

  for (const [name, value] of notLists) {
    it(`combine refuses what is not a list with the code malformed: ${name}`, () => {
      expectRefusal(() => combine(value as Label[]), "malformed");
    });
  }

  it("combine returns a label at least as strict as every input", () => {
    const a = label([ORG, SRC_ASHA], [asha, bo]);
    const b = label([DEAL_X, SRC_BO], [ALL_MEMBERS]);
    const result = combine([a, b]);
    expect(isAtLeastAsStrict(result, a)).toBe(true);
    expect(isAtLeastAsStrict(result, b)).toBe(true);
  });

  it("property: combine never widens: no input compartment is lost and no reader is gained", () => {
    const next = rng(15);
    for (let run = 0; run < RUNS; run++) {
      const inputs = genLabels(next);
      const result: Label = combine(inputs);
      for (const input of inputs) {
        const at = `run ${run}`;
        expect(isAtLeastAsStrict(result, input), at).toBe(true);
        // The same thing, checked without the function under test.
        expect(strictOracle(result, input), at).toBe(true);
        for (const compartment of input.compartments) expect(result.compartments, at).toContain(compartment);
        for (const member of [...KNOWN_MEMBERS, ghost]) {
          if (admits(result, member)) expect(admits(input, member), `${at} ${member}`).toBe(true);
        }
      }
    }
  });

  it("ALL_MEMBERS intersected with any reader set gives that set", () => {
    const readersOf = (...sets: ReaderId[][]): ReaderId[] =>
      combine(sets.map((readers) => label([ORG], readers))).readers;
    expect(readersOf([ALL_MEMBERS], [bo, asha])).toStrictEqual([asha, bo]);
    expect(readersOf([asha, bo], [ALL_MEMBERS])).toStrictEqual([asha, bo]);
    expect(readersOf([ALL_MEMBERS], [ALL_MEMBERS])).toStrictEqual([ALL_MEMBERS]);
    expect(readersOf([ALL_MEMBERS], [])).toStrictEqual([]);
    expect(readersOf([ALL_MEMBERS, asha], [bo])).toStrictEqual([bo]);
    expect(readersOf([ALL_MEMBERS], [asha, bo], [ALL_MEMBERS], [bo, cleo])).toStrictEqual([bo]);
  });

  it("no directory or snapshot is read: a departed or unknown reader is kept, not expanded or dropped", () => {
    expect(combine([label([ORG], [ALL_MEMBERS]), label([ORG], [egon, ghost])]).readers).toStrictEqual([egon, ghost]);
    // The group is not expanded to today's members, so it is not "everyone listed".
    expect(combine([label([ORG], [ALL_MEMBERS]), label([ORG], [...ACTIVE_MEMBERS])]).readers).toStrictEqual(
      [...ACTIVE_MEMBERS].sort(),
    );
  });

  it("when the readers have nothing in common the result has no readers", () => {
    const result = combine([label([PEOPLE, SRC_ASHA], [asha]), label([PEOPLE, SRC_BO], [bo, cleo])]);
    expect(result).toStrictEqual(normalize(label([PEOPLE, SRC_ASHA, SRC_BO], [])));
    // Nothing combined with it afterwards brings a reader back.
    expect(combine([result, label([PEOPLE], [ALL_MEMBERS])]).readers).toStrictEqual([]);
  });
});

describe("isAtLeastAsStrict", () => {
  const cases: [name: string, a: Label, b: Label, expected: boolean][] = [
    ["the same label", label([ORG], [asha, bo]), label([ORG], [asha, bo]), true],
    ["one more compartment", label([ORG, HR], [asha, bo]), label([ORG], [asha, bo]), true],
    ["a compartment of b missing", label([ORG], [asha]), label([ORG, DEAL_X], [asha, bo]), false],
    ["another compartment in its place", label([ORG, DEAL_Y], [asha]), label([ORG, DEAL_X], [asha]), false],
    ["fewer readers", label([ORG], [asha]), label([ORG], [asha, bo]), true],
    ["a reader b does not have", label([ORG], [asha, cleo]), label([ORG], [asha, bo]), false],
    ["more compartments but one more reader", label([ORG, HR, DEAL_X], [asha, bo]), label([ORG], [asha]), false],
    ["fewer readers but a compartment missing", label([ORG], []), label([ORG, HR], [asha]), false],
    ["b holds ALL_MEMBERS, a names members", label([ORG], [asha, egon]), label([ORG], [ALL_MEMBERS]), true],
    ["b holds ALL_MEMBERS, a has no readers", label([ORG], []), label([ORG], [ALL_MEMBERS]), true],
    ["both hold ALL_MEMBERS", label([ORG], [ALL_MEMBERS]), label([ORG], [ALL_MEMBERS]), true],
    ["b holds ALL_MEMBERS beside a member", label([ORG], [bo]), label([ORG], [asha, ALL_MEMBERS]), true],
    ["a holds ALL_MEMBERS, b names every member", label([ORG], [ALL_MEMBERS]), label([ORG], [...KNOWN_MEMBERS]), false],
    ["a holds ALL_MEMBERS beside a reader of b", label([ORG], [ALL_MEMBERS, asha]), label([ORG], [asha]), false],
    ["no readers on either", label([ORG], []), label([ORG], []), true],
    ["no readers against some", label([ORG], []), label([ORG], [asha]), true],
    ["some readers against none", label([ORG], [asha]), label([ORG], []), false],
    ["repeats and order ignored", label([HR, ORG, ORG], [bo, asha, asha]), label([ORG], [asha, bo]), true],
  ];

  for (const [name, a, b, expected] of cases) {
    it(`${name} is ${expected ? "" : "not "}at least as strict`, () => {
      expect(isAtLeastAsStrict(a, b)).toBe(expected);
    });
  }

  it("property: agrees with the rule on generated pairs, and every label is as strict as itself", () => {
    const next = rng(16);
    for (let run = 0; run < RUNS; run++) {
      const [a, b] = [genLabel(next), genLabel(next)];
      expect(isAtLeastAsStrict(a, b), `run ${run}`).toBe(strictOracle(a, b));
      expect(isAtLeastAsStrict(a, a), `run ${run}`).toBe(true);
    }
  });

  // Each of these fails the Label schema. Several would compare as strict, or as weaker than
  // anything, if they were read without being parsed: an empty compartment list has "every"
  // compartment of nothing, and a string holds its substrings.
  const sound = label([ORG], [asha]);
  const malformed: [name: string, value: unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["null readers", { compartments: [ORG], readers: null }],
    ["missing readers", { compartments: [ORG] }],
    ["no compartments", { compartments: [], readers: [asha] }],
    ["no compartments, open to the group", { compartments: [], readers: [ALL_MEMBERS] }],
    ["compartments as one string", { compartments: "org people hr", readers: [asha] }],
    ["readers as one string", { compartments: [ORG], readers: "m-asha m-bo all_members" }],
    ["a compartment that is not a string", { compartments: [ORG, 7], readers: [asha] }],
    ["an unknown key", { compartments: [ORG], readers: [asha], open: true }],
  ];

  for (const [name, value] of malformed) {
    it(`a malformed label is never at least as strict, and nothing is as strict as it: ${name}`, () => {
      expect(isAtLeastAsStrict(value as Label, sound)).toBe(false);
      expect(isAtLeastAsStrict(sound, value as Label)).toBe(false);
      expect(isAtLeastAsStrict(value as Label, value as Label)).toBe(false);
      // Against the loosest and the tightest sound labels too.
      expect(isAtLeastAsStrict(value as Label, label([ORG], [ALL_MEMBERS]))).toBe(false);
      expect(isAtLeastAsStrict(label([...COMPARTMENTS], []), value as Label)).toBe(false);
    });
  }
});

describe("narrow", () => {
  const base = label([ORG, SRC_ASHA], [asha, bo, cleo]);

  it("narrow adds allowed compartments and removes readers", () => {
    expect(narrow(base, { addCompartments: [HR], removeReaders: [cleo] }, SPECIAL)).toStrictEqual(
      normalize(label([ORG, SRC_ASHA, HR], [asha, bo])),
    );
    expect(narrow(base, { addCompartments: [HR, HR] }, SPECIAL)).toStrictEqual(
      normalize(label([ORG, SRC_ASHA, HR], [asha, bo, cleo])),
    );
    expect(narrow(base, { removeReaders: [asha, bo, cleo] }, SPECIAL)).toStrictEqual(
      normalize(label([ORG, SRC_ASHA], [])),
    );
    expect(narrow(label([ORG], [ALL_MEMBERS]), { removeReaders: [ALL_MEMBERS] }, SPECIAL).readers).toStrictEqual([]);
    // Removing a reader the base does not list changes nothing.
    expect(narrow(base, { removeReaders: [dov, ghost] }, SPECIAL)).toStrictEqual(normalize(base));
  });

  it("an empty request returns the base label", () => {
    expect(narrow(base, {}, SPECIAL)).toStrictEqual(normalize(base));
    expect(narrow(base, {}, [])).toStrictEqual(normalize(base));
    expect(narrow(base, { addCompartments: [], removeReaders: [] }, [])).toStrictEqual(normalize(base));
  });

  it("narrow returns a label at least as strict as its base", () => {
    const narrowed = narrow(base, { addCompartments: [HR], removeReaders: [asha] }, SPECIAL);
    expect(isAtLeastAsStrict(narrowed, base)).toBe(true);
    expect(isAtLeastAsStrict(base, narrowed)).toBe(false);
    const kept = narrow(base, { keepReaders: [asha] }, SPECIAL);
    expect(isAtLeastAsStrict(kept, base)).toBe(true);
    expect(isAtLeastAsStrict(base, kept)).toBe(false);
  });

  it("keepReaders is an intersection with the base's readers", () => {
    expect(narrow(base, { keepReaders: [cleo, asha] }, SPECIAL)).toStrictEqual(
      normalize(label([ORG, SRC_ASHA], [asha, cleo])),
    );
    // A reader who was not on the base is never added.
    expect(narrow(base, { keepReaders: [asha, dov, ghost] }, SPECIAL).readers).toStrictEqual([asha]);
    expect(narrow(base, { keepReaders: [dov] }, SPECIAL).readers).toStrictEqual([]);
    // An empty result is allowed.
    expect(narrow(base, { keepReaders: [] }, SPECIAL).readers).toStrictEqual([]);
    expect(narrow(label([ORG], [ALL_MEMBERS]), { keepReaders: [] }, SPECIAL).readers).toStrictEqual([]);
    // Keeping and removing together, on a base that names its readers.
    expect(narrow(base, { keepReaders: [asha, bo], removeReaders: [bo] }, SPECIAL).readers).toStrictEqual([asha]);
    expect(
      narrow(base, { keepReaders: [asha, bo], removeReaders: [cleo], addCompartments: [HR] }, SPECIAL),
    ).toStrictEqual(normalize(label([ORG, SRC_ASHA, HR], [asha, bo])));
  });

  it("ALL_MEMBERS intersected with a set gives that set, so an organization-wide label shrinks to the people on the item", () => {
    const wide = label([ORG, SRC_ASHA], [ALL_MEMBERS]);
    expect(narrow(wide, { keepReaders: [bo, asha, bo] }, SPECIAL)).toStrictEqual(
      normalize(label([ORG, SRC_ASHA], [asha, bo])),
    );
    // No directory is read: a kept reader is kept as named, known or not.
    expect(narrow(wide, { keepReaders: [egon, ghost] }, SPECIAL).readers).toStrictEqual([egon, ghost]);
    // The group on the other side leaves the base's readers as they are.
    expect(narrow(base, { keepReaders: [ALL_MEMBERS] }, SPECIAL).readers).toStrictEqual([asha, bo, cleo]);
    expect(narrow(wide, { keepReaders: [ALL_MEMBERS] }, SPECIAL).readers).toStrictEqual([ALL_MEMBERS]);
  });

  it("removeReaders naming a member on a base whose readers are ALL_MEMBERS is refused", () => {
    expectRefusal(() => narrow(label([ORG], [ALL_MEMBERS]), { removeReaders: [asha] }, SPECIAL), "bad_narrow_request");
    expectRefusal(
      () => narrow(label([ORG], [ALL_MEMBERS]), { removeReaders: [asha, bo], addCompartments: [HR] }, SPECIAL),
      "bad_narrow_request",
    );
    // A base that lists a member beside the group is the group.
    expectRefusal(
      () => narrow(label([ORG], [asha, ALL_MEMBERS]), { removeReaders: [asha] }, SPECIAL),
      "bad_narrow_request",
    );
    // The same request on a base that names its readers is applied.
    expect(narrow(label([ORG], [asha, bo]), { removeReaders: [asha] }, SPECIAL).readers).toStrictEqual([bo]);
  });

  it("narrow refuses a compartment that is not in allowedAdditions", () => {
    expectRefusal(() => narrow(base, { addCompartments: [DEAL_X] }, SPECIAL), "bad_narrow_request");
    expectRefusal(() => narrow(base, { addCompartments: [HR, DEAL_X] }, SPECIAL), "bad_narrow_request");
    expectRefusal(() => narrow(base, { addCompartments: ["deal:new"] }, SPECIAL), "bad_narrow_request");
    expectRefusal(() => narrow(base, { addCompartments: [SRC_BO] }, SPECIAL), "bad_narrow_request");
    expectRefusal(() => narrow(base, { addCompartments: [HR] }, []), "bad_narrow_request");
    // A compartment the base already carries is not thereby allowed.
    expectRefusal(() => narrow(base, { addCompartments: [ORG] }, SPECIAL), "bad_narrow_request");
    // A request that also narrows the readers is refused whole.
    expectRefusal(
      () => narrow(base, { addCompartments: [DEAL_X], keepReaders: [asha] }, SPECIAL),
      "bad_narrow_request",
    );
    // The control: the same compartment, allowed.
    expect(narrow(base, { addCompartments: [DEAL_X] }, [HR, DEAL_X]).compartments).toContain(DEAL_X);
  });

  it("an allowedAdditions that is not a list allows nothing, and is never matched as text", () => {
    const text = "hr and every deal" as unknown as Compartment[];
    expectRefusal(() => narrow(base, { addCompartments: [HR] }, text));
    expectRefusal(() => narrow(base, { addCompartments: ["h"] }, text));
    expectRefusal(() => narrow(base, { addCompartments: [HR] }, undefined as unknown as Compartment[]));
    expectRefusal(() => narrow(base, { addCompartments: [HR] }, null as unknown as Compartment[]));
    expectRefusal(() => narrow(base, { addCompartments: [HR] }, { hr: true } as unknown as Compartment[]));
  });

  const refused: [name: string, request: unknown][] = [
    ["addReaders", { addReaders: [dov] }],
    ["keepCompartments", { keepCompartments: [SRC_ASHA] }],
    ["removeCompartments", { removeCompartments: [ORG] }],
    ["readers", { readers: [dov] }],
    ["compartments", { compartments: [PEOPLE] }],
    ["a whole label", { compartments: [PEOPLE], readers: [ALL_MEMBERS] }],
    ["label", { label: { compartments: [PEOPLE], readers: [ALL_MEMBERS] } }],
    ["destination", { destination: "people" }],
    ["grant", { removeReaders: [cleo], grant: "g-1" }],
    ["a forbidden key beside an allowed one", { addCompartments: [HR], addReaders: [dov] }],
    ["a forbidden key with an empty value", { addReaders: [] }],
  ];

  for (const [name, request] of refused) {
    it(`narrow refuses a request with any key but addCompartments, removeReaders and keepReaders: ${name}`, () => {
      expectRefusal(() => narrow(base, request as NarrowRequest, SPECIAL));
    });
  }

  const notRequests: [name: string, request: unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["a sentence", "remove everyone but the sender"],
    ["a list", [{ removeReaders: [cleo] }]],
    ["a number", 7],
    ["addCompartments that is not a list", { addCompartments: HR }],
    ["removeReaders that is not a list", { removeReaders: "m-cleo" }],
    ["keepReaders that is not a list", { keepReaders: "m-asha m-bo m-cleo" }],
    ["an empty compartment", { addCompartments: [""] }],
    ["a reader that is not a string", { removeReaders: [7] }],
    ["a kept reader that is not a string", { keepReaders: [asha, null] }],
  ];

  for (const [name, request] of notRequests) {
    it(`narrow refuses model output that is not a narrowing request: ${name}`, () => {
      expectRefusal(() => narrow(base, request as NarrowRequest, SPECIAL));
    });
  }

  it("a model-proposed label can never add a reader or drop a compartment", () => {
    // Every allowed key, aimed at widening: compartments and unknown ids offered as readers to
    // remove, and readers the base never had offered as readers to keep.
    const narrowed: Label = narrow(
      base,
      {
        addCompartments: [HR],
        removeReaders: [ORG, SRC_ASHA, ghost] as unknown as ReaderId[],
        keepReaders: [asha, bo, cleo, dov, ghost, ORG as unknown as ReaderId],
      },
      SPECIAL,
    );
    for (const compartment of base.compartments) expect(narrowed.compartments).toContain(compartment);
    expect(narrowed.readers).toStrictEqual([asha, bo, cleo]);
    expect(admits(narrowed, dov)).toBe(false);
    expect(admits(narrowed, ghost)).toBe(false);
    // A reader offered as a compartment is refused, and adds no reader even where a caller allows it.
    expectRefusal(() => narrow(base, { addCompartments: [dov] }, SPECIAL), "bad_narrow_request");
    expectRefusal(() => narrow(base, { addCompartments: [ALL_MEMBERS] }, SPECIAL), "bad_narrow_request");
    const allowedAnyway: Label = narrow(base, { addCompartments: [dov, ALL_MEMBERS] }, [dov, ALL_MEMBERS]);
    expect(allowedAnyway.readers).toStrictEqual([asha, bo, cleo]);
  });

  it("property: a request is refused or applied, and what is applied never widens the label", () => {
    const next = rng(17);
    const addable: Compartment[] = [...COMPARTMENTS, "deal:new", dov, ALL_MEMBERS];
    const allowable: Compartment[] = [HR, "hr:medical", SRC_CORRECTIONS];
    const readerPool = [...KNOWN_MEMBERS, ghost, ALL_MEMBERS, ...COMPARTMENTS] as ReaderId[];
    let applied = 0;
    let refusedForAddition = 0;
    let refusedForGroup = 0;
    for (let run = 0; run < 2 * RUNS; run++) {
      const from = genLabel(next);
      const allowed = someOf(next, allowable);
      const request: NarrowRequest = {
        ...(next() < 0.5 && { addCompartments: someOf(next, next() < 0.7 ? allowed : addable) }),
        ...(next() < 0.4 && { removeReaders: someOf(next, readerPool) }),
        ...(next() < 0.4 && { keepReaders: someOf(next, readerPool) }),
      };
      const at = `run ${run}`;
      const additions = request.addCompartments ?? [];
      const removed = request.removeReaders ?? [];
      const group = from.readers.includes(ALL_MEMBERS);
      const removesMember = removed.some((reader) => reader !== ALL_MEMBERS);
      const notAllowed = additions.some((compartment) => !allowed.includes(compartment));
      // A member cannot be taken out of the group. With keepReaders, or with the group itself
      // removed too, the request may still be applicable, and either answer is accepted.
      const cannotApply = group && removesMember && request.keepReaders === undefined && !removed.includes(ALL_MEMBERS);
      const mayRefuse = group && removesMember;

      const result = unlessRefused(() => narrow(from, request, allowed));
      if (notAllowed || cannotApply) {
        expect(result, at).toBeUndefined();
        expectRefusal(() => narrow(from, request, allowed), "bad_narrow_request");
        if (notAllowed) refusedForAddition++;
        else refusedForGroup++;
        continue;
      }
      if (!mayRefuse) expect(result, at).toBeDefined();
      if (result === undefined) continue;
      applied++;

      expect(isAtLeastAsStrict(result, from), at).toBe(true);
      expect(strictOracle(result, from), at).toBe(true);
      // The compartments are the base's and the additions, and nothing else.
      expect(new Set(result.compartments), at).toStrictEqual(new Set([...from.compartments, ...additions]));
      for (const reader of removed) expect(result.readers, at).not.toContain(reader);
      const kept = request.keepReaders;
      if (kept !== undefined && !kept.includes(ALL_MEMBERS)) {
        for (const reader of result.readers) expect(kept, at).toContain(reader);
      }
      for (const member of [...KNOWN_MEMBERS, ghost]) {
        if (admits(result, member)) expect(admits(from, member), `${at} ${member}`).toBe(true);
      }
      expect(result, at).toStrictEqual(normalize(result));
    }
    // Every branch was reached.
    expect(applied).toBeGreaterThan(100);
    expect(refusedForAddition).toBeGreaterThan(20);
    expect(refusedForGroup).toBeGreaterThan(5);
  });
});

describe("refusals and boundaries", () => {
  it("a refusal carries only its reason code, never what it refused", () => {
    const canary = "canary-7f3a";
    const base = label([ORG, `deal:${canary}`], [asha]);
    const tainted = { compartments: [`deal:${canary}`], readers: null } as unknown as Label;
    const refusals: [name: string, act: () => unknown][] = [
      [
        "narrow: an unknown key",
        () => narrow(base, { [`${canary}-key`]: [`${canary}-value`] } as NarrowRequest, SPECIAL),
      ],
      ["narrow: addReaders", () => narrow(base, { addReaders: [`m-${canary}`] } as NarrowRequest, SPECIAL)],
      ["narrow: a sentence", () => narrow(base, `${canary} sentence` as unknown as NarrowRequest, SPECIAL)],
      [
        "narrow: a compartment that is not allowed",
        () => narrow(base, { addCompartments: [`deal:${canary}-2`] }, SPECIAL),
      ],
      [
        "narrow: a member taken out of the group",
        () => narrow(label([`deal:${canary}`], [ALL_MEMBERS]), { removeReaders: [`m-${canary}` as ReaderId] }, SPECIAL),
      ],
      ["narrow: a malformed base", () => narrow(tainted, {}, SPECIAL)],
      ["normalize: null readers", () => normalize(tainted)],
      ["normalize: an unknown key", () => normalize({ ...base, [`${canary}-key`]: canary } as Label)],
      ["normalize: a sentence", () => normalize(`${canary} sentence` as unknown as Label)],
      ["combine: a malformed label in the list", () => combine([base, tainted])],
      ["combine: not a list", () => combine(`${canary} sentence` as unknown as Label[])],
      ["combine: a list of sentences", () => combine([`${canary} sentence`] as unknown as Label[])],
    ];
    for (const [name, act] of refusals) {
      let thrown: unknown;
      try {
        act();
      } catch (error) {
        thrown = error;
      }
      // The whole error, however it is printed, holds the code and none of the input.
      expect(String(thrown), name).not.toContain(canary);
      expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown ?? {})), name).not.toContain(canary);
      expectRefusal(act);
    }
  });

  it("boundaries: the package exports the functions the spec names and nothing else", () => {
    expect(Object.keys(api).sort()).toStrictEqual(["combine", "isAtLeastAsStrict", "narrow", "normalize"].sort());
  });
});
