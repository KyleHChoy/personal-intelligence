import type { ModelClient } from "@intelligence/personal-models";
import { FACT_KIND_VERSIONS } from "../lane-versions.ts";
import { type EvalNotice, evaluateTransactions } from "./eval-transactions.ts";

// `pi extract check --world --lane notices`: invented mail, on reserved domains, that asks of the real
// model what no fake can prove. A notice that puts something on the owner gives a plan at its date; an
// advertised opening, a newsletter's date and a sale give nothing. Each goes through personal_transaction's
// current fact-kind version and the lane's check. Nothing here is anyone's real data.
const at = (over: Pick<EvalNotice, "id" | "from" | "subject" | "paragraphs" | "expected">): EvalNotice => ({
  sentAt: "2026-10-19T14:00:00.000Z",
  labels: ["INBOX", "CATEGORY_UPDATES"],
  ...over,
});
export const EVAL_DUE_NOTICES: readonly EvalNotice[] = Object.freeze([
  at({
    id: "due-01",
    from: "notifications@studio.oak.example",
    subject: "Week 3 studio report is overdue",
    paragraphs: [
      "We have not received your Week 3 studio report, and its deadline has passed.",
      "Report deadline: Sunday, October 18, 2026",
      "Please submit it when you can.",
    ],
    expected: [{ type: "plan", when: "2026-10-18" }],
  }),
  at({
    id: "due-02",
    from: "billing@water.oak.example",
    subject: "Your water bill",
    paragraphs: ["Your water bill of the amount below is due on October 27, 2026.", "Pay it in the customer portal."],
    expected: [{ type: "plan", when: "2026-10-27" }],
  }),
  at({
    id: "due-03",
    from: "records@county.oak.example",
    subject: "Vehicle registration renewal",
    paragraphs: ["Your vehicle registration expires on November 2, 2026. Renew it before then to avoid a fine."],
    expected: [{ type: "plan", when: "2026-11-02" }],
  }),
  at({
    id: "due-04",
    from: "notifications@studio.oak.example",
    subject: "Week 3 studio report received",
    paragraphs: ["We have received your Week 3 studio report.", "Report deadline: Sunday, October 18, 2026"],
    expected: [{ type: "plan", when: "2026-10-18" }],
  }),
  at({
    id: "no-01",
    from: "team@elm-fellowship.example",
    subject: "Applications close Sunday",
    paragraphs: ["The Elm Fellowship is taking applications. Apply by October 25 to join the spring cohort."],
    expected: [],
  }),
  at({
    id: "no-02",
    from: "jobs@maple-careers.example",
    subject: "Maple is hiring a chief of staff",
    paragraphs: ["We are hiring. The application deadline is November 1, 2026. Share this with anyone it fits."],
    expected: [],
  }),
  at({
    id: "no-03",
    from: "editor@ash-weekly.example",
    subject: "This week in city news",
    paragraphs: ["The council's budget hearing is on October 28. The filing deadline for candidates passed last week."],
    expected: [],
  }),
  at({
    id: "no-04",
    from: "offers@birch-shop.example",
    subject: "Your last chance",
    paragraphs: ["Your 30% off ends October 22, 2026. Shop now. Unsubscribe at any time."],
    expected: [],
  }),
]);

// A notice may also give a status of where a process stands: that is no failure here.
export const evaluateDueNotices = (port: { model: ModelClient }) =>
  evaluateTransactions(port, EVAL_DUE_NOTICES, { version: FACT_KIND_VERSIONS.transaction, allowed: ["status"] });
