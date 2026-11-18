import { RetentionClass } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  CAPTURE_KINDS,
  CAPTURE_KINDS_SQL,
  CAPTURE_LANES,
  CAPTURE_RETENTION_CLASS,
  CAPTURE_SOURCE_KINDS,
  captureKindOf,
  EXTRACTION_LANES,
  isBuiltClass,
  LENS_CONNECTORS,
  SCOPED_KINDS,
} from "./lanes.ts";

// The lane table states what the lists it replaced stated, each read from it.
describe("the lane table", () => {
  it("gives each capture kind its source kind, connector and retention class", () => {
    expect(CAPTURE_KINDS).toEqual(["meeting", "moment", "block", "task"]);
    expect(CAPTURE_SOURCE_KINDS).toEqual(["transcript", "screen_activity", "time_block", "owner_task"]);
    expect(LENS_CONNECTORS).toEqual(["lens_meetings", "lens_activity", "lens_blocks", "lens_tasks"]);
    expect(SCOPED_KINDS).toEqual(["meeting", "moment", "block"]);
    expect(CAPTURE_KINDS_SQL).toBe("'meeting', 'moment', 'block', 'task'");
  });

  it("states a capture row's retention class as the case it replaced", () => {
    expect(CAPTURE_RETENTION_CLASS).toBe(
      "case c.kind when 'meeting' then 'capture_transcript' when 'moment' then 'capture_moment' when 'block' then 'capture_block' when 'task' then 'capture_task' end",
    );
  });

  it.each(
    RetentionClass.options.map((value) => [
      value,
      ["capture_transcript", "capture_moment", "capture_block"].includes(value),
    ]),
  )("%s is built: %s", (value, built) => {
    expect(isBuiltClass(value)).toBe(built);
  });

  it.each([
    ["capture_transcript", "meeting"],
    ["capture_moment", "moment"],
    ["capture_block", "block"],
  ] as const)("the class %s ages the kind %s", (value, kind) => {
    expect(captureKindOf(value)).toBe(kind);
    expect(CAPTURE_LANES[kind].retention).toBe(value);
  });

  it("names each extraction lane by its source kind", () => {
    expect(Object.entries(EXTRACTION_LANES).map(([lane, { kind }]) => [lane, kind])).toEqual([
      ["mail", "email"],
      ["agent", "agent_record"],
      ["document", "document"],
      ["meeting", "transcript"],
      ["moment", "screen_activity"],
    ]);
  });
});
