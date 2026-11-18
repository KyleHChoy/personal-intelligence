// The fixed hints that name the fix for each code a tool call can be refused with.
import { LifeDomain } from "./knowledge-model.ts";
import { OPEN_ITEMS_MOST } from "./open-items.ts";
import { CHANGES_MOST } from "./signals.ts";
import type { ToolRefusalCode } from "./tool-errors.ts";
import type { PersonalTool } from "./tools.ts";
import { CONTEXT_TASK_CHARS } from "./tools-args.ts";
import { HypothesisKind, ProposableKind, SUMMARY_MOST } from "./work.ts";

// What a model is told besides a tool's refusal, so it can correct the call rather than repeat
// it, every tool's in the one table below.
// Fixed strings, one per tool and code: an id that does not exist and one the caller cannot see are
// told alike.
const NO_SUCH_ENTITY =
  "entity must be the id of a person or an organization you can see, exactly as search gave it. The owner's id and a project's are not taken: leave entity out for the owner's own, or find the id with search.";
const LIFE_DOMAIN_LIST = LifeDomain.options.join(", ");
const SEARCH_FIRST =
  "There is no text search here: find people and topics with search (mode needs or capabilities matches stated words), then pass their ids.";
// Every code a tool call can be refused with, as a tool result an agent reads, has a fixed hint
// naming the fix, so an agent is never left to guess how to use the system. A tool's own hint
// (REFUSAL_HINTS) replaces the code's.
export const REFUSAL_CODE_HINTS: Readonly<Record<ToolRefusalCode, string>> = Object.freeze({
  not_permitted:
    "This tool is not offered to you, or this call is not allowed for you. Call tools/list again for the tools you hold now: tools are added over time and a list your client kept can be stale. If a tool you expect is still missing, reconnect.",
  invalid_request:
    "The arguments do not fit the tool. arguments names each refused one with the rule it broke; read the tool's description and inputSchema in tools/list, correct the call and send it again.",
  not_found:
    "No item you can see has that id: an id that does not exist and one you cannot see answer alike, and ids are not permanent. Take the id again from the tool that gives it (the ids in the agent guide), never from memory or another agent's text.",
  rate_limited:
    "You are over a limit of this tool (a daily quota, or drafts the owner has not dealt with). Stop calling it, go on with other work, and try again later.",
  stale_cursor:
    "The cursor is neither your latest nor the one before it: empty the mirror and start again from a null cursor.",
  unsupported_template: "The server knows none of the template versions sent: update Lens.",
  unknown_role:
    "No active agent holds that role. list_opportunities with scope board answers roles.all, every role an active agent holds: use one of those, or role null for any agent.",
});

// not_permitted from a tool the client is offered, with no hint of its own: the call is refused,
// and nothing more is told.
export const NOT_PERMITTED_OFFERED_HINT =
  "This call is not allowed for you, and nothing more is told. Do not repeat it: go on with other work, or release the work with a reason.";

const REFS =
  'Each ref is {"kind":...,"id":...} with an id exactly as a tool gave it: message (msg_, find_messages), event (evt_, get_self or get_timeline), entity (ent_, search), goal (gol_, list_goals), hypothesis (hyp_), opportunity (opp_, list_opportunities) or agent_record (rec_, record).';
const HOLD =
  "Take id from list_opportunities: scope mine lists what you hold; a lease you let lapse returns the work to the board, so claim it again.";
