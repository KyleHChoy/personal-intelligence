import {
  type FactKindLane,
  KIND_NAMES,
  KIND_REGISTRY,
  PROMPT_PINS,
  whereEachFactGoes,
} from "@intelligence/contracts/personal";
import { ADDED_FACT_TYPES } from "@intelligence/personal-beliefs";
import { lookupPrompt, type Prompt, promptTextHash } from "@intelligence/personal-models";
import { describe, expect, it } from "vitest";
import { factKindPrompt } from "./asked-version.ts";
import { atomicPhrase, COMMITMENT_BAR_VERSIONS, KIND_RULE_VERSIONS, kindRules } from "./check.ts";
import { commitmentRefusal } from "./commitment-bar.ts";
import { checkCorrespondence, type EvalMessage, spanOf } from "./eval/eval-correspondence.ts";
import { MESSAGE_PROJECT_RULE, MESSAGE_PROJECT_STEP_RULE, neutral, PLAN_BELONGS_V4 } from "./fact-kind-wording.ts";
import {
  agentOntology,
  FACT_KIND_BASE,
  FACT_KIND_HISTORY,
  FACT_KIND_VERSIONS,
  ontologyFor,
  SECOND_DEGREE_VERSIONS,
  TRANSACTION_V3_TYPES,
} from "./lane-versions.ts";
import { MEETING_PROMPT_ID } from "./meeting-prompts.ts";
import { PROMPT_IDS, typeLine, typeLineV2 } from "./message-prompts.ts";
import { MOMENT_PROMPT_ID } from "./moment-prompts.ts";
import { EXTRACT_PROMPTS, FACT_KIND_LANES, factKindTypes, meetingPrompt, momentPrompt, promptFor } from "./prompts.ts";

// The fact-kind versions. Each is pinned,
// registered beside the versions it follows, asked by no lane until PI_EXTRACT_FACT_KINDS names
// it, and its kind definitions are the kind registry's (ontology/kinds.json).
const idOf = (lane: FactKindLane): string =>
  lane === "meeting" ? MEETING_PROMPT_ID : lane === "moment" ? MOMENT_PROMPT_ID : PROMPT_IDS[lane];
const at = (lane: FactKindLane, version: string): Prompt => lookupPrompt(EXTRACT_PROMPTS, idOf(lane), version);
const fk = (lane: FactKindLane): Prompt => at(lane, FACT_KIND_VERSIONS[lane]);
const conversation = ["correspondence", "agent", "meeting", "moment"] as const;
// The lasting kinds whose near misses the second wording sends to no plan.
const LASTING: readonly string[] = ["preference", "constraint", "need", "goal"];
const GUIDED = [
  "situation",
  "preference",
  "constraint",
  "goal",
  "need",
  "capability",
  "view",
  "status",
  "visited",
  "plan",
  "commitment",
];

