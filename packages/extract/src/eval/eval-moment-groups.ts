// The moment evaluation set, written by hand: each group of moments with the facts it is expected
// to give and whom code must credit for each, across mail, chats, agent apps, long threads and
// iMessage. Kept whole in one array, because the builders number groups in the order they are called.
import {
  AGENT,
  ARLO,
  affiliation,
  avoids,
  CHAT_FILLER,
  capability,
  chat,
  commitment,
  constraint,
  dayAfter,
  type EvalMomentGroup,
  FRANK,
  FRIDAY,
  goal,
  group,
  INES,
  imessage,
  imessageDays,
  LENA,
  MOMENT_DECK_LINE,
  mail,
  NINA,
  need,
  EVAL_MOMENT_OWNER as O,
  OMAR,
  own,
  plan,
  prefers,
  ROBIN,
  relationship,
  role,
  SIGN_OFF,
  said,
  situation,
  TESS,
  THEO,
  thread,
} from "./eval-moment-builders.ts";

export const EVAL_MOMENT_GROUPS: readonly EvalMomentGroup[] = Object.freeze([
  // Commitments: eleven in nine groups, and two plans. Every "I will" line promises something and
  // is expected. A commitment whose line names the one day it is due by or on carries that day as
  // `due`, read from START, a Monday, as the moment prompt's own example reads "by Friday"; `due`
  // is part of the fact key and the text is not, so an undated answer to a dated line is a miss and
  // an extra. A line that names no single day ("this week", "before Friday", "the next meeting",
  // "the spring term") has none.
  group(
    "Investor deck",
    [mail(ROBIN, O, ["Hi Sam, the numbers are done and the story is mostly there.", MOMENT_DECK_LINE, SIGN_OFF])],
    [commitment(ROBIN, O, MOMENT_DECK_LINE, FRIDAY)],
  ),
  group(
    "Offsite venues",
    [
      mail(LENA, O, [
        "Hi Sam, three halls are still free in the second half of March.",
        "I will send you the venue shortlist tomorrow morning.",
        SIGN_OFF,
      ]),
    ],
    [commitment(LENA, O, "I will send you the venue shortlist tomorrow morning.", dayAfter(1))],
  ),
  group(
    "Grant application",
    [
      mail(OMAR, O, [
        "Sam, the grant call closes at the end of the month.",
        "I will draft the budget section for you this week.",
        SIGN_OFF,
      ]),
      mail(O, OMAR, [
        "Thanks Omar, that split works for me.",
        "I will write the project summary and share it with you before Friday.",
        SIGN_OFF,
      ]),
    ],
    [
      commitment(OMAR, O, "I will draft the budget section for you this week."),
      commitment(O, OMAR, "I will write the project summary and share it with you before Friday."),
    ],
  ),
  group(
    "Kitchen deposit",
    [
      mail(THEO, O, [
        "Sam, the cabinets are ordered and the fitter is booked.",
        "I will confirm the delivery date once it comes through.",
        SIGN_OFF,
      ]),
    ],
    [commitment(THEO, O, "I will confirm the delivery date once it comes through.")],
  ),
  group(
    "Reading group",
    [
      mail(NINA, O, [
        "Hi Sam, everyone liked the last book a lot.",
        "I will bring the reading list to the next meeting.",
        SIGN_OFF,
      ]),
    ],
    [commitment(NINA, O, "I will bring the reading list to the next meeting.")],
  ),
  group(
    "Workshop slides",
    [
      mail(INES, O, [
        "Sam, I had a first look at the deck on the train.",
        "I will review the slides and leave comments on each example.",
        SIGN_OFF,
      ]),
    ],
    [commitment(INES, O, "I will review the slides and leave comments on each example.")],
  ),
  group(
    "Garden",
    [
      mail(THEO, O, [
        "Sam, the weather looks dry later in the week.",
        "I will prune the hedge on Thursday afternoon.",
        SIGN_OFF,
      ]),
    ],
    [commitment(THEO, O, "I will prune the hedge on Thursday afternoon.", dayAfter(3))],
  ),
  group(
    "Moving day",
    [
      mail(FRANK, O, [
        "Sam, good luck with the flat, it sounds lovely.",
        "I will lend you my van for the day of the move.",
        SIGN_OFF,
      ]),
      mail(O, FRANK, [
        "Frank, that is very kind of you, thank you.",
        "I will fill the tank before I bring the van back to you.",
        SIGN_OFF,
      ]),
    ],
    [
      commitment(FRANK, O, "I will lend you my van for the day of the move."),
      commitment(O, FRANK, "I will fill the tank before I bring the van back to you."),
    ],
  ),
  group(
    "Choir",
    [
      mail(LENA, O, [
        "Hi Sam, the concert went well and the hall wants us back.",
        "I will book the rehearsal room for the spring term.",
        SIGN_OFF,
      ]),
    ],
    [commitment(LENA, O, "I will book the rehearsal room for the spring term.")],
  ),
  group(
    "Running club",
    [
      mail(NINA, O, [
        "Sam, a few of us want to start running again before the races.",
        "Let's meet at the park gate on March 12, 2026 for the first run.",
        SIGN_OFF,
      ]),
    ],
    [plan(NINA, O, "Let's meet at the park gate on March 12, 2026 for the first run.", "2026-03-12")],
  ),
  group(
    "Brochure proofs",
    [
      mail(OMAR, O, [
        "Sam, the printers sent the proofs over this morning.",
        "Let's have lunch at the harbour cafe on March 18, 2026 and go through them.",
        SIGN_OFF,
      ]),
    ],
    [plan(OMAR, O, "Let's have lunch at the harbour cafe on March 18, 2026 and go through them.", "2026-03-18")],
  ),
  // Eleven groups with nothing to find.
  group(
    "Soup",
    [
      mail(INES, O, [
        "Sam, the soup you described sounded wonderful.",
        "Mostly leeks and potatoes, with a lot of black pepper and a little cream, you said.",
        SIGN_OFF,
      ]),
    ],
    [],
  ),
  group(
    "Some time",
    [
      mail(ROBIN, O, [
        "We should get the families together at some point, it has been far too long.",
        "Maybe once the school term settles down a bit.",
        SIGN_OFF,
      ]),
    ],
    [],
  ),
  group(
    "Trains",
    [
      mail(LENA, O, [
        "Sorry about this morning, the trains were all delayed again.",
        "They keep saying the works will finish soon, but nobody believes them.",
        SIGN_OFF,
      ]),
    ],
    [],
  ),
  group(
    "Last year",
    [
      mail(OMAR, O, [
        "Last year the brochure went to the printers far too late, do you remember?",
        "The boxes arrived the morning of the fair and we were still unpacking them.",
        SIGN_OFF,
      ]),
    ],
    [],
  ),
  group(
    "Ideas",
    [
      mail(INES, O, [
        "One idea for the newsletter would be a short interview with a new member each month.",
        "Another would be a photo of the month from one of the members.",
        SIGN_OFF,
      ]),
    ],
    [],
  ),
  group(
    "Weather",
    [
      mail(THEO, O, [
        "The storm last night took two panels off the fence at the back.",
        "The neighbours lost a tree as well, though it missed the shed.",
        SIGN_OFF,
      ]),
    ],
    [],
  ),
  group(
    "Holiday photos",
    [
      mail(FRANK, O, [
        "The photos from the coast came out better than I hoped.",
        "The light in the evenings was amazing, even when it rained.",
        SIGN_OFF,
      ]),
    ],
    [],
  ),
  group(
    "Book review",
    [
      mail(NINA, O, [
        "I finished the novel you lent me over the weekend.",
        "The ending surprised me, though the middle was slow in places.",
        SIGN_OFF,
      ]),
    ],
    [],
  ),
  group(
    "Already done",
    [
      mail(ROBIN, O, [
        "The invoices from last quarter were all paid on time in the end.",
        "The accountant was happy with how the files were kept.",
        SIGN_OFF,
      ]),
    ],
    [],
  ),
  group(
    "Open question",
    [
      mail(LENA, O, [
        "Would anyone be up for a picnic if the weather holds?",
        "It is only an idea for now and nothing is booked.",
        SIGN_OFF,
      ]),
    ],
    [],
  ),
  // One more, so the extras allowance of the larger set still has a mail group with
  // nothing to find beyond it.
  group(
    "Parcel",
    [
      mail(OMAR, O, [
        "The parcel came this morning, a little dented but fine inside.",
        "The courier left it with the neighbours, as usual.",
        SIGN_OFF,
      ]),
    ],
    [],
  ),
  // One-to-one chats, the owner's lines and the contact's marked.
  chat(
    "Lena Park",
    [LENA],
    [
      [LENA, "Are you still up for the hike this weekend?"],
      [O, "Yes, I will bring the trail map on Saturday."],
      [LENA, "Great, I will pick you up at eight on Saturday."],
      [O, "Perfect, see you then."],
      [LENA, CHAT_FILLER],
    ],
    [
      said(O, commitment(O, LENA, "Yes, I will bring the trail map on Saturday.", dayAfter(5))),
      said(LENA, commitment(LENA, O, "Great, I will pick you up at eight on Saturday.", dayAfter(5))),
    ],
  ),
  chat(
    "Omar Reyes",
    [OMAR],
    [
      [OMAR, "The landlord finally replied this morning."],
      [OMAR, "I will send you the signed lease tomorrow."],
      [O, "Thanks, I will transfer the deposit once it arrives."],
      [OMAR, CHAT_FILLER],
    ],
    [
      said(OMAR, commitment(OMAR, O, "I will send you the signed lease tomorrow.", dayAfter(1))),
      said(O, commitment(O, OMAR, "Thanks, I will transfer the deposit once it arrives.")),
    ],
  ),
  chat(
    "Theo Marsh",
    [THEO],
    [
      [THEO, "Let's have lunch at the station cafe on March 9, 2026."],
      [O, "Sounds good to me."],
      [THEO, "The weather has been so grey all week."],
      [THEO, CHAT_FILLER],
    ],
    [said(THEO, plan(THEO, O, "Let's have lunch at the station cafe on March 9, 2026.", "2026-03-09"))],
  ),
  chat(
    "Frank Hart",
    [FRANK],
    [
      [O, "I will return your drill this weekend."],
      [FRANK, "No rush at all, keep it as long as you need for the shelves."],
      [FRANK, CHAT_FILLER],
    ],
    [said(O, commitment(O, FRANK, "I will return your drill this weekend."))],
  ),
  chat(
    "Nina Cole",
    [NINA],
    [
      [NINA, "It was lovely to see you at the market on Saturday."],
      [O, "You too, the kids loved the stall."],
      [NINA, "We should do it again some time."],
      [NINA, CHAT_FILLER],
    ],
    [],
  ),
  chat(
    "Ines Ward",
    [INES],
    [
      [INES, "I will save you a seat at the recital on Thursday."],
      [O, "Thank you, I will bring flowers for the performers."],
      [INES, CHAT_FILLER],
    ],
    [
      said(INES, commitment(INES, O, "I will save you a seat at the recital on Thursday.", dayAfter(3))),
      said(O, commitment(O, INES, "Thank you, I will bring flowers for the performers.")),
    ],
  ),
  // Group chats, three participants: a promise between two of them among them.
  chat(
    "Dinner club",
    [LENA, OMAR, INES],
    [
      [LENA, "Omar, I will book the table at the harbour cafe for Friday."],
      [OMAR, "Ines, I will send you the photos tomorrow."],
      [O, "Lena, I will bring the dessert on Friday."],
      [INES, CHAT_FILLER],
    ],
    [
      said(LENA, commitment(LENA, OMAR, "Omar, I will book the table at the harbour cafe for Friday.", FRIDAY)),
      said(OMAR, commitment(OMAR, INES, "Ines, I will send you the photos tomorrow.", dayAfter(1))),
      said(O, commitment(O, LENA, "Lena, I will bring the dessert on Friday.", FRIDAY)),
    ],
  ),
  chat(
    "Book club",
    [INES, OMAR, LENA],
    [
      [INES, "Sam, I will forward you the reading list tomorrow."],
      [OMAR, "Has anyone finished the last chapter yet?"],
      [O, "Not yet, the middle part is slow."],
      [LENA, CHAT_FILLER],
    ],
    [said(INES, commitment(INES, O, "Sam, I will forward you the reading list tomorrow.", dayAfter(1)))],
  ),
  chat(
    "Concert",
    [LENA, THEO, NINA],
    [
      [NINA, "Theo, I will lend you my keyboard for the concert."],
      [THEO, "That would be a huge help, thank you."],
      [LENA, CHAT_FILLER],
    ],
    [said(NINA, commitment(NINA, THEO, "Theo, I will lend you my keyboard for the concert."))],
  ),
  // Agent-app conversations: the owner's prompts and the agent's replies. The agent's line about
  // the owner may be found, as agent output, and must never be the owner's word.
  chat(
    "Week plan",
    [],
    [
      [O, `Remind me that I will send ${NINA} the draft agreement on Thursday.`],
      [AGENT, "Noted, here is a short checklist for the agreement so that it is ready in time for the meeting."],
      [AGENT, "First the parties, then the dates, then the signatures, and a copy for each side."],
    ],
    [said(O, commitment(O, NINA, `Remind me that I will send ${NINA} the draft agreement on Thursday.`, dayAfter(3)))],
    { agentApp: true },
  ),
  chat(
    "Status",
    [],
    [
      [O, "What do I have going on this week? Keep it short please."],
      [AGENT, `You said you will send ${OMAR} the budget on Thursday.`],
      [AGENT, "Apart from that the week looks quiet, with nothing else in the calendar before the weekend arrives."],
    ],
    [],
    { agentApp: true },
  ),
  chat(
    "Invite",
    [],
    [
      [O, `Let's have dinner with ${FRANK} at the harbour cafe on March 20, 2026.`],
      [O, "Please draft the invite for me."],
      [
        AGENT,
        "Here is a draft you can send: dinner at the harbour cafe on the twentieth, with a table booked for seven.",
      ],
    ],
    [said(O, plan(O, FRANK, `Let's have dinner with ${FRANK} at the harbour cafe on March 20, 2026.`, "2026-03-20"))],
    { agentApp: true },
  ),
  // Chats with no turns, the current case: nobody is credited.
  chat(
    "Movers",
    [OMAR],
    [
      [OMAR, "Omar Reyes: I will text you the movers' number tomorrow."],
      [O, "Sam Harbor: Thanks, that would help a lot."],
      [OMAR, `Omar Reyes: ${CHAT_FILLER}`],
    ],
    [
      {
        ...commitment(OMAR, O, "Omar Reyes: I will text you the movers' number tomorrow.", dayAfter(1)),
        alt: ["I will text you the movers' number tomorrow."],
      },
    ],
    { turns: false },
  ),
  chat(
    "Garden",
    [THEO],
    [
      [THEO, "Theo Marsh: The tomatoes are finally ripening after all that rain."],
      [O, "Sam Harbor: Lovely, the basil is doing well too."],
      [THEO, `Theo Marsh: ${CHAT_FILLER}`],
    ],
    [],
    { turns: false },
  ),
  // The person-fact types, at least ten expected facts of each, in one-to-one and
  // group chats with turns, agent-app conversations and chats without turns. Each fact is said in
  // its subject's own line, so code credits the subject; without turns, nobody.
  chat(
    "Lena, running",
    [LENA],
    [
      [LENA, "I am a product manager at North Labs now."],
      [LENA, "I want to run a marathon next year."],
      [O, "I prefer morning runs."],
      [LENA, "I cannot run on weekdays."],
      [LENA, "I need new running shoes."],
      [LENA, CHAT_FILLER],
    ],
    [
      own(role(LENA, "product manager", "North Labs")),
      own(goal(LENA, "health", "run a marathon", { domains: ["interests"] })),
      own(prefers(O, "health", "morning runs", { domains: ["interests"] })),
      own(constraint(LENA, "health", "cannot run on weekdays", { domains: ["interests"] })),
      own(need(LENA, "interests", "new running shoes", { domains: ["health"] })),
    ],
  ),
  chat(
    "Omar, moving",
    [OMAR],
    [
      [OMAR, "Sam, you have been my mentor for years."],
      [OMAR, "I need a new flat near the station."],
      [OMAR, "I am moving to Lisbon in May."],
      [OMAR, "I cannot sign anything before June."],
      [O, "I speak Portuguese."],
      [OMAR, CHAT_FILLER],
    ],
    [
      own(relationship(OMAR, O, "mentor", "Sam, you have been my mentor for years.")),
      own(need(OMAR, "home", "a new flat near the station", { also: ["a new flat"] })),
      own(situation(OMAR, "home", "moving to Lisbon")),
      own(constraint(OMAR, "home", "cannot sign anything before June", { domains: ["admin"] })),
      own(capability(O, "education", "speak Portuguese", { domains: ["interests", "travel"] })),
    ],
  ),
  chat(
    "Theo, shelves",
    [THEO],
    [
      [THEO, "I am on the board of Lake Trust."],
      [THEO, "I know how to restore old furniture."],
      [THEO, "I avoid driving at night."],
      [O, "I need a carpenter for the kitchen shelves."],
      [THEO, CHAT_FILLER],
    ],
    [
      own(affiliation(THEO, "board", "Lake Trust")),
      own(capability(THEO, "interests", "restore old furniture")),
      own(avoids(THEO, "travel", "driving at night")),
      own(need(O, "home", "a carpenter for the kitchen shelves", { also: ["a carpenter"] })),
    ],
  ),
  chat(
    "Nina, internship",
    [NINA],
    [
      [NINA, "I study at Harlow Vale College."],
      [NINA, "I want to become a data scientist."],
      [NINA, "I need an internship for the summer."],
      [NINA, "I am good at statistics."],
      [O, "I am the head of analytics at Harbor Bank."],
      [NINA, CHAT_FILLER],
    ],
    [
      own(affiliation(NINA, "student", "Harlow Vale College")),
      own(goal(NINA, "career", "become a data scientist", { domains: ["education"] })),
      own(need(NINA, "career", "an internship for the summer", { also: ["an internship"], domains: ["education"] })),
      own(capability(NINA, "education", "statistics", { also: ["good at statistics"], domains: ["career"] })),
      own(role(O, "head of analytics", "Harbor Bank")),
    ],
  ),
  chat(
    "Frank, studio",
    [FRANK],
    [
      [FRANK, "I am a wedding photographer."],
      [FRANK, "I am on parental leave until April."],
      [FRANK, "I cannot travel before the end of March."],
      [FRANK, "I need a second camera for the season."],
      [FRANK, "I want to open a studio of my own."],
      [O, "I prefer small weddings."],
      [FRANK, CHAT_FILLER],
    ],
    [
      own(role(FRANK, "wedding photographer")),
      own(situation(FRANK, "family", "on parental leave", { domains: ["career"] })),
      own(constraint(FRANK, "travel", "cannot travel before the end of March")),
      own(need(FRANK, "career", "a second camera", { also: ["a second camera for the season"] })),
      own(goal(FRANK, "ventures", "open a studio", { domains: ["career"] })),
      own(prefers(O, "relationships", "small weddings", { domains: ["family"] })),
    ],
  ),
  chat(
    "Ines, lessons",
    [INES],
    [
      [INES, "Sam, you are my oldest friend."],
      [INES, "I am a Portuguese teacher at Stone Academy."],
      [INES, "I speak four languages."],
      [O, "I want to learn Portuguese properly this year."],
      [O, "I cannot take lessons on Mondays."],
      [INES, CHAT_FILLER],
    ],
    [
      own(relationship(INES, O, "friend", "Sam, you are my oldest friend.")),
      own(role(INES, "Portuguese teacher", "Stone Academy")),
      own(capability(INES, "education", "speak four languages")),
      own(goal(O, "education", "learn Portuguese", { also: ["learn Portuguese properly"] })),
      own(constraint(O, "education", "cannot take lessons on Mondays")),
    ],
  ),
  chat(
    "Robin, agency",
    [ROBIN],
    [
      [ROBIN, "I do contract work for Vale Energy."],
      [ROBIN, "I am between jobs at the moment."],
      [ROBIN, "I want to start a design agency."],
      [ROBIN, "I need a business partner who handles sales."],
      [ROBIN, "I avoid working on weekends."],
      [ROBIN, CHAT_FILLER],
    ],
    [
      own(affiliation(ROBIN, "contractor", "Vale Energy")),
      own(situation(ROBIN, "career", "between jobs")),
      own(goal(ROBIN, "ventures", "start a design agency", { domains: ["career"] })),
      own(
        need(ROBIN, "ventures", "a business partner who handles sales", {
          also: ["a business partner"],
          domains: ["career"],
        }),
      ),
      own(avoids(ROBIN, "career", "working on weekends")),
    ],
  ),
  chat(
    "Climbing club",
    [LENA, OMAR, THEO],
    [
      [LENA, "Omar is my brother, by the way."],
      [OMAR, "I am the treasurer of the Field Climbing Club."],
      [OMAR, "I cannot climb on Thursdays."],
      [THEO, "I prefer indoor walls in winter."],
      [THEO, "I want to climb in the Alps next summer."],
      [LENA, "I am moving to Oslo in the spring."],
      [O, "I need climbing shoes."],
      [LENA, CHAT_FILLER],
    ],
    [
      own(relationship(LENA, OMAR, "sibling", "Omar is my brother, by the way.")),
      own(role(OMAR, "treasurer", "Field Climbing Club")),
      own(constraint(OMAR, "interests", "cannot climb on Thursdays")),
      own(prefers(THEO, "interests", "indoor walls", { also: ["indoor walls in winter"] })),
      own(goal(THEO, "interests", "climb in the Alps", { domains: ["travel"] })),
      own(situation(LENA, "home", "moving to Oslo")),
      own(need(O, "interests", "climbing shoes")),
    ],
  ),
  chat(
    "Supper club",
    [NINA, FRANK, INES],
    [
      [NINA, "Frank is my cousin."],
      [NINA, "I want to write a cookbook."],
      [FRANK, "I know how to cook for large groups."],
      [INES, "I avoid spicy food."],
      [INES, "I am on a sabbatical this term."],
      [O, "I prefer cooking on Sundays."],
      [NINA, CHAT_FILLER],
    ],
    [
      own(relationship(NINA, FRANK, "family", "Frank is my cousin.")),
      own(goal(NINA, "interests", "write a cookbook", { domains: ["ventures"] })),
      own(capability(FRANK, "interests", "cook for large groups")),
      own(avoids(INES, "interests", "spicy food", { domains: ["health"] })),
      own(situation(INES, "career", "on a sabbatical", { domains: ["education"] })),
      own(prefers(O, "interests", "cooking on Sundays", { domains: ["home"] })),
    ],
  ),
  chat(
    "Old team",
    [ROBIN, LENA],
    [
      [ROBIN, "Lena was my manager for years."],
      [ROBIN, "I cannot work more than three days a week."],
      [LENA, "I am a member of the North Rowing Club."],
      [LENA, "I can code in Python."],
      [O, "I am studying for an MBA at Harbor University."],
      [ROBIN, CHAT_FILLER],
    ],
    [
      own(relationship(ROBIN, LENA, "manager", "Lena was my manager for years.")),
      own(constraint(ROBIN, "career", "cannot work more than three days a week")),
      own(affiliation(LENA, "member", "North Rowing Club")),
      own(capability(LENA, "career", "code in Python")),
      own(situation(O, "education", "studying for an MBA", { domains: ["career"] })),
      own(affiliation(O, "student", "Harbor University")),
    ],
  ),
  chat(
    "Omar and Ines",
    [OMAR, INES],
    [
      [OMAR, "Ines is my wife."],
      [OMAR, "I am a pilot at Field Air."],
      [OMAR, "I can repair bicycles."],
      [INES, "Sam, you were my classmate, remember?"],
      [INES, "I volunteer at the Stone Food Bank."],
      [INES, "I prefer phone calls to messages."],
      [OMAR, CHAT_FILLER],
    ],
    [
      own(relationship(OMAR, INES, "spouse", "Ines is my wife.")),
      own(role(OMAR, "pilot", "Field Air")),
      own(capability(OMAR, "interests", "repair bicycles")),
      own(relationship(INES, O, "classmate", "Sam, you were my classmate, remember?")),
      own(affiliation(INES, "volunteer", "Stone Food Bank")),
      own(prefers(INES, "relationships", "phone calls", { also: ["phone calls to messages"], domains: ["admin"] })),
    ],
  ),
  chat(
    "Theo, neighbors",
    [THEO],
    [
      [THEO, "Sam, you are my neighbor, so I wanted to ask first."],
      [THEO, "I am a lawyer at Lake Legal."],
      [THEO, "I am also an investor in Lake Bakery."],
      [THEO, "I need a bigger workshop."],
      [THEO, "I cannot work on Saturdays."],
      [O, "I want to buy a house within two years."],
      [O, "I am house-sitting for my parents this month."],
      [THEO, CHAT_FILLER],
    ],
    [
      own(relationship(THEO, O, "neighbor", "Sam, you are my neighbor, so I wanted to ask first.")),
      own(role(THEO, "lawyer", "Lake Legal")),
      own(affiliation(THEO, "investor", "Lake Bakery")),
      own(need(THEO, "ventures", "a bigger workshop", { domains: ["career", "home"] })),
      own(constraint(THEO, "career", "cannot work on Saturdays")),
      own(goal(O, "home", "buy a house", { domains: ["money"] })),
      own(situation(O, "family", "house-sitting for my parents", { domains: ["home"] })),
    ],
  ),
  chat(
    "Frank and Nina",
    [FRANK, NINA],
    [
      [FRANK, "Nina was my client for years."],
      [FRANK, "I studied at Cove University."],
      [FRANK, "I know how to edit video."],
      [FRANK, "I am renovating the old mill house."],
      [NINA, "I am a nurse at the Ridge Clinic."],
      [NINA, "I avoid night shifts."],
      [FRANK, CHAT_FILLER],
    ],
    [
      own(relationship(FRANK, NINA, "client", "Nina was my client for years.")),
      own(affiliation(FRANK, "alumnus", "Cove University")),
      own(capability(FRANK, "career", "edit video")),
      own(situation(FRANK, "home", "renovating the old mill house", { also: ["renovating the mill house"] })),
      own(role(NINA, "nurse", "Ridge Clinic")),
      own(avoids(NINA, "career", "night shifts")),
    ],
  ),
  chat(
    "Robin, design",
    [ROBIN],
    [
      [ROBIN, "Sam, you were my manager for three years."],
      [ROBIN, "I am a product designer at Alder Studio now."],
      [ROBIN, "I am an advisor to Alder Ventures."],
      [ROBIN, "I cannot travel abroad this year."],
      [O, "I want to save for a sabbatical."],
      [ROBIN, CHAT_FILLER],
    ],
    [
      own(relationship(ROBIN, O, "manager", "Sam, you were my manager for three years.")),
      own(role(ROBIN, "product designer", "Alder Studio")),
      own(affiliation(ROBIN, "advisor", "Alder Ventures")),
      own(constraint(ROBIN, "travel", "cannot travel abroad")),
      own(goal(O, "money", "save for a sabbatical", { domains: ["career"] })),
    ],
  ),
  // Agent apps: the owner's prompt lines are the owner's word; the agent's replies are agent output.
  chat(
    "Career notes",
    [],
    [
      [O, "I want to move into product management this year."],
      [AGENT, "Here are three steps you could take toward a product role, starting with a short course."],
      [O, "I prefer remote work."],
      [O, "I know how to negotiate contracts."],
      [O, "I am on the board of Harbor Trust."],
      [O, "I cannot spend more than two thousand on the course."],
      [AGENT, "Noted, here are remote roles and courses that fit the budget."],
    ],
    [
      own(goal(O, "career", "move into product management")),
      own(prefers(O, "career", "remote work")),
      own(capability(O, "career", "negotiate contracts")),
      own(affiliation(O, "board", "Harbor Trust")),
      own(
        constraint(O, "money", "cannot spend more than two thousand on the course", {
          also: ["cannot spend more than two thousand"],
          domains: ["education"],
        }),
      ),
    ],
    { agentApp: true },
  ),
  chat(
    "Trip planning",
    [],
    [
      [O, "I cannot fly before April 10, 2026."],
      [O, "I need a hotel near the old town."],
      [O, "I am in Porto for the week."],
      [
        AGENT,
        "Since you avoid long flights, I looked at trains first and found two that arrive before noon, with seats still free in the quiet coach.",
      ],
    ],
    [
      own(constraint(O, "travel", "cannot fly before April 10, 2026", { also: ["cannot fly"] })),
      own(need(O, "travel", "a hotel near the old town", { also: ["a hotel"] })),
      own(situation(O, "travel", "in Porto")),
    ],
    { agentApp: true },
  ),
  // Chats without turns: the facts are stored, credited to nobody.
  chat(
    "Theo, joinery",
    [THEO],
    [
      [THEO, "Theo Marsh: I am a carpenter at Lake Joinery."],
      [O, "Sam Harbor: Good to know, thanks for telling me."],
      [THEO, "Theo Marsh: No problem at all."],
      [THEO, `Theo Marsh: ${CHAT_FILLER}`],
    ],
    [role(THEO, "carpenter", "Lake Joinery")],
    { turns: false },
  ),
  chat(
    "Nina, sailing",
    [NINA],
    [
      [NINA, "Nina Cole: I am moving to the coast next month."],
      [NINA, "Nina Cole: I know how to sail."],
      [NINA, "Nina Cole: I need a mooring for my boat."],
      [NINA, `Nina Cole: ${CHAT_FILLER}`],
    ],
    [
      situation(NINA, "home", "moving to the coast"),
      capability(NINA, "interests", "sail"),
      need(NINA, "interests", "a mooring"),
    ],
    { turns: false },
  ),
  chat(
    "Robin, deck",
    [ROBIN],
    [
      [ROBIN, "Hi Sam, the numbers are done and the story is mostly there."],
      [ROBIN, MOMENT_DECK_LINE],
      [O, "Great, thanks."],
      [ROBIN, CHAT_FILLER],
    ],
    [said(ROBIN, commitment(ROBIN, O, MOMENT_DECK_LINE, FRIDAY))],
  ),
  // The owner and one contact known by a name alone, about 13 000 characters over four moments, a
  // dense talk of goals, plans, funds and ideas, the contact's facts and the owner's.
  thread(
    "Tess Quill",
    [TESS],
    [
      [TESS, "My goal this year is to raise a small seed fund for Midwest founders."],
      [O, "I want to launch a credit startup after graduation."],
      [TESS, "I spent six years underwriting small business loans, so I can read a credit file fast."],
      [O, "I can build underwriting models in Python."],
      [TESS, "I am a principal at Kestrel Capital now."],
      [O, "I need a first design partner, ideally a lender."],
      [TESS, "What I need most is a technical cofounder for the data side."],
      [O, "I cannot work more than ten hours a week."],
      [TESS, "I prefer small teams over big committees."],
      [O, "I am finishing my degree this year."],
      [TESS, "I avoid crypto deals entirely."],
      [O, "I prefer bootstrapping to raising early."],
      [TESS, "I cannot take money from family offices."],
      [O, "I avoid consulting work, it eats every week."],
      [TESS, "I am between apartments right now."],
      [O, "I am the operations lead at Brightline."],
      [TESS, "I am a member of the Prairie Angels network."],
      [O, "I will draft the pitch outline by Friday."],
      [TESS, "I will send you the fund memo on Thursday."],
      [TESS, "Let's meet at the library on March 14, 2026."],
    ],
    [
      own(
        goal(TESS, "ventures", "raise a small seed fund", {
          also: ["raise a small seed fund for Midwest founders"],
          domains: ["money"],
        }),
      ),
      own(goal(O, "ventures", "launch a credit startup", { domains: ["career"] })),
      own(
        capability(TESS, "career", "read a credit file", {
          also: ["read a credit file fast", "underwriting small business loans"],
          domains: ["money"],
        }),
      ),
      own(
        capability(O, "career", "build underwriting models", {
          also: ["build underwriting models in Python"],
          domains: ["ventures"],
        }),
      ),
      own(role(TESS, "principal", "Kestrel Capital")),
      own(need(O, "ventures", "a first design partner", { domains: ["career"] })),
      own(
        need(TESS, "ventures", "a technical cofounder", {
          also: ["a technical cofounder for the data side"],
          domains: ["career"],
        }),
      ),
      own(constraint(O, "ventures", "cannot work more than ten hours a week", { domains: ["career"] })),
      own(prefers(TESS, "career", "small teams", { also: ["small teams over big committees"], domains: ["ventures"] })),
      own(situation(O, "education", "finishing my degree")),
      own(avoids(TESS, "money", "crypto deals", { domains: ["ventures"] })),
      own(prefers(O, "ventures", "bootstrapping", { also: ["bootstrapping to raising early"], domains: ["money"] })),
      own(constraint(TESS, "ventures", "cannot take money from family offices", { domains: ["money"] })),
      own(avoids(O, "career", "consulting work", { domains: ["ventures"] })),
      own(situation(TESS, "home", "between apartments", { domains: ["family"] })),
      own(role(O, "operations lead", "Brightline")),
      own(affiliation(TESS, "member", "Prairie Angels")),
      own(commitment(O, TESS, "I will draft the pitch outline by Friday.", FRIDAY)),
      own(commitment(TESS, O, "I will send you the fund memo on Thursday.", dayAfter(3))),
      own(plan(TESS, O, "Let's meet at the library on March 14, 2026.", "2026-03-14")),
    ],
    13_000,
    "thread",
  ),
  // The group-chat variant, two contacts known by a name alone, one's promise to the other.
  thread(
    "Founders",
    [TESS, ARLO],
    [
      [ARLO, "I am a backend engineer at Quarry Labs."],
      [TESS, "I need someone who knows card processing."],
      [ARLO, "I know payments infrastructure well, I built the ledger at my last job."],
      [O, "I am moving to Portland in June."],
      [ARLO, "I want to start a company in the next year."],
      [TESS, "I prefer meeting in person."],
      [ARLO, "I cannot leave Quarry Labs until the options vest."],
      [ARLO, "Tess, I will send you my resume tomorrow."],
    ],
    [
      own(role(ARLO, "backend engineer", "Quarry Labs")),
      own(need(TESS, "ventures", "someone who knows card processing", { domains: ["career"] })),
      own(
        capability(ARLO, "career", "payments infrastructure", {
          also: ["know payments infrastructure"],
          domains: ["ventures"],
        }),
      ),
      own(situation(O, "home", "moving to Portland", { also: ["moving to Portland in June"] })),
      own(goal(ARLO, "ventures", "start a company", { domains: ["career"] })),
      own(prefers(TESS, "relationships", "meeting in person", { domains: ["career"] })),
      own(
        constraint(ARLO, "career", "cannot leave Quarry Labs", {
          also: ["cannot leave Quarry Labs until the options vest"],
          domains: ["money"],
        }),
      ),
      own(commitment(ARLO, TESS, "Tess, I will send you my resume tomorrow.", dayAfter(1))),
    ],
    5_000,
    "group_named",
  ),
  // A one-to-one Messages thread of about 6 000 characters, two sessions, its first line five hours
  // before the rest; then a group chat of the owner and two contacts, one contact's promise to the
  // other.
  imessage(
    [LENA],
    [
      [O, "I am thinking about applying to the design program in Lisbon."],
      [LENA, "My goal is to open a small ceramics studio next year."],
      [LENA, "I teach pottery classes on weekends, so I know how to run a room full of beginners."],
      [O, "I need a quiet place to work two mornings a week."],
      [LENA, "I am a curator at the Northline Gallery."],
      [O, "I will send you my portfolio on Thursday."],
      [LENA, "I will introduce you to the studio landlord next week."],
      [LENA, "I avoid working after nine at night, it ruins the next day."],
    ],
    [
      own(
        goal(O, "education", "applying to the design program", {
          also: ["apply to the design program in Lisbon"],
          domains: ["career"],
        }),
      ),
      own(goal(LENA, "ventures", "open a small ceramics studio", { domains: ["career"] })),
      own(
        capability(LENA, "career", "run a room full of beginners", {
          also: ["teach pottery classes"],
          domains: ["interests"],
        }),
      ),
      own(
        need(O, "career", "a quiet place to work", {
          also: ["a quiet place to work two mornings a week"],
          domains: ["home"],
        }),
      ),
      own(role(LENA, "curator", "Northline Gallery")),
      own(commitment(O, LENA, "I will send you my portfolio on Thursday.", dayAfter(3))),
      own(commitment(LENA, O, "I will introduce you to the studio landlord next week.")),
      own(avoids(LENA, "health", "working after nine at night", { domains: ["career"] })),
    ],
    6_000,
    { earlyFirst: true },
  ),
  imessage(
    [OMAR, THEO],
    [
      [THEO, "I need someone to check the wiring in the new workshop."],
      [OMAR, "I am an electrician, I do this every week."],
      [O, "I am moving the workshop to the old mill in April."],
      [OMAR, "Theo, I will come by on Saturday to look at the wiring."],
    ],
    [
      own(
        need(THEO, "home", "someone to check the wiring", {
          also: ["check the wiring in the new workshop"],
          domains: ["ventures"],
        }),
      ),
      own(role(OMAR, "electrician")),
      own(
        situation(O, "ventures", "moving the workshop to the old mill", {
          also: ["moving the workshop"],
          domains: ["home"],
        }),
      ),
      own(commitment(OMAR, THEO, "Theo, I will come by on Saturday to look at the wiring.", dayAfter(5))),
    ],
    1_200,
    { title: "Workshop move" },
  ),
  // A Messages chat as people type one, which real sessions are and no line above is: lower case,
  // no final stop, an opening ok or lol, an emoji, curly apostrophes, one thought sent as two
  // messages (one passage), and the owner's question naming a week, which is no plan and no fact.
  // No filler: every line is the chat's own.
  imessage(
    [NINA],
    [
      [O, "hey so i’ve been doing a lot of ceramics lately"],
      [O, "i can throw pretty big bowls now \u{1F605}"],
      [NINA, "omg amazing!! lol yeah i’m a nurse at Ridge Clinic, i could never sit still long enough"],
      [O, "for dec 26–31 should i get one room at the inn or two?"],
      [NINA, "two, def"],
      [O, "ok let’s do dinner at Marlow on friday"],
      [NINA, "yes!! see you then"],
      [O, "i need a new kiln, mine cracked last week"],
      [NINA, "i’ll send you the name of my kiln guy tomorrow"],
    ],
    [
      own(capability(O, "interests", "throw pretty big bowls", { also: ["throw pretty big bowls now"] })),
      own(role(NINA, "nurse", "Ridge Clinic")),
      own(plan(O, NINA, "ok let’s do dinner at Marlow on friday", FRIDAY)),
      own(need(O, "interests", "a new kiln", { domains: ["home"] })),
      own(commitment(NINA, O, "i’ll send you the name of my kiln guy tomorrow", dayAfter(1))),
    ],
    // No filler: every line is the chat's own.
    0,
  ),
  // The shapes of the drops seen on typed chats, each a line a model copies otherwise than it is
  // typed: one thought sent as two messages with an emoji between (copied without it), a cup drawn
  // with its emoji selector (copied without the selector), a line with no final stop (copied with
  // one), and a rule over two messages with emoji among its twelve words (copied whole). No filler.
  imessage(
    [THEO],
    [
      [O, "i can only do weekends \u{1F629}"],
      [O, "bc of work"],
      [THEO, "honestly same, i run the \u{2615}\u{FE0F} cart at the farmers market"],
      [O, "need a bigger studio"],
      [THEO, "no calls before ten on weekdays \u{1F629} \u{1F629}"],
      [THEO, "until the baby sleeps through"],
      [O, "haha fair, the weather has been so weird this week anyway"],
      [THEO, "ya it rained all of saturday \u{1F327}\u{FE0F}"],
    ],
    [
      own(constraint(O, "career", "only do weekends \u{1F629}\nbc of work", { also: ["only do weekends"] })),
      own(
        capability(THEO, "ventures", "run the \u{2615}\u{FE0F} cart", { also: ["run the cart at the farmers market"] }),
      ),
      own(need(O, "interests", "a bigger studio", { domains: ["home", "career"] })),
      own(
        constraint(
          THEO,
          "family",
          "no calls before ten on weekdays \u{1F629} \u{1F629}\nuntil the baby sleeps through",
          { also: ["no calls before ten on weekdays"] },
        ),
      ),
    ],
    0,
  ),
  // A promise that only makes sense with the day before's messages ("it" is the ladder the owner
  // asked about on Monday), its "tomorrow" read from its own day, Tuesday; the two sessions are one
  // request, as the lane asks a thread's due days together. Monday's lines state no fact.
  imessageDays(
    [NINA],
    [
      {
        day: 0,
        lines: [
          [O, "do you still have the long ladder?"],
          [NINA, "yeah it’s in the garage somewhere"],
        ],
      },
      { day: 1, lines: [[NINA, "found it! i’ll drop it off at yours tomorrow morning"]] },
    ],
    [own(commitment(NINA, O, "i’ll drop it off at yours tomorrow morning", dayAfter(2)))],
  ),
  // A session of one short line that states a fact, under the screen's 200 code points and over the
  // floor of a moment read `db`.
  imessageDays(
    [THEO],
    [{ day: 2, lines: [[THEO, "i’ll bring the tile saw over saturday"]] }],
    [own(commitment(THEO, O, "i’ll bring the tile saw over saturday", dayAfter(5)))],
  ),
  // A chat typed as texting, which a model tidies when it copies a key phrase: mixed case, no
  // apostrophes, "u", "w/", "&", "ppl" and a letter dropped. Each fact is the passage's own words;
  // a model may copy it tidied. No filler.
  imessage(
    [OMAR],
    [
      [O, "omar!! Im Training For A Half Marathon w/ my sister"],
      [OMAR, "lol nice, i cant run anymore, my knee is shot"],
      [OMAR, "i need a physio who knows knees & backs"],
      [O, "I Want To Run The Lisbon Marathon With U Next Year"],
      [OMAR, "haha deal, im realy good at pacing ppl"],
      [O, "dont tempt me lol"],
    ],
    [
      own(
        situation(O, "health", "Training For A Half Marathon w/ my sister", { also: ["Training For A Half Marathon"] }),
      ),
      own(constraint(OMAR, "health", "cant run anymore")),
      own(need(OMAR, "health", "a physio who knows knees & backs", { also: ["a physio"] })),
      own(goal(O, "health", "Run The Lisbon Marathon With U", { also: ["Run The Lisbon Marathon"] })),
      own(capability(OMAR, "health", "realy good at pacing ppl", { also: ["pacing ppl"] })),
    ],
    0,
  ),
  // Short-term lines beside controls that must be kept. Where someone is today, a test tomorrow, a
  // ride, a flight and replies that only agree are no fact (a claim from one is an extra); a
  // commitment with something to do, a trip planned for December and a state that lasts three weeks
  // are still facts, however soon or far.
  imessage(
    [THEO],
    [
      [THEO, "omw, stuck in traffic on 35"],
      [O, "cool, will do"],
      [THEO, "not back in town till thursday night"],
      [THEO, "got my chem midterm tmrw ugh"],
      [O, "thats the plan"],
      [THEO, "flight boards in 20, call u after"],
      [THEO, "im on crutches for the next 3 weeks"],
      [THEO, "booked the cabin for dec 27, u + the kids + me"],
      [THEO, "ill send u the lease draft by friday"],
    ],
    [
      own(situation(THEO, "health", "on crutches", { also: ["on crutches for the next 3 weeks"] })),
      own(plan(THEO, O, "booked the cabin for dec 27, u + the kids + me", "2026-12-27")),
      own(commitment(THEO, O, "ill send u the lease draft by friday", dayAfter(4))),
    ],
    0,
  ),
]);
