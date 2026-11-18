import {
  DECISION_POINT_PINS,
  DECISION_POINTS,
  DecisionPointDefinition,
  EFFECT_CLASS,
  POINT_THRESHOLDS,
  PROMPT_PINS,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { CLAIM_INTAKE_POINTS, DEFAULT_THRESHOLDS, EXTRACT_DECISION_POINTS, runThresholds } from "./decision-points.ts";
import { documentPrompt, meetingPrompt, meetingPromptAt, momentPrompt, momentPromptAt, promptFor } from "./prompts.ts";
import { DECIDE_RECORD, DECIDE_RECOVERY, DECIDE_SCREEN } from "./question-prompts.ts";

const decidePin = { id: DECIDE_SCREEN.id, version: DECIDE_SCREEN.version, textHash: DECIDE_SCREEN.textHash };

describe("the six decision points", () => {
  it("the decision points name the prompts and hashes a run asks (the agent record's three, the document prompt, the meeting prompt and the moment prompt, under extract_claims@26, with correspondence at version 4, the transaction prompt at version 2, the agent record at version 3, the meeting prompt at version 7 and the moment prompt at version 9), DECIDE_SCREEN, DECIDE_RECOVERY and DECIDE_RECORD, their effects are set_lane, to_checker, withhold_item, hold_message and record_silence, and no output has an external effect", () => {
    expect(EXTRACT_DECISION_POINTS.map((point) => `${point.id}@${point.version}`)).toEqual([
      "extract_triage@5",
      "extract_claims@26",
      "extract_injection@2",
      "extract_sensitivity@2",
      "extract_recovery@1",
      "record_injection@3",
    ]);
    const [triage, claims, injection, sensitivity, recovery, record] = EXTRACT_DECISION_POINTS;
    // The document, meeting and moment lanes among triage's outputs, and their prompts among the
    // claims'.
    expect(triage.outputs).toEqual({
      correspondence: "set_lane",
      transaction: "set_lane",
      skip: "set_lane",
      document: "set_lane",
      meeting: "set_lane",
      moment: "set_lane",
    });
    expect(claims.prompts.map((prompt) => prompt.id)).toEqual([
      "personal_correspondence",
      "personal_transaction",
      "personal_agent_record",
      "personal_document",
      "personal_meeting",
      "personal_moment",
    ]);
    expect(triage.rungs).toEqual([0, 1]);
    expect(claims.rungs).toEqual([2]);
    expect(injection.rungs).toEqual([1]);
    expect(sensitivity.rungs).toEqual([1]);
    expect(recovery.rungs).toEqual([1]);
    expect(record.rungs).toEqual([1]);
    // Version 5 pins the prompts a run asks, the agent record's version 2 and the document prompt
    // among them.
    expect(claims.version).toBe(26);
    expect(claims.pins).toEqual([
      ...(["correspondence", "transaction", "agent"] as const).map((lane) => ({
        lane,
        id: promptFor(lane).id,
        version: promptFor(lane).version,
        textHash: promptFor(lane).textHash,
      })),
      {
        lane: "document",
        id: documentPrompt().id,
        version: documentPrompt().version,
        textHash: documentPrompt().textHash,
      },
      { lane: "meeting", id: meetingPrompt().id, version: meetingPrompt().version, textHash: meetingPrompt().textHash },
      { lane: "moment", id: momentPrompt().id, version: momentPrompt().version, textHash: momentPrompt().textHash },
    ]);
    expect(claims.pins.map((one) => `${one.id}@${one.version}`)).toEqual([
      "personal_correspondence@4",
      "personal_transaction@2",
      "personal_agent_record@3",
      "personal_document@1",
      "personal_meeting@7",
      "personal_moment@9",
    ]);
    for (const point of [triage, injection, sensitivity]) {
      expect(point.prompts).toEqual([{ id: "jev_screen", version: "1" }]);
      expect(point.pins).toEqual([decidePin]);
    }
    expect(recovery.pins).toEqual([
      { id: DECIDE_RECOVERY.id, version: DECIDE_RECOVERY.version, textHash: DECIDE_RECOVERY.textHash },
    ]);
    expect(record.pins).toEqual([
      { id: DECIDE_RECORD.id, version: DECIDE_RECORD.version, textHash: DECIDE_RECORD.textHash },
    ]);
    const effects = EXTRACT_DECISION_POINTS.flatMap((point) => Object.values(point.outputs));
    expect([...new Set(effects)].sort()).toEqual([
      "hold_message",
      "record_silence",
      "set_lane",
      "to_checker",
      "withhold_item",
    ]);
    for (const point of EXTRACT_DECISION_POINTS) {
      const {
        effectClasses,
        pins: _pins,
        thresholds: _thresholds,
        ...definition
      } = { thresholds: undefined, ...point };
      expect(DecisionPointDefinition.parse(definition)).toEqual(definition);
      for (const effect of Object.values(point.outputs)) {
        expect(effectClasses[effect as keyof typeof effectClasses]).toBe(EFFECT_CLASS[effect]);
        expect(EFFECT_CLASS[effect]).not.toBe("external");
      }
    }
    expect(claims.outputs).toEqual({
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    });
    expect(injection.outputs).toEqual({ quarantine: "withhold_item", none: "record_silence" });
    expect(sensitivity.outputs).toEqual({ special_category: "withhold_item", none: "record_silence" });
    expect(recovery.outputs).toEqual({ recovery: "hold_message", none: "record_silence" });
    expect(record.outputs).toEqual({ quarantine: "withhold_item", none: "record_silence" });
  });

  // A change is a new version.
  it("the thresholds hold the expected defaults, floors and ceilings, beside their definitions and equal to POINT_THRESHOLDS", () => {
    const [triage, claims, injection, sensitivity, recovery, record] = EXTRACT_DECISION_POINTS;
    expect(triage.thresholds).toEqual({ lane: { default: 0.5, floor: 0.2, ceiling: 0.8 } });
    // The four hold points at 0.7, each a new version.
    expect(injection.thresholds).toEqual({ hold: { default: 0.7, floor: 0.5, ceiling: 0.99 } });
    expect(sensitivity.thresholds).toEqual({ hold: { default: 0.7, floor: 0.5, ceiling: 0.99 } });
    expect(recovery.thresholds).toEqual({ hold: { default: 0.7, floor: 0.3, ceiling: 0.95 } });
    expect(record.thresholds).toEqual({ hold: { default: 0.7, floor: 0.5, ceiling: 0.99 } });
    expect("thresholds" in claims).toBe(false);
    for (const point of [triage, injection, sensitivity, recovery, record])
      expect(point.thresholds, point.id).toEqual(POINT_THRESHOLDS[`${point.id}@${point.version}`]);
  });

  it("a run with no grant applies each default, recorded with source `default`, and no rung suspended", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      lane: 0.5,
      quarantine: 0.7,
      specialCategory: 0.7,
      recovery: 0.7,
      record: 0.7,
      standalone: 0.5,
      said: 0.5,
      laneSuspended: false,
      applied: [
        { point: "extract_triage@5", name: "lane", value: 0.5, source: "default" },
        { point: "extract_injection@2", name: "hold", value: 0.7, source: "default" },
        { point: "extract_sensitivity@2", name: "hold", value: 0.7, source: "default" },
        { point: "extract_recovery@1", name: "hold", value: 0.7, source: "default" },
        { point: "record_injection@3", name: "hold", value: 0.7, source: "default" },
        { point: "claims_standalone@1", name: "accept", value: 0.5, source: "default" },
        { point: "claims_said@1", name: "accept", value: 0.5, source: "default" },
      ],
    });
  });

  it("a run's thresholds take the effective values given, and record their sources", () => {
    const grant = "thr_01J0000000000000000000000A";
    const run = runThresholds(
      {
        "extract_recovery@1": { hold: { value: 0.5, source: grant } },
        "extract_injection@2": { hold: { value: 0.85, source: `carried:${grant}` } },
      },
      ["extract_triage@5"],
    );
    expect(run.recovery).toBe(0.5);
    expect(run.quarantine).toBe(0.85);
    expect(run.record).toBe(0.7);
    expect(run.laneSuspended).toBe(true);
    expect(run.applied).toContainEqual({ point: "extract_recovery@1", name: "hold", value: 0.5, source: grant });
    expect(run.applied.some((one) => one.point === "extract_triage@5")).toBe(false);
    expect(run.applied).toContainEqual({
      point: "extract_injection@2",
      name: "hold",
      value: 0.85,
      source: `carried:${grant}`,
    });
    expect(run.applied).toContainEqual({ point: "record_injection@3", name: "hold", value: 0.7, source: "default" });
  });

  // With the lane's rung 1 suspended no lane line is applied, so none is recorded.
  it("a run whose lane rung is suspended records no lane threshold", () => {
    const run = runThresholds({}, ["extract_triage@5"]);
    expect(run.laneSuspended).toBe(true);
    expect(run.applied.map((one) => one.point)).toEqual([
      "extract_injection@2",
      "extract_sensitivity@2",
      "extract_recovery@1",
      "record_injection@3",
      "claims_standalone@1",
      "claims_said@1",
    ]);
  });

  // The meeting and moment versions, and every earlier version's pin kept for the rows that name
  // it.
  it("the decision points keep the pins of extract_triage@2 to @4 and extract_claims@1 to @6", () => {
    for (const key of [
      "extract_triage@2",
      "extract_triage@3",
      "extract_triage@4",
      "extract_claims@1",
      "extract_claims@2",
      "extract_claims@3",
      "extract_claims@4",
      "extract_claims@5",
      "extract_claims@6",
    ]) {
      expect(DECISION_POINT_PINS[key], key).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(DECISION_POINT_PINS["extract_triage@4"]).toBe(
      "98ab4417b71be55b5f3529da7dee608d622ecfbbfb9fe56654fade8137401000",
    );
    expect(DECISION_POINT_PINS["extract_claims@6"]).toBe(
      "8e0fa4d23e634d19b45ef671ca66c3b95f6eab1fe74afce6cabf9f23b96d09bb",
    );
    expect(PROMPT_PINS["personal_meeting@1"]).toBe(meetingPromptAt("1").textHash);
    expect(PROMPT_PINS["personal_moment@1"]).toBe(momentPromptAt("1").textHash);
    // The new versions are registered in the contracts' copy, equal to these.
    for (const [id, version] of [
      ["extract_triage", 4],
      ["extract_triage", 5],
      ["extract_claims", 6],
      ["extract_claims", 7],
    ] as const) {
      expect(
        DECISION_POINTS.some((one) => one.id === id && one.version === version),
        `${id}@${version}`,
      ).toBe(true);
    }
    const [triage, claims] = EXTRACT_DECISION_POINTS;
    for (const point of [triage, claims]) {
      const copy = DECISION_POINTS.find((one) => one.id === point.id && one.version === point.version);
      expect({ outputs: copy?.outputs, prompts: copy?.prompts, rungs: copy?.rungs }).toEqual({
        outputs: point.outputs,
        prompts: point.prompts,
        rungs: point.rungs,
      });
    }
    expect(POINT_THRESHOLDS["extract_triage@5"]).toEqual(POINT_THRESHOLDS["extract_triage@4"]);
  });

  // extract_claims@8 asks correspondence's version 3; @7 and version 2 stay pinned.
  it("extract_claims@8 is registered in the contracts' copy, and @7 and personal_correspondence@2 keep their pins", () => {
    expect(DECISION_POINTS.some((one) => one.id === "extract_claims" && one.version === 7)).toBe(true);
    expect(DECISION_POINTS.some((one) => one.id === "extract_claims" && one.version === 8)).toBe(true);
    expect(DECISION_POINT_PINS["extract_claims@7"]).toBe(
      "57d1eaabb662c10e253438ecf03e5ae4933ff9503f29812e443fe8c5955e7f29",
    );
    expect(PROMPT_PINS["personal_correspondence@2"]).toBe(
      "ff081ddda3939fa7857a748b9ecfff952054be777cffdfc35fccd3654d138694",
    );
    expect(PROMPT_PINS["personal_correspondence@3"]).toBe(
      "d344e976fca6f71c045b236b9aa694b363313f7ae8c924fb966005f07f7d0b24",
    );
  });

  // extract_claims@24 is the run's, version 23 with the two atomic prompt versions; @23 keeps its
  // pin for the rows that name it, and 9, reserved for them and never asked, has no pin.
  it("the go: extract_claims@24 is version 23 with correspondence 4 and agent record 3, registered in the contracts beside @23", () => {
    const v23 = DECISION_POINTS.find((one) => one.id === "extract_claims" && one.version === 23);
    const v24 = DECISION_POINTS.find((one) => one.id === "extract_claims" && one.version === 24);
    expect(v23?.prompts?.map((one) => `${one.id}@${one.version}`)).toEqual([
      "personal_correspondence@3",
      "personal_transaction@2",
      "personal_agent_record@2",
      "personal_document@1",
      "personal_meeting@7",
      "personal_moment@7",
    ]);
    expect(v24?.prompts?.map((one) => `${one.id}@${one.version}`)).toEqual([
      "personal_correspondence@4",
      "personal_transaction@2",
      "personal_agent_record@3",
      "personal_document@1",
      "personal_meeting@7",
      "personal_moment@7",
    ]);
    // Every prompt but the two atomic versions is version 23's.
    expect(
      v24?.prompts?.filter((one) => one.id !== "personal_correspondence" && one.id !== "personal_agent_record"),
    ).toEqual(
      v23?.prompts?.filter((one) => one.id !== "personal_correspondence" && one.id !== "personal_agent_record"),
    );
    for (const one of v24?.prompts ?? [])
      expect(PROMPT_PINS[`${one.id}@${one.version}`], one.id).toMatch(/^[0-9a-f]{64}$/);
    expect(DECISION_POINT_PINS["extract_claims@23"]).toBe(
      "e113d4cab8de1010b1f7484cbe7708d9d448e6c5058ead5af6e260665ab99dd5",
    );
    expect(DECISION_POINT_PINS["extract_claims@24"]).toMatch(/^[0-9a-f]{64}$/);
    expect(DECISION_POINTS.some((one) => one.id === "extract_claims" && one.version === 9)).toBe(false);
    expect(DECISION_POINT_PINS["extract_claims@9"]).toBeUndefined();
  });

  // extract_claims@10 asks personal_meeting version 2; @8 and the meeting prompt's
  // version 1 keep their pins for the rows that name them.
  it("extract_claims@10 is registered in the contracts' copy beside @8, and personal_meeting@1 keeps its pin", () => {
    for (const version of [8, 10])
      expect(
        DECISION_POINTS.some((one) => one.id === "extract_claims" && one.version === version),
        `@${version}`,
      ).toBe(true);
    expect(DECISION_POINT_PINS["extract_claims@8"]).toBe(
      "b19375f84477da438cec8702690841990b5a489684c1a80de2aff0d7901d7545",
    );
    expect(DECISION_POINT_PINS["extract_claims@10"]).toMatch(/^[0-9a-f]{64}$/);
    expect(PROMPT_PINS["personal_meeting@1"]).toBe("a437cfcd43df5f65c51c4bfa3d0790a90423d02a92d9e4d16291aa24ebb6e740");
    expect(PROMPT_PINS["personal_meeting@2"]).toBe("21878fc8529a1dee616c10ef2e731a49548637a078f367f66fcd2fef3a0105da");
  });

  // extract_claims@11 asks personal_moment version 2; @10 and the moment prompt's
  // version 1 keep their pins for the rows that name them.
  it("extract_claims@11 is registered in the contracts' copy beside @10, and personal_moment@1 keeps its pin", () => {
    for (const version of [10, 11])
      expect(
        DECISION_POINTS.some((one) => one.id === "extract_claims" && one.version === version),
        `@${version}`,
      ).toBe(true);
    expect(DECISION_POINT_PINS["extract_claims@10"]).toBe(
      "aab8bfe7362c642c03380c5b1c85e27e571b15d10115239fe60acd296fed430e",
    );
    expect(DECISION_POINT_PINS["extract_claims@11"]).toMatch(/^[0-9a-f]{64}$/);
    expect(PROMPT_PINS["personal_moment@1"]).toBe("1811374f3d1263d385471fa78616c1d198270bbda795552ebf5a21f160187cd3");
    expect(PROMPT_PINS["personal_moment@2"]).toBe(momentPromptAt("2").textHash);
  });

  // extract_claims@12 asks personal_moment version 3; @11 and the moment prompt's
  // versions 1 and 2 keep their pins for the rows that name them.
  it("extract_claims@12 is registered in the contracts' copy beside @11, and personal_moment@2 keeps its pin", () => {
    for (const version of [11, 12])
      expect(
        DECISION_POINTS.some((one) => one.id === "extract_claims" && one.version === version),
        `@${version}`,
      ).toBe(true);
    expect(DECISION_POINT_PINS["extract_claims@11"]).toBe(
      "b318d4c778893c6b5732b59f24844ba1f10a9c8c7af758b0bae0ba4166abd34c",
    );
    expect(DECISION_POINT_PINS["extract_claims@12"]).toMatch(/^[0-9a-f]{64}$/);
    expect(PROMPT_PINS["personal_moment@2"]).toBe("ec9c965d14e63bc1d394f2fd7e6dbe45672a3552bfb1a182530b91aaf219a3dc");
    expect(PROMPT_PINS["personal_moment@3"]).toBe("886bdc974b3c76b9c941cc779ab303e24e8ddc56883abd2c48304f41031abe55");
  });

  // extract_claims@18 asks personal_moment version 4; @17 and version 3 keep their pins.
  it("extract_claims@18 is registered beside @17, and personal_moment@3 keeps its pin", () => {
    for (const version of [17, 18])
      expect(
        DECISION_POINTS.some((one) => one.id === "extract_claims" && one.version === version),
        `@${version}`,
      ).toBe(true);
    expect(DECISION_POINT_PINS["extract_claims@17"]).toBe(
      "7597981de99572689cf6d7193ac1f6e843db7cb3deb555121391389d51adcfad",
    );
    expect(PROMPT_PINS["personal_moment@4"]).toBe("4860fd3035d8ed6634a2f9b6a512d0566e64c25eaf58a08f8a883f889523292f");
  });

  // extract_claims@19 asks personal_moment version 5; @18 and version 4 keep their pins.
  it("extract_claims@19 is registered beside @18, and personal_moment@4 keeps its pin", () => {
    for (const version of [18, 19])
      expect(
        DECISION_POINTS.some((one) => one.id === "extract_claims" && one.version === version),
        `@${version}`,
      ).toBe(true);
    expect(DECISION_POINT_PINS["extract_claims@18"]).toBe(
      "cacb651b7101d839945aa9f9ebaf554efe6c7440e65193b3226564df17252e2d",
    );
    expect(PROMPT_PINS["personal_moment@5"]).toBe("ba041d4854cdf29a156576f35e7deb2051461f705cbeca3527c99945fa29b449");
  });

  // extract_claims@22 asks personal_transaction version 2; @20 and version 1 keep their pins, and
  // 21, reserved for the atomic versions, is skipped: no point of version 21 is registered.
  it("extract_claims@22 is registered beside @20, 21 is skipped, and personal_transaction@1 keeps its pin", () => {
    for (const version of [20, 22])
      expect(
        DECISION_POINTS.some((one) => one.id === "extract_claims" && one.version === version),
        `@${version}`,
      ).toBe(true);
    expect(DECISION_POINTS.some((one) => one.id === "extract_claims" && one.version === 21)).toBe(false);
    expect(DECISION_POINT_PINS["extract_claims@21"]).toBeUndefined();
    expect(DECISION_POINT_PINS["extract_claims@20"]).toBe(
      "13cac2acdc707d7b115985e058250c3d52a69f2a0706373efcf724a4260c6949",
    );
    expect(PROMPT_PINS["personal_transaction@1"]).toBe(
      "e21b310b18db82b2ed5fc05047c293f5d7350bcd36efb280f2e5a478021a03a7",
    );
    expect(PROMPT_PINS["personal_transaction@2"]).toBe(promptFor("transaction").textHash);
    expect(promptFor("transaction").version).toBe("2");
    // The run's point pins its own transaction prompt, version 2, so it never
    // takes the notices back to version 1's receipt alone.
    expect(EXTRACT_DECISION_POINTS[1].pins.find((one) => one.lane === "transaction")?.version).toBe("2");
  });

  // extract_claims@20 asks personal_moment version 6; @19 and version 5 keep their pins.
  it("extract_claims@20 is registered beside @19, and personal_moment@5 keeps its pin", () => {
    for (const version of [19, 20])
      expect(
        DECISION_POINTS.some((one) => one.id === "extract_claims" && one.version === version),
        `@${version}`,
      ).toBe(true);
    expect(DECISION_POINT_PINS["extract_claims@19"]).toBe(
      "a414c8b2f75813150b031fa359e770dc41301386290e087620a1634d5991ef5f",
    );
    expect(PROMPT_PINS["personal_moment@6"]).toBe("c183e3cdf79707501bd47303fb3c6560e2731acf31a1056c73a7e04f3a2641a0");
  });

  // extract_claims@23 asks personal_moment version 7; @22 and version 6 keep their
  // pins, and the atomic versions' point carries version 7 too.
  it("extract_claims@23 is registered beside @22, and personal_moment@6 keeps its pin", () => {
    for (const version of [22, 23])
      expect(
        DECISION_POINTS.some((one) => one.id === "extract_claims" && one.version === version),
        `@${version}`,
      ).toBe(true);
    expect(DECISION_POINT_PINS["extract_claims@22"]).toBe(
      "a396fa6b15338c9e0a946b921f34aba838b550b9ad1f87a4eb8b39475d59555b",
    );
    expect(PROMPT_PINS["personal_moment@6"]).toBe("c183e3cdf79707501bd47303fb3c6560e2731acf31a1056c73a7e04f3a2641a0");
    expect(PROMPT_PINS["personal_moment@7"]).toBe("8b404f7ababf80c6227f4651d2c16b21203f971c66e354adec425fdaa61b2aaf");
  });

  // extract_claims@25 asks personal_moment version 8; @24 (the atomic versions) and version 7
  // keep their pins for the rows that name them.
  it("extract_claims@25 is version 24 with personal_moment version 8, and personal_moment@7 keeps its pin", () => {
    const v24 = DECISION_POINTS.find((one) => one.id === "extract_claims" && one.version === 24);
    const v25 = DECISION_POINTS.find((one) => one.id === "extract_claims" && one.version === 25);
    expect(v25?.prompts?.find((one) => one.id === "personal_moment")?.version).toBe("8");
    expect(v25?.prompts?.filter((one) => one.id !== "personal_moment")).toEqual(
      v24?.prompts?.filter((one) => one.id !== "personal_moment"),
    );
    expect(DECISION_POINT_PINS["extract_claims@24"]).toBe(
      "382bd107576f2a9eb74f055fbd2f58c5a33bea68c99e32374a9cb0f9f710d152",
    );
    expect(PROMPT_PINS["personal_moment@7"]).toBe("8b404f7ababf80c6227f4651d2c16b21203f971c66e354adec425fdaa61b2aaf");
    expect(PROMPT_PINS["personal_moment@8"]).toBe("ef51fb7cd0cb7f0a5c8f66478757ecf65686e990a514aa356085d0864146798c");
  });

  // extract_claims@26 asks personal_moment version 9; @25 and version 8 keep their pins.
  it("extract_claims@26 is version 25 with personal_moment version 9, and personal_moment@8 keeps its pin", () => {
    const claims = EXTRACT_DECISION_POINTS[1];
    const v25 = DECISION_POINTS.find((one) => one.id === "extract_claims" && one.version === 25);
    const v26 = DECISION_POINTS.find((one) => one.id === "extract_claims" && one.version === 26);
    expect(v26?.prompts).toEqual(claims.prompts);
    expect(v26?.prompts?.filter((one) => one.id !== "personal_moment")).toEqual(
      v25?.prompts?.filter((one) => one.id !== "personal_moment"),
    );
    for (const pin of claims.pins) expect(PROMPT_PINS[`${pin.id}@${pin.version}`], pin.id).toBe(pin.textHash);
    expect(DECISION_POINT_PINS["extract_claims@25"]).toBe(
      "00ca6a0c3db8f3f44f46c6b804ff51a97ebe4ce44ca6331aeb65bca2e9afb098",
    );
    expect(PROMPT_PINS["personal_moment@9"]).toBe(momentPrompt().textHash);
    expect(momentPrompt().version).toBe("9");
    expect(claims.pins.find((one) => one.lane === "moment")?.version).toBe("9");
  });

  // extract_claims@17 asks personal_meeting version 7; @16 and version 6 keep their pins.
  it("extract_claims@17 is registered beside @16, and personal_meeting@6 keeps its pin", () => {
    for (const version of [16, 17])
      expect(
        DECISION_POINTS.some((one) => one.id === "extract_claims" && one.version === version),
        `@${version}`,
      ).toBe(true);
    expect(DECISION_POINT_PINS["extract_claims@16"]).toBe(
      "496b503d46050751062e33f375a69cf668c47456f6957d7612d7bb64ba91bf76",
    );
    expect(PROMPT_PINS["personal_meeting@6"]).toBe("fe991d9d3c93352de93bc8a6c862f4870300cba5c3f17d13f8ce2f27e2f65701");
    expect(PROMPT_PINS["personal_meeting@7"]).toBe(meetingPrompt().textHash);
    expect(meetingPrompt().version).toBe("7");
  });

  // extract_claims@16 asks personal_meeting version 6; @15 and version 5 keep their pins.
  it("extract_claims@16 is registered beside @15, and personal_meeting@5 keeps its pin", () => {
    for (const version of [15, 16])
      expect(
        DECISION_POINTS.some((one) => one.id === "extract_claims" && one.version === version),
        `@${version}`,
      ).toBe(true);
    expect(DECISION_POINT_PINS["extract_claims@15"]).toBe(
      "debfc70f51cfa5030983c5a350285b0794c3a137c1d75036a76e4dbfbb4d71e3",
    );
  });

  // extract_claims@15 asks personal_meeting version 5; @14 and version 4 keep their pins.
  it("extract_claims@15 is registered beside @14, and personal_meeting@4 keeps its pin", () => {
    for (const version of [14, 15])
      expect(
        DECISION_POINTS.some((one) => one.id === "extract_claims" && one.version === version),
        `@${version}`,
      ).toBe(true);
    expect(DECISION_POINT_PINS["extract_claims@14"]).toBe(
      "e77cd6a41db4eca90044ec53f16627f926fa0040a4fcfc475f6b576155148a1e",
    );
    expect(PROMPT_PINS["personal_meeting@5"]).toBe("8eb8c31ff9a26fad75e0245e73a6b2119a23274d4e82270f141e72ddf9ab0dfd");
  });

  // extract_claims@14 asks personal_meeting version 4; @13 and the meeting prompt's
  // version 3 keep their pins for the rows that name them.
  it("extract_claims@14 is registered in the contracts' copy beside @13, and personal_meeting@3 keeps its pin", () => {
    for (const version of [13, 14])
      expect(
        DECISION_POINTS.some((one) => one.id === "extract_claims" && one.version === version),
        `@${version}`,
      ).toBe(true);
    expect(DECISION_POINT_PINS["extract_claims@13"]).toBe(
      "aec8b699fb63ccece1a9e65ed0445a9da242a99dc9909cd4f0663be1e658de11",
    );
    expect(DECISION_POINT_PINS["extract_claims@14"]).toMatch(/^[0-9a-f]{64}$/);
    expect(PROMPT_PINS["personal_meeting@4"]).toBe("a0785b7512a808807b4a5ed56c84e4539c05dbe43962697cfc1d2876e0c48f42");
  });

  // extract_claims@13 asks personal_meeting version 3; @12 and the meeting prompt's
  // version 2 keep their pins for the rows that name them.
  it("extract_claims@13 is registered in the contracts' copy beside @12, and personal_meeting@2 keeps its pin", () => {
    for (const version of [12, 13])
      expect(
        DECISION_POINTS.some((one) => one.id === "extract_claims" && one.version === version),
        `@${version}`,
      ).toBe(true);
    expect(DECISION_POINT_PINS["extract_claims@12"]).toBe(
      "25cf00aa598490f0bad2dc011d66f7c6bb633d1bbdddb25c94fcc30096b09747",
    );
    expect(DECISION_POINT_PINS["extract_claims@13"]).toMatch(/^[0-9a-f]{64}$/);
    expect(PROMPT_PINS["personal_meeting@3"]).toBe("9ed66dde41e81daf3e27e5bf4f9641761a1a6493778a32414ec6849804907e4b");
  });

  it("the decision points are plain data", () => {
    expect(JSON.parse(JSON.stringify(EXTRACT_DECISION_POINTS))).toEqual(EXTRACT_DECISION_POINTS);
    expect(Object.isFrozen(EXTRACT_DECISION_POINTS[1].pins[0])).toBe(true);
    expect(Object.isFrozen(EXTRACT_DECISION_POINTS[2].thresholds)).toBe(true);
    expect(Object.isFrozen(EXTRACT_DECISION_POINTS[4].thresholds.hold)).toBe(true);
  });
});