describe("the fact-kind versions", () => {
  it("each is pinned: its text hashes to its recorded hash, which is the contracts' pin", () => {
    expect(Object.fromEntries(FACT_KIND_LANES.map((lane) => [lane, `${fk(lane).id}@${fk(lane).version}`]))).toEqual({
      correspondence: "personal_correspondence@11",
      agent: "personal_agent_record@9",
      meeting: "personal_meeting@12",
      moment: "personal_moment@15",
      transaction: "personal_transaction@4",
    });
    for (const lane of FACT_KIND_LANES) {
      const { textHash, ...rest } = fk(lane);
      expect(promptTextHash(rest), lane).toBe(textHash);
      expect(PROMPT_PINS[`${fk(lane).id}@${fk(lane).version}`], lane).toBe(textHash);
    }
  });

  it("no lane asks one today: each lane's current version is unchanged", () => {
    expect(promptFor("correspondence").version).toBe("4");
    expect(promptFor("agent").version).toBe("3");
    expect(promptFor("transaction").version).toBe("2");
    expect(meetingPrompt().version).toBe("7");
    expect(momentPrompt().version).toBe("9");
  });

  it("a conversation lane's is its second-degree version with view, status and visited added, every line of it kept in order, the owner named as the owner", () => {
    for (const lane of conversation) {
      expect(FACT_KIND_BASE[lane], lane).toBe(SECOND_DEGREE_VERSIONS[lane]);
      const base = at(lane, FACT_KIND_BASE[lane]).instructions.split("\n");
      // The latest of an agent record and of mail reword their mentions and project types (below).
      const earlier = { agent: "7", correspondence: "10" } as Partial<Record<FactKindLane, string>>;
      const text = at(lane, earlier[lane] ?? FACT_KIND_VERSIONS[lane]).instructions.split("\n");
      let from = 0;
      for (const line of base.map(neutral)) {
        const found = line.startsWith("Text fields: ")
          ? text.findIndex((one, n) => n >= from && one.startsWith(line.replace(/\.$/, ";")))
          : text.indexOf(line, from);
        expect(found, `${lane}: ${line.slice(0, 60)}`).toBeGreaterThanOrEqual(from);
        from = found + 1;
      }
      for (const type of ADDED_FACT_TYPES) expect(text, `${lane}: ${type.id}`).toContain(typeLineV2(type));
      expect(fk(lane).instructions, lane).toContain("is a status about the owner, never a situation");
      expect(fk(lane).instructions, lane).toContain('"type":"view"');
      expect(fk(lane).instructions, lane).toContain('"type":"visited"');
    }
  });

  it("the transaction lane's offers a status in place of the situation, and a notice never a situation", () => {
    const text = fk("transaction").instructions;
    expect(TRANSACTION_V3_TYPES.map((type) => type.id)).toEqual(["transaction.receipt", "status", "plan"]);
    expect(text).toContain(typeLine(TRANSACTION_V3_TYPES[1] as never));
    expect(text).not.toContain("- situation: ");
    expect(text).toContain("A notice never gives a situation.");
    expect(text).toContain('"type":"status"');
    expect(text).not.toContain('"type":"situation"');
  });

  it("each kind's definition and its guide are the kind registry's, for every kind the version offers", () => {
    for (const lane of FACT_KIND_LANES) {
      const text = fk(lane).instructions;
      const types = lane === "transaction" ? TRANSACTION_V3_TYPES : factKindTypes(lane);
      const offered = new Set(types.map((type) => type.id));
      // The added kinds' lines show the registry's definition.
      for (const type of types.filter((one) => ADDED_FACT_TYPES.some((added) => added.id === one.id))) {
        const entry = KIND_REGISTRY.kinds[type.id as "view"];
        expect(type.meaning, `${lane}: ${type.id}`).toBe(entry.means);
        expect(text, `${lane}: ${type.id}`).toContain(`- ${type.id}: ${entry.means}.`);
      }
      // The guide: each offered kind's belongs and every misfiling, in the registry's words. A
      // conversation lane's second wording also guides role and affiliation, sends no lasting
      // kind's near miss to a plan, and names the owner as the owner; its fourth has a plan's
      // belongs of its own.
      const second = lane !== "transaction";
      const words = (registry: string): string => (second ? neutral(registry) : registry);
      const guided = KIND_NAMES.filter(
        (kind) =>
          (GUIDED.includes(kind) || (second && (kind === "role" || kind === "affiliation"))) &&
          offered.has(KIND_REGISTRY.kinds[kind].type ?? ""),
      );
      expect(guided.length, lane).toBeGreaterThan(1);
      for (const kind of guided) {
        const entry = KIND_REGISTRY.kinds[kind];
        const line = text
          .split("\n")
          .find((one) =>
            one.startsWith(
              `- ${kind}: ${second && kind === "plan" ? PLAN_BELONGS_V4 : words(entry.belongs.join("; "))}. Not here: `,
            ),
          );
        expect(line, `${lane}: ${kind}`).toBeDefined();
        for (const one of entry.notBelongs) {
          const dropped = second && LASTING.includes(kind) && one.goes === "plan";
          if (dropped) expect(line, `${lane}: ${kind}`).not.toContain(`${words(one.what)} (`);
          else expect(line, `${lane}: ${kind}`).toContain(`${words(one.what)} (`);
        }
      }
      // A misfiling goes to a kind the version offers, to that person, or to no claim here.
      for (const line of text
        .split("\n")
        .filter((one) => guided.some((kind) => one.startsWith(`- ${kind}: `)) && one.includes(". Not here: "))) {
        for (const [, where] of line.matchAll(/\(([^()]+)\)/g))
          expect(
            where === "no claim here" ||
              where === "a claim about that person" ||
              offered.has(String(where).replace("goes to ", "")),
            `${lane}: ${where}`,
          ).toBe(true);
      }
    }
  });

  it("no earlier version offers view, visited or status, and each fact-kind view checks what its prompt offers", () => {
    const later = new Set([
      ...FACT_KIND_LANES.flatMap((lane) => FACT_KIND_HISTORY[lane].map((version) => `${idOf(lane)}@${version}`)),
      // The own-lines lane's only version is built on these kinds.
      "personal_own_lines@1",
    ]);
    for (const prompt of EXTRACT_PROMPTS.filter((one) => !later.has(`${one.id}@${one.version}`))) {
      for (const kind of ["view", "visited", "status"])
        expect(prompt.instructions, `${prompt.id}@${prompt.version}`).not.toContain(`- ${kind}: `);
    }
    for (const lane of ["correspondence", "meeting", "moment"] as const) {
      expect(ontologyFor(lane, FACT_KIND_VERSIONS[lane]).get("view")?.id, lane).toBe("view");
      expect(ontologyFor(lane, FACT_KIND_VERSIONS[lane]).get("visited")?.id, lane).toBe("visited");
      expect(ontologyFor(lane, FACT_KIND_VERSIONS[lane]).get("intro_offer")?.id, lane).toBe("intro_offer");
      expect(ontologyFor(lane, FACT_KIND_VERSIONS[lane]).get("status")?.id, lane).toBe("status");
      expect(ontologyFor(lane, SECOND_DEGREE_VERSIONS[lane]).get("view"), lane).toBeNull();
    }
    expect(agentOntology(FACT_KIND_VERSIONS.agent).get("view")?.id).toBe("view");
    expect(agentOntology(SECOND_DEGREE_VERSIONS.agent).get("view")).toBeNull();
    expect(ontologyFor("transaction", "3").get("status")?.id).toBe("status");
    expect(ontologyFor("transaction", "3").get("situation")).toBeNull();
    expect(ontologyFor("transaction", "2").get("status")).toBeNull();
  });
});