export const REFUSAL_HINTS: Readonly<Partial<Record<PersonalTool, Partial<Record<ToolRefusalCode, string>>>>> =
  Object.freeze({
    get_evidence_span: {
      invalid_request:
        "fact is a fact's 64-hex id from find_facts, or a line's fact from get_beliefs, get_self or a pack: never a message, entity or record id. Read a message with read_message, a document with get_document.",
      not_found:
        "No fact you can see has that id. A fact from chat that you can see is not this: it answers noPassage. A line's fact may rest only on what no tool serves, or the id may be another field's, such as a line's state or group. Call find_facts with belief set to the line's fact to list what you can read behind it, and take fact from there.",
    },
    read_item: {
      invalid_request:
        "read_item takes message (a msg_ id from find_messages or get_timeline), from and limit (1 to 20), the last two optional.",
      not_found:
        "No message you can see has that id: ids are not permanent, so find it again with find_messages. Held mail is not served.",
    },
    fetch_template: {
      invalid_request:
        "fetch_template takes document (a doc_ id from find_documents with reference true), offset and limit, the last two optional. A document that is not a Google Doc under a folder the owner marked as reference is refused: get_document reads any other.",
      not_found:
        "No reference document you can see has that id: take it from find_documents with reference true. An empty list means the owner has marked no reference folder.",
    },
    find_facts: {
      invalid_request: `find_facts takes type (a fact type, or transaction, project, capture or activity), entity (a person's, an organization's or a project's id from search; for the owner's own, leave entity out), from and to (an instant or a date) and limit (1 to 50), each optional; or belief (a line's fact) with limit alone. ${SEARCH_FIRST}`,
      not_found:
        "entity must be the id of a person, an organization or a project you can see, exactly as search gave it. For the owner's own facts leave entity out; otherwise find the id with search.",
    },
    find_messages: {
      invalid_request: `find_messages takes entity (an id from search), sender (one address, or one domain such as example.com), from and to (an instant or a date), category and limit (1 to 50), each optional. ${SEARCH_FIRST}`,
      not_found: NO_SUCH_ENTITY,
    },
    get_beliefs: { not_found: NO_SUCH_ENTITY },
    get_open_items: { invalid_request: `get_open_items takes only limit, 1 to ${OPEN_ITEMS_MOST}.` },
    get_changes: {
      invalid_request: `get_changes takes since (the cursor its last answer gave) and limit, 1 to ${CHANGES_MOST}, each optional.`,
    },
    get_commitments: {
      not_found: "with must be the id of a person or an organization you can see, exactly as search gave it.",
    },
    get_timeline: {
      invalid_request:
        "get_timeline takes id (an ent_ id from search, a person's, an organization's or a project's, never the owner's or a name), from, to and limit (1 to 100), the last three optional.",
      not_found:
        "id must be the id of a person or an organization you can see, exactly as search gave it; the owner's and a project's are not taken.",
    },
    get_entity: {
      invalid_request: "get_entity takes id, an ent_ id from search, never a name: find the id with search.",
      not_found:
        "No person, organization or project you can see has that id: ids are not permanent, so find it again with search.",
    },
    read_message: {
      not_found: "No message you can see has that id: ids are not permanent, so find it again with find_messages.",
    },
    build_context_pack: {
      invalid_request:
        "Each purpose takes exactly its own id: agent_bootstrap takes nothing else, meeting_prep takes event, person_brief takes entity, project_brief takes project.",
    },
    context: {
      invalid_request: `context takes task (1 to ${CONTEXT_TASK_CHARS} characters), and optionally entity (an id from search), event (a meeting's id) and domain (${LIFE_DOMAIN_LIST}).`,
      not_found:
        "No person, organization or meeting you can see has that id: ids are not permanent, so find it again with search.",
    },
    // Checks the provider makes past the schema. A key phrase uses the quote's words in the quote's order
    // (an answer's is an unbroken stretch of it), and a refusal by the claim checks carries its own code and
    // hint (CLAIM_REFUSAL_HINTS) in place of these. The agent states, the system types.
    propose_about_you: {
      invalid_request:
        "statement is the one fact about the owner in your words (1 to 600 characters), naming the thing and any date; quote, the owner's exact words when they said it (up to 6000, or 1000 with no statement); cites, the messages or meetings it rests on. The system decides its kind, and a goal of the owner's is propose_goal's. requestId is 8 to 64 letters, digits, _ or -.",
    },
    answer_owner_question: {
      // The system types the owner's words; the agent sends no facts.
      invalid_request:
        "answer_owner_question takes opportunity (the owner_question you hold), answer { quote: the owner's exact words, 1 to 8 000 code points; about: supports, refutes or neither } and requestId.",
      not_found:
        "No owner_question you can see has that id: take the id from list_opportunities again; if it is the same, stop, and tell the owner.",
    },
    close_commitment: {
      invalid_request:
        "commitment is a fact get_commitments gave you; ending is done, cancelled or released; evidence is 1 to 10 message, document or capture ids you read whole, never a calendar event's (evt_); note is at most 280 characters; requestId is new for each close.",
      not_found:
        "No open commitment you can see has that fact: find it again with get_commitments. If it is listed there, an item you cite was removed since: cite another you read whole.",
    },
    reopen_commitment: { not_found: "You wrote no close in force with that id." },
    // A store refusal of record is told apart by this text alone, never by a row. It
    // rides on every invalid_request of record, a schema refusal's too, so it says first that a
    // named argument's own rule is the reason.
    record: {
      not_found:
        "Each of cites must be the id of a message or a meeting you can see, exactly as a tool gave it, supersedes a note or finding of your own (a recordId record answered), and project a project search gave you. If they are, one of them was removed since: read your sources again and write it anew.",
      invalid_request:
        "If arguments names one, its rule says why. If none: requestId is new for each record, repeated only to retry the same one. supersedes names a note or a finding of yours, of the same kind, that no later record replaced: to correct one again, supersede its latest correction, record_reads' supersededBy.",
    },
    read_record: {
      invalid_request: "read_record takes record, a recordId record answered or an id find_records or a fact gave.",
      not_found: "No note, finding or handoff you can read has that id: find_records lists those you can.",
    },
    find_records: {
      invalid_request:
        "find_records takes project and subject (ids from search), client, from, to, text (1 to 200 characters) and limit (1 to 50), each optional.",
      not_found: "project and subject must be a project or a person or organization search gave you: search again.",
    },
    // A subject no one visible matches is not_found with
    // subject_unknown's own hint (CLAIM_REFUSAL_HINTS).
    about: {
      invalid_request:
        "about takes subject, exactly one of { id } as search gave it, { address } or { name }; areas (self, work, needs, ties, rules, activity), each once; asOf, an instant no later than now; and after, the next an earlier page answered, with the same asOf or none.",
    },
    list_people: {
      invalid_request:
        "list_people takes tiers (inner, close, regular, known, outer, one-way), dormant, limit (1 to 50) and after (the next an earlier page answered), each optional.",
    },
    propose_task: {
      invalid_request:
        "If arguments names one, its rule says why. A task is about a message, an event, a person or organization, a goal, or the owner; to ask the owner something or act for them, use propose_opportunity; a fact about the owner is propose_about_you. A quote of the owner in basis needs the record tool. Its hypothesis may not be about the owner. details holds whyNow, plan, decisionNeeded, risks, each 1 to 500 characters, one at least. A bet is work nobody asked for, routed to you: no role but your own name, and no owner_request in basis. requestId is new for each proposal, repeated only to retry the same one.",
      not_found: `A ref in about or basis, or the hypothesis, is not one you can see. ${REFS}`,
    },
    propose_goal: {
      invalid_request:
        'If arguments names one, its rule says why. change is add, reword, pause, done or drop; goal (from list_goals) for every change but add; statement (1 to 1000 characters) for add and reword alone; compartment, one of yours, for add alone; summary says why and names the work itself (a vague one is refused vague_summary); basis is 1 to 20 refs you can see, or what the owner said to you as {"kind":"owner_request","quote":"their words"}, which needs the record tool. requestId is new for each proposal, repeated only to retry the same one.',
      not_found:
        "No goal you can see has that id, or a ref of basis is not one you can see: find the goal again with list_goals.",
    },
    propose_goal_target: {
      invalid_request:
        'If arguments names one, its rule says why. goal is an active goal from list_goals; entity (a person or organization id from search) or name, one of them; a person\'s name is a full name, and organization: true says a name is an organization\'s; summary says why this target serves the goal and names the work itself; basis is 1 to 20 refs you read, or what the owner said to you as {"kind":"owner_request","quote":"..."}.',
      not_found:
        "No goal or person or organization you can see has that id, or a ref of basis is not one you can see: find it again with list_goals or search.",
    },
    propose_person: {
      invalid_request:
        "fields go inside fields, by kind. kind person: name, known_how, and at most one email, phone and linkedin (a linkedin.com/in/ URL); relationship: person (an id from search), relation, closeness; link: from, kind, to (two different ids), inferred (true when no source says so). basis is one text saying how you know it, never refs; with a quote, the name and known_how use its words in order. requestId is 8 to 64 letters, digits, _ or -. A person's role or title at an organization is none of these: record a finding's claims, type role {title, organization_name}.",
      not_found:
        "Every person or organization id must be one you can see, exactly as search gave it; a relationship's person and a link's from are people. Propose a person not yet known with kind person.",
    },
    list_opportunities: {
      invalid_request:
        "list_opportunities takes scope (open, mine, board or closed), tier (task or opportunity), role (one of roles.all from scope board), limit (1 to 25), with scope board project (an ent_ id) and area (an area's key from list_projects' areas) and, with scope closed, after (a page's next), each optional.",
    },
    claim_opportunity: {
      invalid_request:
        "claim_opportunity takes id (an opp_ id or hdl_ handle, as list_opportunities and claim_opportunity answer it in opportunity.id or id: not a notice's ntc_ id, a move's mov_ id or a card's) and requestId, 8 to 64 letters, digits, _ or -, new for each claim.",
      not_found:
        "No work you may claim has that id: take it from list_opportunities with scope open. A task routed to a role you lack, or one no intent of yours lists, answers this too.",
    },
    release_opportunity: {
      invalid_request:
        "release_opportunity takes id, reason (not_my_role, blocked, no_time, duplicate or other; required on a task), optionally record (a handoff's recordId from record) and requestId.",
      not_found: `You hold no work with that id and were not offered it. ${HOLD}`,
    },
    post_agent_message: {
      invalid_request:
        'post_agent_message takes kind (note, question, issue or answer), body, requestId and exactly one of: to ({"client":"name"}, {"role":"research"} or {"all":true}) with a subject, for a new thread; replyTo (an amg_ id from read_agent_inbox), with no subject, for a reply. You cannot write to yourself, nor to an agent not cleared for all you are: write to all or a role instead.',
      not_found:
        "No agent has that name, or no message you can see has that id: take replyTo from read_agent_inbox, and a role from roles.all (list_opportunities, scope board).",
      unknown_role:
        "No agent holds that role: take one of roles.all from list_opportunities with scope board, or write to all.",
    },
    read_agent_inbox: {
      invalid_request:
        "read_agent_inbox takes scope (unread, all or thread), thread (an amg_ id, with scope thread only), markRead and limit (1 to 50), each optional.",
      not_found: "No thread you can see has that id: take it from a message's thread in read_agent_inbox.",
    },
    submit_improvement: {
      invalid_request:
        "submit_improvement takes kind (bug or improvement), area (mcp, extraction, knowledge, work, planner, sources, deploy, docs or other), severity (low, medium, high or critical), title (up to 200), detail (up to 8000), optionally evidence (up to 4000), and requestId.",
      not_found: "Nothing here takes an id: file it again with a new requestId.",
    },
    list_improvements: {
      invalid_request:
        "list_improvements takes status (a list of open, triaged, in_progress, done, wont_do and duplicate; left out, the three open ones), area, improvement (an imp_ id), mine (true for the defects whose role you hold), limit (1 to 50) and after (the next a page answered, with the same filters), each optional.",
      not_found: "No improvement you can see has that id: take it from list_improvements.",
    },
    get_health: { invalid_request: "get_health takes no arguments." },
    mark_health_seen: {
      invalid_request:
        "mark_health_seen takes card (a crd_ id from get_health's cards or a box_health notice) and requestId.",
      not_found:
        "No box health card you can see has that id: take card from get_health's cards. Other cards are not marked here.",
      not_permitted: "You do not hold mark_health_seen: tell the owner the card needs a look.",
    },
    get_work_time: {
      invalid_request:
        "get_work_time takes from and to, local days (YYYY-MM-DD), to on or after from, at most 14 days.",
      not_permitted: "You do not hold get_work_time: the owner grants it.",
    },
    read_meeting: {
      invalid_request:
        "read_meeting takes meeting (a cap_ id from get_timeline's captured_meeting, a meeting fact's capture in find_facts, or a pack's lastCapture) and optionally from (the next a page answered).",
      not_found:
        "No recorded meeting you can see has that id: take it from get_timeline, find_facts or a meeting_prep pack.",
      not_permitted: "You do not hold read_meeting: the owner grants it with the work view.",
    },
    set_anchor: {
      invalid_request:
        "set_anchor takes project (an ent_ id from list_projects), kind (repository, host, document or app), value (the place as get_work_time serves it) and requestId.",
      not_found:
        "No active project you can see has that id, or the place is too generic to anchor (a bare app, a common host, a home folder): take project from list_projects, or rule the stretches with rule_time.",
      not_permitted: "You do not hold set_anchor: the owner grants it.",
    },
    lift_anchor: {
      invalid_request: "lift_anchor takes anchor (an aan_ id from get_work_time's anchors) and requestId.",
      not_found: "No live anchor of yours has that id: take it from get_work_time's anchors. You lift only your own.",
      not_permitted: "You do not hold lift_anchor: the owner grants it.",
    },
    rule_time: {
      invalid_request:
        "rule_time takes from and to (to after from, at most 24 hours apart), project (an ent_ id from list_projects) and requestId.",
      not_found: "No active project you can see has that id: take project from list_projects.",
      not_permitted: "You do not hold rule_time: the owner grants it.",
    },
    lift_time_ruling: {
      invalid_request: "lift_time_ruling takes ruling (an atr_ id from get_work_time's rulings) and requestId.",
      not_found: "No live ruling of yours has that id: take it from get_work_time's rulings. You lift only your own.",
      not_permitted: "You do not hold lift_time_ruling: the owner grants it.",
    },
    judge_time_proposal: {
      invalid_request:
        "judge_time_proposal takes proposal (a tpr_ id from get_work_time's proposals), optionally project (an ent_ id from list_projects, to redirect it) and requestId. There is no reject: leave a proposal you doubt to the owner.",
      not_found:
        "No live proposal you can see has that id, or no active project you can see has the one you named: take proposal from get_work_time and project from list_projects.",
      not_permitted: "You do not hold judge_time_proposal: the owner grants it.",
    },
    file_learning: {
      invalid_request:
        "file_learning takes statement (what you learned, up to 300), rule (what to do because of it, up to 500), evidence (what you called and what came back, up to 2000; never a secret), scope (general, or one role you hold), optionally supersedes (the lrn_ id of a learning you filed, of the same scope), and requestId.",
      not_found:
        "No learning of yours of that scope is active with that id: supersedes takes only a learning you filed, of the same scope.",
      not_permitted: "You do not hold file_learning: the owner grants it.",
      rate_limited:
        "You filed ten learnings in the last 24 hours: keep the rest until tomorrow, or supersede one that says less.",
    },
    list_levers: { invalid_request: "list_levers takes no arguments." },
    set_lever: {
      invalid_request:
        "set_lever takes key (a lever's key from list_levers), value (of the lever's type, from its min to its max or one of its allowed codes), reason (a code such as tune or undo: lower case letters, digits and _) and requestId.",
      not_found: "No lever has that key: take key from list_levers.",
      not_permitted:
        "Only the owner moves this lever (list_levers shows mover owner), or you do not hold set_lever: the owner grants it. File what you would change with submit_improvement.",
    },
    report_wrong_merge: {
      invalid_request:
        "report_wrong_merge takes entity (a person's ent_ id from search), parts (two to four lists of that person's addresses as get_entity serves them, each address once), because (a code: lower case letters, digits and _), cites (up to 20 msg_ ids you read) and requestId.",
      not_found:
        "No person you can see has that id, an address is not one get_entity serves for that person, or a cited message is not one you can read: take entity from search, the addresses from get_entity and cites from find_messages.",
      not_permitted:
        "You do not hold report_wrong_merge: the owner grants it. File what you found with submit_improvement.",
    },
    report_wrong_relation: {
      invalid_request:
        "report_wrong_relation takes relation (a relation's id from a belief's relations in about), because (not_same_fact, not_superseded, not_contradicting, source_misread or different_subjects), cites (up to 20 msg_ or doc_ ids you read) and requestId.",
      not_found:
        "No relation in effect that you can see has that id, or a cited message or document is not one you can read: take relation from about and cites from find_messages or find_documents.",
      not_permitted:
        "You do not hold report_wrong_relation: the owner grants it. File what you found with submit_improvement.",
    },
    propose_project: {
      invalid_request:
        "propose_project takes name (up to 200), optionally goal (a gol_ id from list_goals), ownerRole (a role), dueAt and area (an area's key from list_projects' areas), and requestId.",
      not_found: "No goal you can see has that id: take goal from list_goals, or leave it out.",
      unknown_role: "No agent holds that role: take one of roles.all from list_opportunities with scope board.",
    },
    update_project: {
      invalid_request:
        "update_project takes project (an ent_ id from list_projects or search), at least one of status (planned, active, blocked, waiting or done), name, ownerRole, goal, dueAt, area (an area's key from list_projects' areas; null clears the last four) and note (up to 2000), and requestId. A status or a note is kept as your finding, so it needs the record tool.",
      not_found:
        "No project you can see has that id, or no goal you can see has the one you named: take project from list_projects or search, and goal from list_goals.",
      unknown_role: "No agent holds that role: take one of roles.all from list_opportunities with scope board.",
    },
    list_projects: {
      invalid_request:
        "list_projects takes status (a list of planned, active, blocked, waiting, paused, done, cancelled and closed), area (an area's key from areas), order (changed or area), after (the next a page answered, with the same order) and limit (1 to 50), each optional.",
    },
    list_ideas: {
      invalid_request: "list_ideas takes limit (1 to 50), optional.",
      not_permitted: "You do not hold list_ideas: the owner grants it. File ideas with propose_hypothesis kind idea.",
    },
    get_project: {
      invalid_request: "get_project takes project: an ent_ id or hdl_ handle from list_projects or search.",
      not_found: "No project you can see has that id: take it from list_projects, or find it by name with search.",
    },
    update_improvement: {
      invalid_request:
        "update_improvement takes improvement (an imp_ id from list_improvements), status (open, triaged, in_progress, done, wont_do or duplicate), duplicateOf (another imp_ id that is not itself a duplicate, with status duplicate only), optionally note (up to 2000) and fixRef (pr:<number>, commit:<hash>, lever:<key>, or none:not_reproducible, none:owners_to_change or none:duplicate), and requestId.",
      not_found: "No improvement you can see has that id: take improvement and duplicateOf from list_improvements.",
    },
    hand_off: {
      invalid_request:
        "hand_off takes id (work you hold or held in the last 24 hours: an opp_ id or hdl_ handle, as list_opportunities and claim_opportunity answer it in opportunity.id or id: not a notice's ntc_ id, a move's mov_ id or a card's), reason (other_role, blocked or other), optionally role (one of roles.all from list_opportunities with scope board; left out or null, any agent; owner, the owner, for an opportunity only, never a task, and then record is needed) and record (a handoff's recordId: record with kind handoff first), and requestId.",
      not_found: `No work you can see has that id. ${HOLD}`,
    },
    plan_move: {
      invalid_request:
        "plan_move takes opportunity (work you hold: an opp_ id or hdl_ handle, as list_opportunities and claim_opportunity answer it in opportunity.id or id: not a notice's ntc_ id, a move's mov_ id or a card's), stage (investigate, prepare, draft, send or pay) and requestId.",
      not_permitted: `Only an internal, read-only stage (investigate or prepare) of work you hold, the stage your work is at, is ever cleared: drafting, sending and paying never are. reason, when given, says what stood in the way. ${HOLD}`,
      not_found: `You hold no work with that id. ${HOLD}`,
    },
    report_move: {
      invalid_request: `report_move takes move (the id plan_move answered), outcome (done, failed, blocked or progress), report { deliverable, sources, uncertain, next, reason, draft, candidates, fill; for progress: done (at most 20 lines of at most 500 code points each), next, waitingOn, resumeAt }, never those at the top level, optionally summary, basis (refs) and lessonsApplied (lesson ids from your brief), and requestId. A source is a ref or a short text of at most 500 code points. ${REFS}`,
      not_found:
        "Your report was not kept. move must be the id plan_move answered you. A report sent again answers as the first did, so this is not that: a ref in basis may not be one you can see, or something you read may have been removed. Read list_opportunities with scope mine; plan_move again for a move still yours, and send the same report with a new requestId.",
    },
    relay_card_answer: {
      invalid_request:
        "relay_card_answer takes card (your card_relay task's brief gives relay.id), option (one of that brief's relay.options), quote (the owner's exact words, 1 to 2000 characters) and requestId.",
      not_found:
        "No card you can see has that id. Take card from your card_relay task's brief, relay.id; if the card is gone, release the task.",
      not_permitted: "You do not hold relay_card_answer: the owner grants it. Release the task.",
    },
    write_back: {
      invalid_request:
        "write_back takes source (the source a signal or item gave you: kind and id), state (handled, drafted or needs_owner), optionally note (what happened, in names, never ids), with needs_owner tried (what you searched and read first), and requestId.",
      not_found:
        "No signal or item you can see has that source: take it from get_changes, get_open_items or list_opportunities.",
    },
    record_spend: {
      invalid_request:
        "record_spend takes modelId, costMicroUsd (a whole number, 0 only to ask whether you may go on) and requestId.",
      not_found: "record_spend names no row: it needs a session of yours, so start it again.",
    },
    start_outcome_test: {
      invalid_request:
        "start_outcome_test takes suite, tasks, answerModel, judgeModel (a different model) and requestId.",
    },
    record_held_out_question: { invalid_request: "record_held_out_question takes class, question, key and requestId." },
    record_outcome_task: {
      invalid_request:
        "record_outcome_task takes run, task, heldOut, score, codeCap, judgeScore, answerModel, judgeModel (a different model), failed, toolCalls, costMicroUsd, answer, scoring and requestId.",
      not_found: "No run of yours has that id: take it from start_outcome_test.",
    },
    set_intention: {
      invalid_request:
        "set_intention takes opportunity (an id you hold, or held in the last 24 hours), dueAt (an instant at least one hour and at most 30 days ahead; with park false, which holds nothing, at most 90 days) and requestId, optionally note (one line of at most 500 code points), park and keepEarlier; at most three of yours waiting on one opportunity.",
      not_found: `You hold no work with that id. ${HOLD}`,
    },
    propose_opportunity: {
      invalid_request: `kind is ${ProposableKind.options.join(", ")}; about is {"kind":"owner"} or a ref; summary is 1 to ${SUMMARY_MOST} code points and names the work itself; basis is 1 to 20 refs, or {"kind":"owner_request","quote":"the owner's words"}, which needs the record tool; details, if given, holds whyNow, plan, decisionNeeded or risks, each 1 to 500 characters; requestId is new for each proposal. Read-only work for an agent is propose_task. ${REFS}`,
      not_found: `A ref in about or basis, or the hypothesis, is not one you can see. ${REFS}`,
    },
    propose_hypothesis: {
      invalid_request: `kind is ${HypothesisKind.options.join(", ")} or idea; about is {"kind":"owner"} or a ref, and a ref for an idea; summary is 1 to ${SUMMARY_MOST} code points and names the work itself; basis is 1 to 20 refs; idea (a hyp_ id from list_ideas) goes with kind idea alone; requestId is new for each proposal. ${REFS}`,
      not_found: `A ref in about or basis, or the idea, is not one you can see: take idea from list_ideas. ${REFS}`,
    },
    record_test: {
      invalid_request: `record_test takes hypothesis (a hyp_ id from propose_hypothesis or a brief), result (supports, refutes or inconclusive), basis (1 to 20 refs) and requestId. ${REFS}`,
      not_found: `The hypothesis or a ref in basis is not one you can see. ${REFS}`,
    },
  });
