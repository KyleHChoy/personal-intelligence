// The fixed words for each enum the page shows.

import type {
  AboutYouKind,
  ActivityCategory,
  AffiliationRelation,
  DeclineReason,
  FactSource,
  FactType,
  GOAL_STATES,
  GoalSource,
  LearnedItem,
  LifeDomain,
  OpportunityKind,
  OpportunityStatus,
  PreferencePolarity,
  Provenance,
  RelationshipRelation,
  ReportMark,
  SelfStatus,
  Stage,
  Tier,
  Who,
} from "@intelligence/contracts/personal";

// Each is a Record over the contract's enum, so a value the contract adds fails the type check, and
// `words.test.ts` holds each to the enum's own list.

export const OPPORTUNITY_KIND_WORDS: Record<OpportunityKind, string> = {
  follow_up: "Follow up",
  reply: "Reply",
  meeting_prep: "Prepare for a meeting",
  investigate: "Look into something",
  goal_step: "A step toward a goal",
  life_admin: "Life admin",
  owner_question: "A question for you",
  research: "Research",
  introduction: "Ask for an introduction",
};
export const OPPORTUNITY_STATUS_WORDS: Record<OpportunityStatus, string> = {
  proposed: "Waiting for your go",
  go: "Going ahead",
  no_go: "You said no",
  later: "Later",
  claimed: "An agent is on it",
  handed_to_owner: "Handed to you",
  done: "Done",
  expired: "Expired",
  withdrawn: "Withdrawn",
  outcome_met: "It worked",
  outcome_not_met: "It did not work",
};
export const STAGE_WORDS: Record<Stage, string> = {
  investigate: "Looking into it",
  prepare: "Preparing",
  draft: "Drafting",
  send: "Sending",
  pay: "Paying",
};
export const REPORT_MARK_WORDS: Record<ReportMark, string> = {
  web_only: "It used only the web, none of your own sources.",
  mixed_session: "It worked in a session that also read other things.",
};
export const BELIEF_STATUS_WORDS: Record<LearnedItem["status"], string> = {
  active: "In force",
  stale: "Stale",
  dormant: "Dormant",
  expired: "Expired",
  closed: "Closed",
};
export const SELF_STATUS_WORDS: Record<SelfStatus, string> = {
  ...BELIEF_STATUS_WORDS,
  retired: "No longer true",
  no_belief: "Kept as said",
};
// A person's tier of closeness.
export const TIER_WORDS: Record<Tier, string> = {
  inner: "Inner",
  close: "Close",
  regular: "Regular",
  known: "Known",
  outer: "Outer",
  "one-way": "One-way",
};
// Where a fact came from, by the kind of source the store says it is. A fact that names none reads
// as another source, never mail.
export const SOURCE_WORDS: Record<FactSource, string> = {
  mail: "From mail",
  messages: "From messages",
  screen: "From your screen",
  meeting: "From a meeting",
  calendar: "From your calendar",
  contacts: "From your contacts",
  document: "From a document",
  web: "From the web",
  agent: "From an agent",
  owner: "You said",
  other: "From another source",
};
export const sourceWords = (source: FactSource | undefined): string => SOURCE_WORDS[source ?? "other"];
// A belief's provenance, which names no source kind: a source's reads as another source.
export const PROVENANCE_WORDS: Record<Provenance, string> = {
  owner: "You said",
  source: SOURCE_WORDS.other,
  corroborated: "From more than one source",
  agent_reported: "An agent (inferred)",
};
export const FACT_TYPE_WORDS: Record<FactType, string> = {
  "transaction.receipt": "Purchase",
  commitment: "Commitment",
  plan: "Plan",
  role: "Role",
  affiliation: "Affiliation",
  relationship: "Relationship",
  need: "Need",
  capability: "Skill",
  goal: "Goal",
  preference: "Preference",
  constraint: "Constraint",
  situation: "Situation",
  view: "View",
  status: "Where something stands",
  visited: "Place you have been",
  consent: "Consent",
  contact_rule: "How to contact",
  "project.status": "Project status",
  "project.decision": "Project decision",
  "project.fact": "Project detail",
  "project.next_step": "Project next step",
  "capture.person": "Who was in a meeting",
  "capture.anchor": "Where a meeting was",
  "capture.project": "A meeting's project",
  link: "Link",
  known_person: "A person you know",
  owner_tie: "How you know them",
  connection: "A connection",
  intro_offer: "An offer to introduce",
  "activity.worked_on": "Worked on",
  "activity.researched": "Researched",
  "activity.messaged": "Messaged",
  "activity.met": "Met",
};
// A fact's type or a belief's kind in words; one the map does not hold reads "A fact". A belief's
// kind `decision` and `project_status` are a project's.
const KIND_ALIASES: Readonly<Record<string, FactType>> = {
  decision: "project.decision",
  project_status: "project.status",
};
export const factTypeWords = (type: string): string => {
  const known = Object.hasOwn(FACT_TYPE_WORDS, type) ? (type as FactType) : KIND_ALIASES[type];
  return known === undefined ? "A fact" : FACT_TYPE_WORDS[known];
};
// What a standing release keeps, by its kind, as a phrase after "about":
// "Keep what Scout quotes you saying about your preferences without asking".
export const GRANT_KIND_WORDS: Record<AboutYouKind, string> = {
  preference: "your preferences",
  constraint: "rules you live by",
  situation: "your situation",
  need: "your needs",
  capability: "your skills",
  role: "your roles",
  affiliation: "your ties to organizations",
  view: "your views",
  status: "where things stand with an organization",
  visited: "places you have been",
};
export const DECLINE_REASON_WORDS: Record<DeclineReason, string> = {
  not_worth_it: "Not worth it",
  wrong_timing: "Wrong timing",
  already_handled: "Already handled",
  wrong_person: "Wrong person",
  missing_context: "Missing context",
  other: "Another reason",
};
export const GOAL_STATE_WORDS: Record<(typeof GOAL_STATES)[number], string> = {
  active: "Active",
  paused: "Paused",
  done: "Done",
  dropped: "Dropped",
};
// Where a goal stated in a source came from, said as context on its row.
export const GOAL_SOURCE_WORDS: Record<GoalSource, string> = {
  mail: "From your mail",
  meeting: "From a meeting",
  calendar: "From your calendar",
  chat: "From a chat",
  agent_chat: "From your chats with agents",
  document: "From a document",
  agent: "Found by your agents",
  other: "From your sources",
};
export const LIFE_DOMAIN_WORDS: Record<LifeDomain, string> = {
  career: "Career",
  ventures: "Ventures",
  education: "Education",
  money: "Money",
  health: "Health",
  family: "Family",
  relationships: "Relationships",
  faith: "Faith",
  home: "Home",
  travel: "Travel",
  interests: "Interests",
  admin: "Admin",
};
// A piece of work's kind as a noun, where it labels a row (a result's line under its title):
// never a phrase that reads like an instruction ("Look into something").
export const OPPORTUNITY_KIND_NOUNS: Record<OpportunityKind, string> = {
  follow_up: "A follow-up",
  reply: "A reply",
  meeting_prep: "Meeting prep",
  investigate: "An investigation",
  goal_step: "A step toward a goal",
  life_admin: "Life admin",
  owner_question: "A question for you",
  research: "Research",
  introduction: "An introduction",
};
export const AFFILIATION_WORDS: Record<AffiliationRelation, string> = {
  employee: "works at",
  founder: "founded",
  owner: "owns",
  member: "is a member of",
  student: "studies at",
  alumnus: "studied at",
  advisor: "advises",
  investor: "invested in",
  board: "is on the board of",
  contractor: "contracts for",
  volunteer: "volunteers at",
  other: "is connected to",
};
// The same, said of several people after "others" (a tier proposal's trait).
export const AFFILIATION_PLURAL_WORDS: Record<AffiliationRelation, string> = {
  employee: "who work at",
  founder: "who founded",
  owner: "who own",
  member: "who are members of",
  student: "who study at",
  alumnus: "who studied at",
  advisor: "who advise",
  investor: "who invested in",
  board: "on the board of",
  contractor: "who contract for",
  volunteer: "who volunteer at",
  other: "connected to",
};
export const RELATIONSHIP_WORDS: Record<RelationshipRelation, string> = {
  spouse: "spouse",
  partner: "partner",
  parent: "parent",
  child: "child",
  sibling: "sibling",
  family: "family",
  friend: "friend",
  colleague: "colleague",
  manager: "manager",
  report: "report",
  mentor: "mentor",
  mentee: "mentee",
  assistant: "assistant",
  client: "client",
  vendor: "vendor",
  classmate: "classmate",
  neighbor: "neighbour",
  other: "connection",
  acquaintance: "acquaintance",
};
export const POLARITY_WORDS: Record<PreferencePolarity, string> = {
  likes: "Likes",
  dislikes: "Dislikes",
  prefers: "Prefers",
  avoids: "Avoids",
};
export const SUBJECT_WORDS: Record<Who["kind"], string> = {
  person: "Person",
  organization: "Organization",
  owner: "You",
  project: "Project",
};
export const ACTIVITY_WORDS: Record<ActivityCategory, string> = {
  coding: "Coding",
  writing: "Writing",
  communication: "Messages and mail",
  meetings: "Meetings",
  research: "Research",
  design: "Design",
  media: "Media",
  admin: "Admin",
  other: "Other",
};