describe("factKindPrompt: which version a new item is asked", () => {
  const probe = (answers: Record<string, boolean>, probed: string[]) => async (prompt: Prompt) => {
    probed.push(prompt.version);
    return answers[prompt.version] ?? false;
  };

  it("off, the lane's current version or the second-degree one, as before, and nothing more is read", async () => {
    for (const lane of conversation) {
      const current = lane === "meeting" ? meetingPrompt() : lane === "moment" ? momentPrompt() : promptFor(lane);
      const probed: string[] = [];
      expect(
        await factKindPrompt(lane, current, { secondDegree: false, factKinds: false }, probe({}, probed)),
        lane,
      ).toBe(current);
      expect(probed, lane).toEqual([]);
      expect(
        (await factKindPrompt(lane, current, { secondDegree: true, factKinds: false }, probe({}, probed))).version,
        lane,
      ).toBe(SECOND_DEGREE_VERSIONS[lane]);
    }
    const probed: string[] = [];
    expect(
      await factKindPrompt(
        "transaction",
        promptFor("transaction"),
        { secondDegree: true, factKinds: false },
        probe({}, probed),
      ),
    ).toBe(promptFor("transaction"));
    expect(probed).toEqual([]);
  });

  it("on, a correspondence item with a saved call of any of its versions replays it, so an anchor buys nothing", async () => {
    const on = { secondDegree: false, factKinds: true };
    const current = promptFor("correspondence");
    for (const version of FACT_KIND_HISTORY.correspondence)
      expect(
        (await factKindPrompt("correspondence", current, on, probe({ [version]: true }, []))).version,
        version,
      ).toBe(version);
    expect((await factKindPrompt("correspondence", current, on, probe({}, []))).version).toBe(
      FACT_KIND_VERSIONS.correspondence,
    );
  });

  it("on, a transaction item with a saved call of any of its versions replays it, the oldest first", async () => {
    const on = { secondDegree: false, factKinds: true };
    const current = promptFor("transaction");
    for (const version of FACT_KIND_HISTORY.transaction)
      expect((await factKindPrompt("transaction", current, on, probe({ [version]: true }, []))).version, version).toBe(
        version,
      );
    const both = { [current.version]: true, [FACT_KIND_VERSIONS.transaction]: true };
    expect(await factKindPrompt("transaction", current, on, probe(both, []))).toBe(current);
    const [third, fourth] = FACT_KIND_HISTORY.transaction as readonly string[] as [string, string];
    expect(
      (await factKindPrompt("transaction", current, on, probe({ [third]: true, [fourth]: true }, []))).version,
    ).toBe(third);
    expect((await factKindPrompt("transaction", current, on, probe({}, []))).version).toBe(
      FACT_KIND_VERSIONS.transaction,
    );
  });

  it("on, an item with a saved call of the current or the second-degree version keeps it; a new item is asked the fact-kind version", async () => {
    for (const lane of FACT_KIND_LANES) {
      const current = lane === "meeting" ? meetingPrompt() : lane === "moment" ? momentPrompt() : promptFor(lane);
      const on = { secondDegree: false, factKinds: true };
      expect(await factKindPrompt(lane, current, on, probe({ [current.version]: true }, [])), lane).toBe(current);
      if (lane !== "transaction")
        expect(
          (await factKindPrompt(lane, current, on, probe({ [SECOND_DEGREE_VERSIONS[lane]]: true }, []))).version,
          lane,
        ).toBe(SECOND_DEGREE_VERSIONS[lane]);
      expect(await factKindPrompt(lane, current, on, probe({}, [])), lane).toBe(fk(lane));
    }
  });
});

