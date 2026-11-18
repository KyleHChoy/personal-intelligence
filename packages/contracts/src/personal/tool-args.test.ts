import { describe, expect, it } from "vitest";
import {
  canonicalTimeZone,
  dayIn,
  hourIn,
  instantOf,
  PersonalReadTool,
  PersonalToolArgs,
  startOfDay,
} from "./index.ts";

// What a read tool's JSON schema tells a model about its arguments must be what the tool takes:
// every example in a schema parses, and every time bound says its form, which is a check the
// schema cannot show; a model that follows a wrong example sends arguments the tools refuse.

type Schema = { properties?: Record<string, { type?: string; description?: string }>; examples?: unknown[] };
const schemaOf = (tool: PersonalReadTool): Schema => PersonalToolArgs[tool].toJSONSchema({ io: "input" }) as Schema;

describe("the read tools' argument schemas", () => {
  it("every example in a schema is arguments its tool takes", () => {
    let examples = 0;
    for (const tool of PersonalReadTool.options) {
      for (const example of schemaOf(tool).examples ?? []) {
        examples += 1;
        expect(PersonalToolArgs[tool].safeParse(example).success, `${tool} ${JSON.stringify(example)}`).toBe(true);
      }
    }
    expect(examples).toBeGreaterThanOrEqual(5);
  });

  it("every time bound says it takes an instant or a date alone, and both forms it shows are taken", () => {
    let bounds = 0;
    for (const tool of PersonalReadTool.options) {
      for (const [name, property] of Object.entries(schemaOf(tool).properties ?? {})) {
        // read_item's from is a position in a thread, a number.
        if ((name !== "from" && name !== "to") || property.type === "integer") continue;
        bounds += 1;
        const shown = [...(property.description ?? "").matchAll(/such as ([0-9TZ:-]+)/g)].map((match) => match[1]);
        expect(shown, `${tool}.${name}`).toHaveLength(2);
        for (const one of shown) expect(PersonalToolArgs.find_facts.safeParse({ [name]: one }).success, one).toBe(true);
      }
    }
    expect(bounds).toBe(10);
    expect(PersonalToolArgs.find_facts.safeParse({ from: "2026-09-31" }).success).toBe(false);
    expect(PersonalToolArgs.find_facts.safeParse({ from: "September 1" }).success).toBe(false);
  });

  it("a date alone stands for the whole UTC day while the owner has set no zone", () => {
    expect(instantOf("2026-09-01", "from")).toBe("2026-09-01T00:00:00.000Z");
    expect(instantOf("2026-09-01", "to")).toBe("2026-09-01T23:59:59.999Z");
    expect(instantOf("2026-09-01", "to", null)).toBe("2026-09-01T23:59:59.999Z");
    expect(instantOf("2026-09-01T10:00:00+02:00", "to")).toBe("2026-09-01T10:00:00+02:00");
    expect(instantOf(undefined, "from")).toBeUndefined();
  });

  it("a date alone stands for the owner's local day once they have set a zone, across a clock change", () => {
    expect(instantOf("2026-09-01", "from", "America/Chicago")).toBe("2026-09-01T05:00:00.000Z");
    expect(instantOf("2026-09-01", "to", "America/Chicago")).toBe("2026-09-02T04:59:59.999Z");
    // Chicago leaves daylight time on the first of November: that day is 25 hours long.
    expect(instantOf("2026-11-01", "from", "America/Chicago")).toBe("2026-11-01T05:00:00.000Z");
    expect(instantOf("2026-11-01", "to", "America/Chicago")).toBe("2026-11-02T05:59:59.999Z");
    expect(instantOf("2026-01-15", "from", "Asia/Kolkata")).toBe("2026-01-14T18:30:00.000Z");
    // An instant is never moved.
    expect(instantOf("2026-09-01T10:00:00Z", "from", "America/Chicago")).toBe("2026-09-01T10:00:00Z");
    expect(startOfDay("2026-03-08", "America/Chicago")).toBe(Date.parse("2026-03-08T06:00:00.000Z"));
    expect(dayIn(new Date("2026-09-02T03:00:00Z"), "America/Chicago")).toBe("2026-09-01");
    expect(dayIn(new Date("2026-09-02T03:00:00Z"), null)).toBe("2026-09-02");
    // The hour on the zone's clock, midnight as 0.
    expect(hourIn(new Date("2026-09-02T03:00:00Z"), "America/Chicago")).toBe(22);
    expect(hourIn(new Date("2026-09-02T05:00:00Z"), "America/Chicago")).toBe(0);
    expect(hourIn(new Date("2026-09-02T03:00:00Z"), null)).toBe(3);
  });

  it("a time zone is an IANA name the runtime knows, stored in its canonical form", () => {
    expect(canonicalTimeZone("America/Chicago")).toBe("America/Chicago");
    expect(canonicalTimeZone("america/chicago")).toBe("America/Chicago");
    expect(canonicalTimeZone("UTC")).toBe("UTC");
    for (const zone of ["", "Mars/Base", "Chicago time", "x".repeat(65)])
      expect(canonicalTimeZone(zone), zone).toBeNull();
  });

  it("build_context_pack's schema says which purpose takes which id", () => {
    const { properties = {} } = schemaOf("build_context_pack");
    expect(properties.event?.description).toMatch(/^meeting_prep's event id, required for it/);
    expect(properties.entity?.description).toMatch(/^person_brief's person id, required for it/);
    expect(properties.project?.description).toMatch(
      /^project_brief's project id, from list_projects or search, required for it/,
    );
  });
});
