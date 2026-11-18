import { expect, it } from "vitest";
import { callForm } from "./call-forms.ts";

it("lifts samePerson beside the other report fields without changing its answers", () => {
  const samePerson = [{ question: "idq_01J00000000000000000000001", verdict: "cant_tell", why: "no_evidence" }];
  expect(callForm("report_move", { deliverable: "Checked the names.", samePerson })).toEqual({
    report: { deliverable: "Checked the names.", samePerson },
  });
});

it("leaves conflicting nested and top-level samePerson answers for strict validation", () => {
  const args = { report: { samePerson: [{ answer: "same" }] }, samePerson: [{ answer: "different" }] };
  expect(callForm("report_move", args)).toEqual(args);
});