// Every registered message version that asks one fact per claim, and
// only those, has a commitment's and a plan's `what` grounded as a phrase, so no version built on
// an atomic one can be left out of the check.
describe("atomicPhrase covers every atomic version registered", () => {
  it("a correspondence or agent-record version is atomic in the check exactly when its text asks one fact per claim", () => {
    const lanes = { personal_correspondence: "correspondence", personal_agent_record: "agent" } as const;
    const asked = EXTRACT_PROMPTS.filter((prompt) => Object.hasOwn(lanes, prompt.id));
    expect(asked.length).toBeGreaterThan(8);
    for (const prompt of asked) {
      const lane = lanes[prompt.id as keyof typeof lanes];
      const oneFact = prompt.instructions.includes("One fact per claim. A claim states one proposition.");
      expect(
        atomicPhrase({ lane, promptVersion: prompt.version }, "plan", "what"),
        `${prompt.id}@${prompt.version}`,
      ).toBe(oneFact);
      expect(
        atomicPhrase({ lane, promptVersion: prompt.version }, "commitment", "what"),
        `${prompt.id}@${prompt.version}`,
      ).toBe(oneFact);
    }
    for (const version of ["4", "5", "6"])
      expect(atomicPhrase({ lane: "correspondence", promptVersion: version }, "plan", "what"), version).toBe(true);
    for (const version of ["3", "4", "5"])
      expect(atomicPhrase({ lane: "agent", promptVersion: version }, "plan", "what"), version).toBe(true);
  });
});