// The claim intake's two points, each equal to its copy in the contracts.
describe("the claim intake's two points", () => {
  it("each names its Jev prompt and pin and its accept line, as the contracts' DECISION_POINTS, POINT_THRESHOLDS and PROMPT_PINS give them", () => {
    for (const point of CLAIM_INTAKE_POINTS) {
      const definition = DECISION_POINTS.find((one) => one.id === point.id && one.version === point.version);
      expect(definition?.rungs, point.id).toEqual([1]);
      expect(definition?.prompts, point.id).toEqual([{ id: point.prompt.id, version: point.prompt.version }]);
      expect(definition?.outputs[point.refusal], point.id).toBe("withhold_item");
      expect(definition?.fallback, point.id).toBe(point.refusal);
      expect(EFFECT_CLASS.withhold_item).toBe("narrow");
      expect(PROMPT_PINS[`${point.prompt.id}@${point.prompt.version}`], point.id).toBe(point.prompt.textHash);
      expect(point.thresholds, point.id).toEqual(POINT_THRESHOLDS[`${point.id}@${point.version}`]);
    }
  });

  it("a suspended intake rung applies no line", () => {
    const run = runThresholds({ "claims_said@1": { accept: { value: 0.8, source: "set" } } }, ["claims_standalone@1"]);
    expect(run.standalone).toBeNull();
    expect(run.said).toBe(0.8);
  });
});
