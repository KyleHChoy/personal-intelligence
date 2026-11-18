// The evaluation documents: synthetic documents on reserved domains, each with its expected facts
// written by hand: commitments, plans, and some with none. Every expected fact's `what` is one
// paragraph of its document, word for word, so a model that finds it can cite it whole. Nothing
// here is anyone's real data.
//
// It lives in this package, not in the core's synthetic world: `pi extract check --world --lane
// document` runs on the host, and no runtime code imports a testing entry.

export type EvalFact = {
  type: "commitment" | "plan";
  // Addresses: the owner's is EVAL_OWNER.
  subject: string;
  counterparty: string;
  what: string;
  due?: string;
  when?: string;
};

export type EvalDocument = { id: string; fileId: string; title: string; paragraphs: string[]; expected: EvalFact[] };

export const EVAL_OWNER = "sam@harbor.example";
// Every evaluation document was last modified at this time, which dates its facts.
export const EVAL_MODIFIED = "2026-03-02T09:00:00.000Z";

const LENA = "lena.park@north.example";
const OMAR = "omar.reyes@field.example";
const THEO = "theo.marsh@lake.example";
const NINA = "nina.cole@ridge.example";
const FRANK = "frank.hart@cove.example";
const INES = "ines.ward@stone.example";

const commitment = (subject: string, counterparty: string, what: string, due?: string): EvalFact => ({
  type: "commitment",
  subject,
  counterparty,
  what,
  ...(due === undefined ? {} : { due }),
});
const plan = (subject: string, counterparty: string, what: string, when: string): EvalFact => ({
  type: "plan",
  subject,
  counterparty,
  what,
  when,
});

// A document whose paragraphs are its filler and then each expected fact's sentence.
let serial = 0;
function doc(title: string, filler: string[], expected: EvalFact[]): EvalDocument {
  serial += 1;
  const n = String(serial).padStart(2, "0");
  return {
    id: `eval-${n}`,
    fileId: `1EvalDocument${n}Abc`,
    title,
    paragraphs: [...filler, ...expected.map((fact) => fact.what)],
    expected,
  };
}