// The pinned kind rules (dated_task, agent_instruction, not_about_owner) apply
// to the fact-kind versions only, never to a stored record or an earlier version's saved call.
describe("the second fact-kind wording", () => {
  it("names the owner by no gendered pronoun outside its examples, while each first wording keeps its text", () => {
    for (const lane of conversation) {
      const first = FACT_KIND_HISTORY[lane][0];
      const latest = FACT_KIND_VERSIONS[lane];
      const body = (version: string): string =>
        at(lane, version as string)
          .instructions.split("\n")
          .filter((line) => !line.startsWith("Example "))
          .join("\n");
      expect(body(latest), lane).not.toMatch(/\b(he|his|him|himself)\b/i);
      expect(body(first as string), lane).toMatch(/\bhis\b/);
    }
  });

  it("copies a status's fields, and sends none of the lasting kinds' near misses to a plan", () => {
    for (const lane of conversation) {
      const text = fk(lane).instructions;
      expect(text, lane).toContain("organization_name, process and state each copy the fewest words of the message");
      for (const what of [
        "a choice made once in this exchange",
        "a one-off conflict on a date",
        "a wish to meet or talk",
      ])
        expect(text, lane).not.toContain(what);
      expect(at(lane, FACT_KIND_HISTORY[lane][0] as string).instructions, lane).toContain(
        "a one-off conflict on a date",
      );
    }
  });
});

describe("the third fact-kind wording", () => {
  it("keeps an objective with a target date a goal, while the earlier wordings keep their dated-items rule", () => {
    for (const lane of conversation) {
      const [first, second] = FACT_KIND_HISTORY[lane];
      const text = fk(lane).instructions;
      expect(text, lane).toContain("An objective pursued over weeks or longer stays a goal even with a target date");
      expect(text, lane).not.toContain("A task, a deadline, a bill due");
      for (const version of [first, second])
        expect(at(lane, version as string).instructions, `${lane}@${version}`).toContain(
          "A task, a deadline, a bill due",
        );
    }
  });
});

describe("the fourth fact-kind wording", () => {
  const NEW_LINES = [
    "A plan is an arrangement with a stated date, a real deadline or a single task due on a stated date, stated as such",
    "its what says what it is by itself",
    "an objective stated in passing with a clear aim is still a goal",
    "lists the owner's own calendar gives no claim from those lines",
    "including a time followed by a title",
    "A heading, a name pair or a remark with no stated arrangement is no plan.",
    `- plan: ${PLAN_BELONGS_V4}. Not here: `,
    "an objective with a target date (goes to goal)",
    "a calendar line restated in a schedule or a digest (no claim here)",
  ];
  const REGISTRY_PLAN = `- plan: ${KIND_REGISTRY.kinds.plan.belongs.join("; ")}. Not here: `;

  it("narrows a plan in each conversation lane, while the earlier wordings keep their lines", () => {
    for (const lane of conversation) {
      const text = fk(lane).instructions;
      for (const line of NEW_LINES) expect(text, `${lane}: ${line}`).toContain(line);
      expect(text, lane).not.toContain(REGISTRY_PLAN);
      expect(text, lane).not.toContain("only an arrangement or a single task due on a date is a plan");
      for (const version of FACT_KIND_HISTORY[lane].slice(0, 3)) {
        const earlier = at(lane, version).instructions;
        expect(earlier, `${lane}@${version}`).toContain(REGISTRY_PLAN);
        for (const line of NEW_LINES) expect(earlier, `${lane}@${version}: ${line}`).not.toContain(line);
      }
      const third = at(lane, FACT_KIND_HISTORY[lane][2] as string).instructions;
      expect(third, lane).toContain("only an arrangement or a single task due on a date is a plan");
    }
  });

  it("leaves the registry's plan entry, which the classifier's type guide reads, and the transaction lane's guide", () => {
    expect(whereEachFactGoes(["plan"])).toContain(KIND_REGISTRY.kinds.plan.belongs[0]);
    expect(KIND_REGISTRY.kinds.plan.belongs[0]).toContain("a deadline");
    expect(fk("transaction").instructions).toContain(REGISTRY_PLAN);
    expect(fk("transaction").instructions).not.toContain(PLAN_BELONGS_V4);
  });
});

