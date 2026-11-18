import { PROMPT_PINS } from "@intelligence/contracts/personal";
import { promptTextHash } from "@intelligence/personal-models";
import { describe, expect, it } from "vitest";
import { doneOrder, replayedVersions } from "./asked-version.ts";
import { COMMITMENT_BAR_VERSIONS } from "./check.ts";
import {
  AGENT_PROJECT_VERSIONS,
  ATOMIC_VERSIONS,
  agentOntology,
  baseVersion,
  CORRESPONDENCE_PROJECT_VERSIONS,
  FACT_KIND_HISTORY,
  FACT_KIND_VERSIONS,
  LANE_VERSIONS,
  MOMENT_PROJECT_VERSIONS,
  ontologyFor,
  SECOND_DEGREE_BASE,
  SECOND_DEGREE_VERSIONS,
} from "./lane-versions.ts";
import { PROMPT_VERSIONS } from "./message-prompts.ts";
import { EXTRACT_PROMPTS } from "./prompts.ts";

// What the rows give, written out once as literals: moving a row must be a decision that edits this.

describe("the rows of the prompt versions", () => {
  it("every version's text hashes to the pin the contracts hold, and every row has a prompt", () => {
    for (const prompt of EXTRACT_PROMPTS) {
      const { textHash, ...rest } = prompt;
      expect(promptTextHash(rest), `${prompt.id}@${prompt.version}`).toBe(
        PROMPT_PINS[`${prompt.id}@${prompt.version}`],
      );
      expect(textHash, `${prompt.id}@${prompt.version}`).toBe(PROMPT_PINS[`${prompt.id}@${prompt.version}`]);
    }
    expect(EXTRACT_PROMPTS).toHaveLength(Object.values(LANE_VERSIONS).reduce((sum, one) => sum + one.rows.length, 0));
  });

  it("each lane's versions, oldest first", () => {
    const versions = (lane: keyof typeof LANE_VERSIONS) => LANE_VERSIONS[lane].rows.map((one) => one.version);
    expect(versions("correspondence")).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
    expect(versions("agent")).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(versions("transaction")).toEqual(["1", "2", "3", "4"]);
    expect(versions("document")).toEqual(["1"]);
    expect(versions("meeting")).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
    expect(versions("moment")).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
      "13",
      "14",
      "15",
      "16",
    ]);
    expect(versions("ownLines")).toEqual(["1"]);
  });

  it("the versions a run asks", () => {
    expect(PROMPT_VERSIONS).toEqual({ correspondence: "4", transaction: "2", agent: "3" });
    expect(baseVersion("document")).toBe("1");
    expect(baseVersion("meeting")).toBe("7");
    expect(baseVersion("moment")).toBe("9");
    expect(SECOND_DEGREE_BASE).toEqual({ correspondence: "4", agent: "3", meeting: "7", moment: "9" });
    expect(SECOND_DEGREE_VERSIONS).toEqual({ correspondence: "5", agent: "4", meeting: "8", moment: "10" });
    expect(FACT_KIND_VERSIONS).toEqual({
      correspondence: "11",
      agent: "9",
      meeting: "12",
      moment: "15",
      transaction: "4",
    });
  });

  it("the facts a check reads by version", () => {
    expect(FACT_KIND_HISTORY).toEqual({
      correspondence: ["6", "7", "8", "9", "10", "11"],
      agent: ["5", "6", "7", "8", "9"],
      meeting: ["9", "10", "11", "12"],
      moment: ["11", "12", "13", "14", "15", "16"],
      transaction: ["3", "4"],
    });
    expect(ATOMIC_VERSIONS).toEqual({
      correspondence: ["4", "5", "6", "7", "8", "9", "10", "11"],
      agent: ["3", "4", "5", "6", "7", "8", "9"],
    });
    expect(AGENT_PROJECT_VERSIONS).toEqual(["9"]);
    expect(CORRESPONDENCE_PROJECT_VERSIONS).toEqual(["11"]);
    expect(MOMENT_PROJECT_VERSIONS).toEqual(["16"]);
    expect(COMMITMENT_BAR_VERSIONS).toEqual({
      correspondence: ["10", "11"],
      moment: ["15", "16"],
      agent: ["9"],
    });
  });

  it("the orders a replay reads", () => {
    expect(replayedVersions("correspondence", false)).toEqual(["4", "5"]);
    expect(replayedVersions("correspondence", true)).toEqual(["4", "5", "6", "7", "8", "9", "10", "11"]);
    expect(replayedVersions("transaction", false)).toEqual(["2"]);
    expect(replayedVersions("transaction", true)).toEqual(["2", "3", "4"]);
    expect(replayedVersions("agent", false)).toEqual(["3", "4"]);
    expect(replayedVersions("agent", true)).toEqual(["3", "4", "9"]);
    expect(doneOrder("correspondence")).toEqual(["4", "5", "11", "10", "9", "8", "7", "6", "3", "2", "1"]);
    expect(doneOrder("transaction")).toEqual(["2", "4", "3", "1"]);
  });

  it("a version with no row has no types: never asked, so refused", () => {
    expect(() => ontologyFor("correspondence", "12")).toThrow();
    expect(() => agentOntology("10")).toThrow();
    expect(() => ontologyFor("moment", "17")).toThrow();
    expect(ontologyFor("document").get("commitment")?.id).toBe("commitment");
  });
});
