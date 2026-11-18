import {
  Band,
  currentDefinition,
  DECISION_POINT_PINS,
  DECISION_POINTS,
  DecisionPointCall,
  DecisionPointDefinition,
  DecisionPointId,
  EFFECT_CLASS,
  ESCALATING_EFFECTS,
  freezeDefinition,
  ModelEntry,
  Rung2Output,
  ThresholdName,
  thresholdPair,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

const accepts = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;

const rung1 = {
  rung: 1,
  prompt: { id: "jev_project", version: "1" },
  question: "about_project",
  onAccept: ["propose"],
  onReject: ["none"],
  thresholds: { accept: "accept", reject: "reject" },
};
const rung2 = {
  rung: 2,
  prompt: { id: "luna_project", version: "1" },
  question: "about_project",
  onAccept: ["propose"],
  onReject: ["none"],
  unsure: "reject",
};
const LINK_LIKE = {
  id: "project_link",
  version: 1,
  rungs: [0, 1, 2, 4],
  outputs: { propose: "propose_binding", none: "record_silence" },
  queue: "project_link",
  onNoAnswer: "decline",
  prompts: [rung1.prompt, rung2.prompt],
  models: [rung1, rung2],
};

describe("model entries", () => {
  it("a rung 1 entry names its thresholds by name, and a rung 2 entry its unsure answer", () => {
    expect(accepts(ModelEntry, rung1)).toBe(true);
    expect(accepts(ModelEntry, { ...rung1, thresholds: { accept: "accept", reject: "below_accept" } })).toBe(true);
    expect(accepts(ModelEntry, { ...rung1, thresholds: { accept: "accept", reject: null } })).toBe(true);
    expect(accepts(ModelEntry, rung2)).toBe(true);
    const { unsure: _unsure, ...plain } = rung2;
    expect(accepts(ModelEntry, plain)).toBe(true);
  });

  it("an entry holds no bounds: defaults, floors and ceilings are J2's constants", () => {
    expect(accepts(ModelEntry, { ...rung1, thresholds: { accept: "accept", reject: "reject", default: 0.8 } })).toBe(
      false,
    );
    expect(accepts(ModelEntry, { ...rung1, accept: 0.8 })).toBe(false);
    expect(accepts(ModelEntry, { ...rung1, thresholds: { accept: 0.8, reject: null } })).toBe(false);
  });

  it("an entry with no accept output, an unknown threshold name or a rung outside 1 and 2 does not parse", () => {
    expect(accepts(ModelEntry, { ...rung1, onAccept: [] })).toBe(false);
    expect(accepts(ModelEntry, { ...rung1, thresholds: { accept: "upper", reject: null } })).toBe(false);
    expect(accepts(ModelEntry, { ...rung1, rung: 3 })).toBe(false);
    expect(accepts(ModelEntry, { ...rung2, thresholds: rung1.thresholds })).toBe(false);
    expect(accepts(ModelEntry, { ...rung2, unsure: "accept" })).toBe(false);
  });

  it("J2's threshold names hold accept and reject", () => {
    expect(ThresholdName.options).toEqual(expect.arrayContaining(["accept", "reject"]));
  });

  it("a definition takes models, a fallback and a whileWaiting, all optional", () => {
    const definition = {
      id: "project_link",
      version: 1,
      rungs: [0, 1, 2, 4],
      outputs: { propose: "propose_binding", none: "record_silence" },
      queue: "owner_question",
      onNoAnswer: "decline",
      expiresAfterDays: 14,
      prompts: [rung1.prompt, rung2.prompt],
      models: [rung1, rung2],
    };
    expect(accepts(DecisionPointDefinition, definition)).toBe(true);
    expect(accepts(DecisionPointDefinition, { ...definition, fallback: "none", whileWaiting: "none" })).toBe(true);
    expect(accepts(DecisionPointDefinition, { ...definition, fallback: "Not A Word" })).toBe(false);
  });
});

describe("rung 2's output", () => {
  const cite = { slot: "message", text: "the quarterly plan" };

  it("is yes, no or unsure with at most five citations of at most 300 code points", () => {
    expect(accepts(Rung2Output, { answer: "yes", cites: [cite] })).toBe(true);
    expect(accepts(Rung2Output, { answer: "unsure", cites: [] })).toBe(true);
    expect(accepts(Rung2Output, { answer: "yes", cites: Array.from({ length: 5 }, () => cite) })).toBe(true);
    expect(accepts(Rung2Output, { answer: "maybe", cites: [] })).toBe(false);
    expect(accepts(Rung2Output, { answer: "yes", cites: [cite], note: "x" })).toBe(false);
  });

  it("a rung 2 output with six citations does not parse", () => {
    expect(accepts(Rung2Output, { answer: "yes", cites: Array.from({ length: 6 }, () => cite) })).toBe(false);
  });

  it("a citation is counted in code points, not UTF-16 units", () => {
    expect(accepts(Rung2Output, { answer: "yes", cites: [{ slot: "message", text: "😀".repeat(300) }] })).toBe(true);
    expect(accepts(Rung2Output, { answer: "yes", cites: [{ slot: "message", text: "a".repeat(301) }] })).toBe(false);
  });
});

describe("bands, calls, points and effects", () => {
  it("a band is accept, reject, next or fallback", () => {
    expect(Band.options).toEqual(["accept", "reject", "next", "fallback"]);
  });

  it("a call may carry its band, saved call, threshold grants and run; a call without them still parses", () => {
    const call = {
      point: "move_clear",
      version: 1,
      definitionHash: "a".repeat(64),
      rung: 0,
      inputHash: "b".repeat(64),
      output: "clear",
      effect: "clear_internal_move",
      effectClass: "internal_reversible",
      escalated: false,
    };
    expect(accepts(DecisionPointCall, call)).toBe(true);
    expect(
      accepts(DecisionPointCall, {
        ...call,
        rung: 1,
        band: "accept",
        savedCall: "dc_1",
        thresholdIds: ["thr_1"],
        run: null,
      }),
    ).toBe(true);
    expect(accepts(DecisionPointCall, { ...call, band: null, savedCall: null, thresholdIds: [], run: null })).toBe(
      true,
    );
    expect(accepts(DecisionPointCall, { ...call, band: "middle" })).toBe(false);
  });

  it("the six points of this design are point ids", () => {
    for (const id of [
      "claims_same_fact",
      "belief_change",
      "project_link",
      "record_echo",
      "change_worth_run",
      "forecast_wait",
    ])
      expect(DecisionPointId.options, id).toContain(id);
  });

  it("the new effects have their classes", () => {
    for (const effect of [
      "mark_echo",
      "propose_grouping",
      "supersede_earlier",
      "propose_binding",
      "offer_wake",
    ] as const)
      expect(EFFECT_CLASS[effect], effect).toBe("internal_reversible");
    expect(EFFECT_CLASS.record_only).toBe("narrow");
  });

  it("only propose_binding escalates at the rung that answered, and it is internal_reversible", () => {
    expect([...ESCALATING_EFFECTS]).toEqual(["propose_binding"]);
    expect(Object.isFrozen(ESCALATING_EFFECTS)).toBe(true);
  });
});

describe("the current definition", () => {
  it("is the highest version of a point in DECISION_POINTS", () => {
    for (const definition of DECISION_POINTS) {
      const highest = Math.max(...DECISION_POINTS.filter((one) => one.id === definition.id).map((one) => one.version));
      expect(currentDefinition(definition.id).version, definition.id).toBe(highest);
      expect(currentDefinition(definition.id).id).toBe(definition.id);
    }
  });

  it("throws for a point with no definition, so no caller misses one silently", () => {
    expect(() => currentDefinition("forecast_wait")).toThrow(/no decision point forecast_wait/);
  });
});

describe("threshold pairs", () => {
  const point = (thresholds: { accept: string; reject: string | null }) =>
    DecisionPointDefinition.parse({
      id: "project_link",
      version: 1,
      rungs: [0, 1, 4],
      outputs: { propose: "propose_binding", none: "record_silence" },
      queue: "project_link",
      onNoAnswer: "decline",
      prompts: [rung1.prompt],
      models: [{ ...rung1, thresholds }],
    });

  it("an accept and a reject named by the rung 1 entry are a pair, whatever their names", () => {
    expect(thresholdPair(point({ accept: "accept", reject: "reject" }), "reject")).toEqual({
      other: "accept",
      side: "reject",
    });
    expect(thresholdPair(point({ accept: "accept", reject: "reject" }), "accept")).toEqual({
      other: "reject",
      side: "accept",
    });
    expect(thresholdPair(point({ accept: "hold", reject: "clear" }), "clear")).toEqual({
      other: "hold",
      side: "reject",
    });
    expect(thresholdPair(point({ accept: "hold", reject: "clear" }), "hold")).toEqual({
      other: "clear",
      side: "accept",
    });
  });

  it("an entry with no reject threshold, a name it does not give, and a point with no models have none", () => {
    expect(thresholdPair(point({ accept: "accept", reject: null }), "accept")).toBeNull();
    expect(thresholdPair(point({ accept: "accept", reject: "below_accept" }), "accept")).toBeNull();
    expect(thresholdPair(point({ accept: "accept", reject: "reject" }), "lane")).toBeNull();
    expect(thresholdPair(currentDefinition("extract_recovery"), "hold")).toBeNull();
  });
});

describe("frozen definitions", () => {
  it("a definition's model entries are frozen all the way down", () => {
    const definition = freezeDefinition(DecisionPointDefinition.parse({ ...LINK_LIKE }));
    const [one, two] = definition.models ?? [];
    for (const entry of [one, two]) {
      if (entry === undefined) throw new Error("two entries");
      expect(
        Object.isFrozen(entry) &&
          Object.isFrozen(entry.onAccept) &&
          Object.isFrozen(entry.onReject) &&
          Object.isFrozen(entry.prompt),
      ).toBe(true);
    }
    expect(one?.rung === 1 && Object.isFrozen(one.thresholds)).toBe(true);
    expect(Object.isFrozen(definition.models)).toBe(true);
  });
});

// A pin never changes: a changed definition is a new version with its own pin.
describe("definition hashes", () => {
  it("every definition hash in DECISION_POINT_PINS is unchanged", () => {
    expect(DECISION_POINT_PINS).toEqual({
      "wake_worth_run@1": "038c7004308bf712e923647a5cb3cca83cb27d0339a9307a57d339c891f83153",
      "run_outcome@1": "fa84dd831a706e7d8a00904845f74f260872f3f821b5a29e15a0c849d9ef5ee4",
      "opportunity_go@1": "d08b8c9b595a07472bc1927d816a6968c0167a8836c88a6de6556fe059d00483",
      "owner_question@1": "eee7aa512b4591ea5e35982bbdcd2a0ec3427297e1a78e2710037ddadc470e24",
      "move_clear@1": "eeb5baeff4c22a8334bdcb59cb4a908bc62b9837edd90267ff625187a6f187aa",
      "extract_triage@2": "1e68a0bd0d9c3577ddae853f7ced0d4ba389170a44f1d7a9a2119b094b658cf5",
      "extract_triage@3": "30e69bb5caba32c38138b5a244a209a7231587b4fb08cc00f18e936e064173d2",
      "extract_claims@1": "b837cb747773ec915929f5fb7b4ea2a77acc3a46ab18f3dc10e4cf65748421e8",
      "extract_claims@2": "fbfa19371efaf27b96c0a9667c6f0a8b6c1ef2db7858d139b71891dc505e97ed",
      "extract_claims@3": "53dccf92f818b2d5cabfb6008d399f2e48f85319f18d414617cc62570c66965f",
      "extract_claims@4": "a1f15adbb13e3cbe637a2866772d2e60f41e3976e0121baaadc2810e16af44bd",
      "extract_injection@1": "6c09783b522b6d645e0c2710daef058e805397de097dc4a07a1a947bc7c261f6",
      "extract_sensitivity@1": "ee57a07a7948cc9029107307dc896165e65ba8010d7841d593639abd6b6b1e3a",
      "send_clear@1": "1d8141199780438b883f71555bf54493f1c8e4cf67e460f14062da885d67733b",
      "send_first_contact@1": "824caac011dc973b917c5edcb3daad0973b64c446a8fe61998102fbe7f62f0b2",
      "draft_disclosure@1": "4ec86f10eda3eeaaf0fe684f0eb9e546fceaff336bc2470d981e0087fed17e69",
      "identity_candidate@1": "c3be0de294de025287b084969ecdfc1515363efee2ac42f84a56474f133f6f1b",
      "identity_ruling@1": "acce71d8d2247f8387b013f249899df4d99f9f1b0d06caddafbb0d2f306a0319",
      "extract_recovery@1": "3c4e5ac7217ee17ccd42b4a79e359246c8ac05154147761fd267019e73fee973",
      "record_injection@1": "e2c6412f82cdc02356979cc544bf7a7a54a00f9ca7afd74e2a35c69de6bd74f1",
      "identity_rank@1": "6956c3d8c77dd73c8dff92c03a69241a86a31c67a4c396d5b56f4283b7b5e4c5",
      "record_echo@1": "4d26ed80d4409c88d0af48208f4332ecd4e36960574906b8ae256f6ff13ac5ce",
      "about_you@1": "ccb4964e109f4a51e89c84bae4147cd010d975743a2bbb34cd8e6512231e4c1d",
      "client_preference@1": "5087986d8e647a9c65ba49b9683b436e92d77d19f736ad914d5a886ff2692d3d",
      "restrict_category@1": "4d2ec29b8169226cc213846af06f45f3a02517418932c5bcf084c150fe836e3b",
      "extract_injection@2": "b446afcbbf7f03a5cd62a52767541d24d4902556e77c8e90f33b5818c557a943",
      "extract_sensitivity@2": "62f275cd87c2bdd3dc700a9e67f180e8f4c35b7029e68f917d7e85e2855e26f1",
      "record_injection@2": "da091fa8bd253e036dcf13a4fb3bcb4a44e37d25881ab11fdec74e7b8c024c4f",
      "record_injection@3": "c505cb56ea949f93a7b7ec51e4e21df8de9b28bad3c3d6fccfbfb90bd62e22bc",
      "extract_claims@5": "6ef1b4f3c2c98d398e7a31d385f09ac31aa0446ca1d283068cb969778f73c0cd",
      "run_outcome@2": "88e50f40b9a9d8f9a51a0a00da5cd74ed78f780f57f783fd1c8b8fdc04ba20f0",
      "run_outcome@3": "69f83f9d29c4230a9a46e8f5edaa1f4dd632caaeaaa1921ff9d4624c8f06a3ec",
      "run_outcome@4": "02b189ba62243ce71a50b450cd08a80cdda5ac9ec08f327ba9a3d07fd8f8f098",
      "run_outcome@5": "1b83dfb2667ecc8b5266df63848e5cf2f0aeaf2633b36262c2d0c5044bb4a7a7",
      "run_outcome@6": "fc2dd88475eb0a4bb3cefb567e04e6152f1f68815fde2866b37bde0b25c8e438",
      "run_outcome@7": "182ec38202fcc1246928df5e521c3033f6c3933dbb99130ea8b3fce861b183c4",
      "run_outcome@8": "16363aca7c967531b7b4425433e108eb90354e7bd65fedb67845f5a2e06cf863",
      "run_outcome@9": "3442f44e40e55c77563df6ed260c64de9f3cc0a4470103529a1afefe367d4578",
      "run_outcome@10": "2b2d0c5577d6590e2e173beaef949ea1095699a9fe4b55ff1903ea843b1a8dd5",
      "run_outcome@11": "908a0bcd5961624984e566e9a38bdbd510d1b24823f24e498101ab49a9e199bb",
      "run_outcome@12": "64445e7528b2c561f4e296c52397d26cbfc5583af140d2defb8c1f5ac32f4db9",
      "run_outcome@13": "c558864870139abb8c0579c8a27a809d16acdd5e62f5b9965fd429a437af3ede",
      "extract_triage@4": "98ab4417b71be55b5f3529da7dee608d622ecfbbfb9fe56654fade8137401000",
      "extract_claims@6": "8e0fa4d23e634d19b45ef671ca66c3b95f6eab1fe74afce6cabf9f23b96d09bb",
      "extract_triage@5": "bb975008cfa3dfe3dc44d63a1384b69bfef57fb565ac1497296e8df0d6183e11",
      "extract_claims@7": "57d1eaabb662c10e253438ecf03e5ae4933ff9503f29812e443fe8c5955e7f29",
      "extract_claims@8": "b19375f84477da438cec8702690841990b5a489684c1a80de2aff0d7901d7545",
      "extract_claims@10": "aab8bfe7362c642c03380c5b1c85e27e571b15d10115239fe60acd296fed430e",
      "extract_claims@11": "b318d4c778893c6b5732b59f24844ba1f10a9c8c7af758b0bae0ba4166abd34c",
      "extract_claims@12": "25cf00aa598490f0bad2dc011d66f7c6bb633d1bbdddb25c94fcc30096b09747",
      "extract_claims@13": "aec8b699fb63ccece1a9e65ed0445a9da242a99dc9909cd4f0663be1e658de11",
      "extract_claims@14": "e77cd6a41db4eca90044ec53f16627f926fa0040a4fcfc475f6b576155148a1e",
      "extract_claims@15": "debfc70f51cfa5030983c5a350285b0794c3a137c1d75036a76e4dbfbb4d71e3",
      "extract_claims@16": "496b503d46050751062e33f375a69cf668c47456f6957d7612d7bb64ba91bf76",
      "extract_claims@17": "7597981de99572689cf6d7193ac1f6e843db7cb3deb555121391389d51adcfad",
      "extract_claims@18": "cacb651b7101d839945aa9f9ebaf554efe6c7440e65193b3226564df17252e2d",
      "extract_claims@19": "a414c8b2f75813150b031fa359e770dc41301386290e087620a1634d5991ef5f",
      "extract_claims@20": "13cac2acdc707d7b115985e058250c3d52a69f2a0706373efcf724a4260c6949",
      // 21 is skipped.
      "extract_claims@22": "a396fa6b15338c9e0a946b921f34aba838b550b9ad1f87a4eb8b39475d59555b",
      "extract_claims@23": "e113d4cab8de1010b1f7484cbe7708d9d448e6c5058ead5af6e260665ab99dd5",
      "extract_claims@24": "382bd107576f2a9eb74f055fbd2f58c5a33bea68c99e32374a9cb0f9f710d152",
      "extract_claims@25": "00ca6a0c3db8f3f44f46c6b804ff51a97ebe4ce44ca6331aeb65bca2e9afb098",
      "extract_claims@26": "80de0dcfa6f2245ac2e877a6d21a6c1b3fcb7f4ce39807c051b41bf1435b284c",
      "claims_same_fact@1": "63eca8bd52746eb1e0b75706b0aa661346d4f95bc1f701b7eb68e0e5079d2262",
      "claims_same_fact@2": "9297e3628feb5e7bcee9c8e33a4a24950b6711e2a3044b853c2aa7a2aad2f155",
      "claims_standalone@1": "cf9df5348abd7c9cd8890ec8b8849f3877dc9b1e0e20c2c1e54ac850e5706065",
      "claims_said@1": "18ccc746a8ba98d17bed47453755830f1b6ff3ac3d88e980e43db0ce8ee01771",
      "task_go@1": "bdb3ae8f2b58260038e4f39562b6f496fd82a42aaa0b0e2b06144e01e7f2e20e",
      "task_go@2": "bde9a9b18efc12a03b13455d98ab70233312d3159954911a820f4de339052cd7",
    });
  });
});