describe("the fifth fact-kind wording", () => {
  const NEW_LINES = [
    "A commitment is a promise to do a stated thing, and its what names the action and its own object",
    "A remark is no commitment",
    "An ask is no commitment of anyone's until the one asked agrees.",
    "the speaker when the speaker says I will, never the person spoken to",
  ];

  it("is the mail and chat lanes' alone, and their earlier wordings keep their text", () => {
    for (const lane of ["correspondence", "moment"] as const) {
      for (const line of NEW_LINES) expect(fk(lane).instructions, `${lane}: ${line}`).toContain(line);
      for (const version of FACT_KIND_HISTORY[lane].slice(0, 4))
        for (const line of NEW_LINES) expect(at(lane, version).instructions, `${lane}@${version}`).not.toContain(line);
    }
    for (const lane of ["agent", "meeting"] as const)
      for (const line of NEW_LINES) expect(fk(lane).instructions, `${lane}: ${line}`).not.toContain(line);
  });

  it("the bar rides on it alone: an earlier version's saved call replays as it did", () => {
    expect(COMMITMENT_BAR_VERSIONS).toEqual({ correspondence: ["10", "11"], moment: ["15", "16"], agent: ["9"] });
  });

  it("every commitment in a lane's own example passes the bar it is held to", () => {
    for (const lane of ["correspondence", "moment"] as const) {
      const whats = [...fk(lane).instructions.matchAll(/"type":"commitment"[^}]*?"what":"([^"]+)"/g)].map(
        (one) => one[1] as string,
      );
      for (const what of whats) {
        const verdict = commitmentRefusal({ what, subject: "a", counterparty: "b", speaker: undefined });
        expect(verdict, `${lane}: ${what}`).toBeNull();
      }
    }
  });
});

describe("the kind rules by version", () => {
  it("name each lane's fact-kind version and no other", () => {
    expect(KIND_RULE_VERSIONS).toEqual({
      correspondence: ["6", "7", "8", "9", "10", "11"],
      agent: ["5", "6", "7", "8", "9"],
      meeting: ["9", "10", "11", "12"],
      moment: ["11", "12", "13", "14", "15", "16"],
      transaction: ["3", "4"],
    });
    for (const lane of FACT_KIND_LANES) {
      expect(kindRules({ lane, promptVersion: FACT_KIND_VERSIONS[lane] }), lane).toBe(true);
      expect(kindRules({ lane, promptVersion: FACT_KIND_BASE[lane] }), lane).toBe(false);
      expect(kindRules({ lane }), lane).toBe(false);
    }
    expect(kindRules({ lane: "document", promptVersion: "1" })).toBe(false);
  });

  const OWNER = "sam@harbor.example";
  const message = (sentence: string): EvalMessage => ({
    id: "kind-01",
    from: OWNER,
    to: "lena.park@north.example",
    paragraphs: [sentence],
    expected: [],
  });
  const AT = "2026-03-02T09:00:00.000Z";
  async function said(version: "4" | "6", sentence: string, type: string, fields: Record<string, unknown>) {
    const one = message(sentence);
    const claim = {
      type,
      subject: { key: { kind: "address", value: OWNER }, observedAt: AT },
      fields,
      statementKind: "stated_fact",
      basis: "explicit_self",
      span: await spanOf(one, sentence),
    };
    return checkCorrespondence(one, { claims: [claim], narrowing: "none" } as never, version);
  }

  it("a dated task filed as the owner's situation is kept under version 4 as before, and refused dated_task under version 6", async () => {
    const args = [
      "I have a dentist appointment.",
      "situation",
      { state: "dentist appointment", domain: "health" },
    ] as const;
    expect((await said("4", ...args)).claims).toHaveLength(1);
    const refused = await said("6", ...args);
    expect(refused.claims).toEqual([]);
    expect(refused.unmapped.map((one) => one.reason)).toEqual(["dated_task"]);
  });

  it("the owner's view, an organization's process about the owner and a place they have been are kept under version 6, and are no type of version 4", async () => {
    const view = [
      "I think small teams ship faster.",
      "view",
      { view: "small teams ship faster", topic: "small teams", domain: "career" },
    ] as const;
    const status = [
      "The Alder Consulate has my visa application under review.",
      "status",
      { organization_name: "Alder Consulate", process: "visa application", state: "under review", domain: "travel" },
    ] as const;
    const visited = [
      "I was in Lisbon on March 1.",
      "visited",
      { place: "Lisbon", domain: "travel", when: "2026-03-01" },
    ] as const;
    for (const [sentence, type, fields] of [view, status, visited]) {
      expect(
        (await said("6", sentence, type, fields)).claims.map((one) => one.claim.content.type),
        type,
      ).toEqual([type]);
      expect((await said("4", sentence, type, fields)).claims, type).toEqual([]);
    }
  });
});

