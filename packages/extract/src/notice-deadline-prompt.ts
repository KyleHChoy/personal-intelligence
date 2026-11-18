import { AT, person } from "./message-prompts.ts";

// personal_transaction version 4: version 3 with a deadline a notice puts on the owner as a plan, what a
// notice says was done as a plan that ends its sender's earlier line, and an opening anyone may take as
// nothing. Version 3 listed a deadline among a plan's dates and then said a reminder that only asks the
// owner to act gives no claim, and a notice of something due is one. Each replaced sentence is required,
// so a change to version 3 cannot leave this one reading otherwise unnoticed. Its examples are invented,
// on reserved domains.
const REPLACED: readonly (readonly [string, string])[] = [
  [
    "or that fixes an appointment on a date. The message is given below.",
    "or that fixes an appointment on a date, or a deadline of the owner's. The message is given below.",
  ],
  [
    "It gives a plan for each appointment, pickup, deadline, bill due or booking it fixes on a stated date.",
    "It gives a plan for each appointment, pickup or booking it fixes on a stated date, and for each deadline it puts on the owner: something of the owner's that is due from the owner, such as a bill, a form, a renewal, an assignment, a report or a log, whether its date is still ahead or has passed, and however many other notices have said the same.",
  ],
  [
    "A plan's what is the whole sentence or line that fixes the appointment, and when its date. A plan has no counterparty.",
    "A plan's what is the whole sentence or line that fixes the appointment, and when its date. A deadline's what is the whole sentence or line that says the thing is due, overdue or has a deadline, the one that names the thing where one does, and the subject line when only it does; when is the date it falls due, read from anywhere in the message, past or to come. A notice that says a thing is overdue and gives no date takes the message's date. A plan has no counterparty.\nA thing done. A notice that what was due has been received, submitted, filed or renewed, with no amount, gives one plan: what is the whole sentence or line that says so, and when the deadline it names, or else the message's date. A notice that a thing has not been received is a deadline, not this.",
  ],
  [
    "and a reminder that only asks the owner to act give no claim: claims is empty.",
    "and a reminder that names nothing due from the owner on a date give no claim: claims is empty. A date anyone could act on is no deadline of the owner's, even in a message addressed to the owner by name: a job or a program taking applications, an event's registration closing, an open call, an offer or a sale ending, or a date a newsletter reports. Those give no claim.",
  ],
];

const OVERDUE_LINES = [
  "We have not received your Week 3 studio report, and its deadline has passed.",
  "Report deadline: Sunday, March 1, 2026",
  "Please submit it when you can.",
].join("\n");
const OVERDUE_SPAN = `chars:0-${OVERDUE_LINES.length}`;
const SUBJECT = "Week 3 studio report is overdue";
const OVERDUE_MESSAGE = {
  citable: true,
  from: "notices@studio.alder.example",
  to: ["owner@birch.example"],
  date: AT,
  segments: [
    {
      span: `subject:chars:0-${SUBJECT.length}`,
      author: "notices@studio.alder.example",
      quoted: false,
      text: SUBJECT,
    },
    { span: OVERDUE_SPAN, author: "notices@studio.alder.example", quoted: false, text: OVERDUE_LINES },
  ],
};
const OVERDUE_OUTPUT = {
  claims: [
    {
      type: "plan",
      subject: person("owner@birch.example"),
      fields: {
        what: "We have not received your Week 3 studio report, and its deadline has passed.",
        when: "2026-03-01",
      },
      statementKind: "stated_fact",
      basis: "third_party",
      span: OVERDUE_SPAN,
    },
  ],
  narrowing: "none",
};
const OPENING_LINES = "Applications close Sunday. Apply by March 8 to join the Cedar Fellowship's spring cohort.";
const OPENING_MESSAGE = {
  citable: true,
  from: "news@cedar.example",
  to: ["owner@birch.example"],
  date: AT,
  segments: [
    {
      span: `chars:0-${OPENING_LINES.length}`,
      author: "news@cedar.example",
      quoted: false,
      text: OPENING_LINES,
    },
  ],
};

export function noticeDeadlineInstructions(version3: string): string {
  const text = REPLACED.reduce((sofar, [from, to]) => {
    if (sofar.split(from).length !== 2) throw new Error("transaction version 4: a sentence of version 3 is gone");
    return sofar.replace(from, to);
  }, version3);
  return [
    text,
    `Example message of a deadline that has passed: ${JSON.stringify(OVERDUE_MESSAGE)}`,
    `Example output for that deadline: ${JSON.stringify(OVERDUE_OUTPUT)}`,
    `Example message of an opening anyone may apply to: ${JSON.stringify(OPENING_MESSAGE)}`,
    `Example output for that opening: ${JSON.stringify({ claims: [], narrowing: "none" })}`,
  ].join("\n");
}