export const EVAL_DOCUMENTS: readonly EvalDocument[] = Object.freeze([
  // Commitments: fourteen in twelve documents.
  doc(
    "Venue shortlist",
    ["Three halls are still free in March."],
    [
      commitment(
        LENA,
        EVAL_OWNER,
        `Lena Park (${LENA}) will send the venue shortlist to ${EVAL_OWNER} by 2026-03-09.`,
        "2026-03-09",
      ),
    ],
  ),
  doc(
    "Grant application",
    ["The call closes at the end of the month."],
    [
      commitment(
        OMAR,
        EVAL_OWNER,
        `Omar Reyes (${OMAR}) will draft the budget section for ${EVAL_OWNER} by 2026-03-16.`,
        "2026-03-16",
      ),
    ],
  ),
  doc(
    "Kitchen renovation",
    ["The cabinets arrive in two weeks."],
    [
      commitment(
        EVAL_OWNER,
        THEO,
        `${EVAL_OWNER} will pay the deposit to Theo Marsh (${THEO}) by 2026-03-05.`,
        "2026-03-05",
      ),
    ],
  ),
  doc(
    "Book club",
    ["We are reading three novels this spring."],
    [
      commitment(
        NINA,
        EVAL_OWNER,
        `Nina Cole (${NINA}) will bring the reading list for ${EVAL_OWNER} to the next meeting.`,
      ),
    ],
  ),
  doc(
    "Moving checklist",
    ["Boxes are in the garage."],
    [
      commitment(
        FRANK,
        EVAL_OWNER,
        `Frank Hart (${FRANK}) will lend ${EVAL_OWNER} his van on 2026-03-21.`,
        "2026-03-21",
      ),
      commitment(
        EVAL_OWNER,
        INES,
        `${EVAL_OWNER} will return the keys to Ines Ward (${INES}) by 2026-03-23.`,
        "2026-03-23",
      ),
    ],
  ),
  doc(
    "Workshop prep",
    ["The workshop runs for two hours."],
    [
      commitment(
        INES,
        EVAL_OWNER,
        `Ines Ward (${INES}) will review the slides for ${EVAL_OWNER} by 2026-03-11.`,
        "2026-03-11",
      ),
    ],
  ),
  doc(
    "Tax paperwork",
    ["The forms came in the post."],
    [
      commitment(
        EVAL_OWNER,
        OMAR,
        `${EVAL_OWNER} will send the signed forms to Omar Reyes (${OMAR}) by 2026-04-01.`,
        "2026-04-01",
      ),
    ],
  ),
  doc(
    "Garden plans",
    ["The hedge has grown over the path."],
    [
      commitment(
        THEO,
        EVAL_OWNER,
        `Theo Marsh (${THEO}) will prune the hedge for ${EVAL_OWNER} by 2026-03-14.`,
        "2026-03-14",
      ),
    ],
  ),
  doc(
    "Conference talk",
    ["The talk is twenty minutes long."],
    [
      commitment(
        LENA,
        EVAL_OWNER,
        `Lena Park (${LENA}) will introduce ${EVAL_OWNER} to the program chair by 2026-03-20.`,
        "2026-03-20",
      ),
      commitment(
        EVAL_OWNER,
        LENA,
        `${EVAL_OWNER} will share the abstract with Lena Park (${LENA}) by 2026-03-13.`,
        "2026-03-13",
      ),
    ],
  ),
  doc(
    "Car repair",
    ["The brakes squeal on cold mornings."],
    [
      commitment(
        FRANK,
        EVAL_OWNER,
        `Frank Hart (${FRANK}) will call ${EVAL_OWNER} with the repair quote by 2026-03-06.`,
        "2026-03-06",
      ),
    ],
  ),
  doc(
    "Fundraiser",
    ["The school hall is booked for the evening."],
    [
      commitment(
        NINA,
        EVAL_OWNER,
        `Nina Cole (${NINA}) will collect the donations for ${EVAL_OWNER} by 2026-03-27.`,
        "2026-03-27",
      ),
    ],
  ),
  doc(
    "Thesis feedback",
    ["Chapter three is the longest."],
    [
      commitment(
        OMAR,
        EVAL_OWNER,
        `Omar Reyes (${OMAR}) will return the marked chapter to ${EVAL_OWNER} by 2026-03-18.`,
        "2026-03-18",
      ),
    ],
  ),

  // Plans: twelve in twelve documents.
  doc(
    "Site visit",
    ["The new office is on the third floor."],
    [
      plan(
        LENA,
        EVAL_OWNER,
        `Lena Park (${LENA}) proposed a site visit with ${EVAL_OWNER} on 2026-03-12.`,
        "2026-03-12",
      ),
    ],
  ),
  doc(
    "Dinner",
    ["The restaurant takes bookings by phone."],
    [plan(OMAR, EVAL_OWNER, `Omar Reyes (${OMAR}) confirmed dinner with ${EVAL_OWNER} on 2026-03-15.`, "2026-03-15")],
  ),
  doc(
    "Hiking",
    ["The ridge trail is twelve kilometres."],
    [plan(THEO, EVAL_OWNER, `Theo Marsh (${THEO}) proposed a hike with ${EVAL_OWNER} on 2026-03-22.`, "2026-03-22")],
  ),
  doc(
    "Weekly call",
    ["The agenda has four items."],
    [plan(INES, EVAL_OWNER, `Ines Ward (${INES}) confirmed a call with ${EVAL_OWNER} on 2026-03-10.`, "2026-03-10")],
  ),
  doc(
    "Rehearsal",
    ["The choir meets in the church hall."],
    [
      plan(
        NINA,
        EVAL_OWNER,
        `Nina Cole (${NINA}) proposed a rehearsal with ${EVAL_OWNER} on 2026-03-19.`,
        "2026-03-19",
      ),
    ],
  ),
  doc(
    "Boat trip",
    ["The harbour opens at seven."],
    [
      plan(
        FRANK,
        EVAL_OWNER,
        `Frank Hart (${FRANK}) confirmed the boat trip with ${EVAL_OWNER} on 2026-04-04.`,
        "2026-04-04",
      ),
    ],
  ),
  doc(
    "Planning session",
    ["The quarter's goals are not set yet."],
    [
      plan(
        EVAL_OWNER,
        LENA,
        `${EVAL_OWNER} proposed a planning session with Lena Park (${LENA}) on 2026-03-17.`,
        "2026-03-17",
      ),
    ],
  ),
  doc(
    "Study group",
    ["The exam covers six chapters."],
    [
      plan(
        OMAR,
        EVAL_OWNER,
        `Omar Reyes (${OMAR}) proposed a study session with ${EVAL_OWNER} on 2026-03-24.`,
        "2026-03-24",
      ),
    ],
  ),
  doc(
    "Market stall",
    ["The stall sells jam and bread."],
    [
      plan(
        THEO,
        EVAL_OWNER,
        `Theo Marsh (${THEO}) confirmed the market stall with ${EVAL_OWNER} on 2026-03-28.`,
        "2026-03-28",
      ),
    ],
  ),
  doc(
    "Museum",
    ["The new wing opened last year."],
    [
      plan(
        INES,
        EVAL_OWNER,
        `Ines Ward (${INES}) proposed a museum visit with ${EVAL_OWNER} on 2026-04-11.`,
        "2026-04-11",
      ),
    ],
  ),
  doc(
    "Tennis",
    ["The courts are by the river."],
    [
      plan(
        EVAL_OWNER,
        FRANK,
        `${EVAL_OWNER} confirmed a tennis match with Frank Hart (${FRANK}) on 2026-03-08.`,
        "2026-03-08",
      ),
    ],
  ),
  doc(
    "Concert",
    ["The programme has three pieces."],
    [
      plan(
        NINA,
        EVAL_OWNER,
        `Nina Cole (${NINA}) confirmed the choir concert with ${EVAL_OWNER} on 2026-03-29.`,
        "2026-03-29",
      ),
    ],
  ),

  // No fact: eleven documents, two of them naming people in past events.
  doc("Packing list", ["Tent, stove and two sleeping bags.", "Spare batteries for the lamp."], []),
  doc("Lentil soup", ["Simmer the lentils for twenty minutes.", "Add cumin and lemon at the end."], []),
  doc("Reading notes", ["The author argues that cities grew around rivers.", "Chapter four covers trade routes."], []),
  doc("Home network", ["The router sits in the hall cupboard.", "The printer is on the second floor."], []),
  doc("Garden log", ["The tulips came up on the south side.", "Rain fell most of last week."], []),
  doc("Quotes", ["Simplicity is the ultimate sophistication.", "Well begun is half done."], []),
  doc("February spending", ["Groceries came to 320 in February.", "Transport came to 85."], []),
  doc("Coast walk", ["We walked the coast path last summer.", "The ferry was late both ways."], []),
  doc(
    "Survey review",
    [`Lena Park (${LENA}) presented the survey results last week.`, "The response rate was higher than last year."],
    [],
  ),
  doc("Tide", ["The tide goes out and leaves the stones.", "Gulls wait on the harbour wall."], []),
  doc("Invoices", [`Frank Hart (${FRANK}) sent the invoice last week.`, "It was paid on time."], []),
]);