// An agent record's version 9: a finding names the owner and its project. The other lanes and the
// agent's earlier versions do not change.
describe("an agent record's fifth fact-kind wording", () => {
  const v9 = () => at("agent", "9").instructions;

  it("is the latest of its lane, and no other lane has it", () => {
    expect(FACT_KIND_VERSIONS.agent).toBe("9");
    for (const lane of ["correspondence", "meeting", "moment", "transaction"] as const) {
      expect(fk(lane).instructions, lane).not.toContain("owner:this");
      expect(fk(lane).instructions, lane).not.toContain("project.fact");
    }
    for (const version of ["5", "6", "7", "8"]) {
      expect(at("agent", version).instructions, version).not.toContain("owner:this");
      expect(at("agent", version).instructions, version).not.toContain("project.next_step");
    }
  });

  it("teaches the owner mention, project:this for a filed finding, the two new types, with an example", () => {
    const text = v9();
    expect(text).toContain('"value": "owner:this"');
    expect(text).toContain("The project this finding is filed under");
    expect(text).not.toContain("This thread's project");
    expect(text).not.toContain("this thread's project");
    expect(text).not.toContain("named only by an address");
    expect(text).toContain("- project.fact: ");
    expect(text).toContain("- project.next_step: ");
    expect(text).toContain("Example finding filed under a project");
    expect(text).toContain('"type":"project.next_step"');
    expect(text).toContain('"value":"owner:this"');
  });

  it("the new types' definitions are the registry's, and only this version's view takes them", () => {
    for (const kind of ["project_fact", "project_next_step"] as const) {
      expect(v9()).toContain(KIND_REGISTRY.kinds[kind].means);
    }
    expect(agentOntology("9").get("project.fact")?.id).toBe("project.fact");
    expect(agentOntology("9").get("project.next_step")?.id).toBe("project.next_step");
    expect(agentOntology("8").get("project.fact")).toBeNull();
    expect(agentOntology("8").get("view")?.id).toBe("view");
    expect(ontologyFor("correspondence", FACT_KIND_VERSIONS.correspondence).get("project.fact")).toBeNull();
    expect(ontologyFor("meeting", FACT_KIND_VERSIONS.meeting).get("project.next_step")).toBeNull();
  });
});

describe("correspondence's sixth fact-kind wording", () => {
  const v11 = (): string => at("correspondence", "11").instructions;
  const v10 = (): string => at("correspondence", "10").instructions;

  it("tells of the message's project and offers its next step, and the fifth keeps its text", () => {
    expect(v11()).toContain(MESSAGE_PROJECT_RULE);
    expect(v11()).toContain(MESSAGE_PROJECT_STEP_RULE);
    expect(v11()).toContain("project.next_step");
    expect(v11()).not.toContain("this thread's project");
    expect(v11()).not.toContain("filed under");
    expect(v10()).not.toContain(MESSAGE_PROJECT_RULE);
    expect(v10()).not.toContain("project.next_step");
    expect(v10()).toContain("this thread's project");
  });

  it("its view takes a next step and no project detail, and the fifth's neither", () => {
    expect(ontologyFor("correspondence", "11").get("project.next_step")?.id).toBe("project.next_step");
    expect(ontologyFor("correspondence", "11").get("project.fact")).toBeNull();
    expect(ontologyFor("correspondence", "11").get("view")?.id).toBe("view");
    expect(ontologyFor("correspondence", "10").get("project.next_step")).toBeNull();
    expect(ontologyFor("correspondence", "10").get("view")?.id).toBe("view");
  });
});
