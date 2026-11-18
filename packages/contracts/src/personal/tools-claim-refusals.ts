// The fixed hints that name the fix for each code a claim can be refused with, by tool and field.
import type { ClaimRefusal } from "./tool-errors.ts";
import type { PersonalTool } from "./tools.ts";

// A call in propose_about_you's older shape, kind and fields with no statement.
const OLD_SHAPE =
  "send statement, the one fact in your words, naming the thing and any date, and leave kind and fields out: the system decides the kind";

// The field a claim refusal is about, by tool, and for a code whose general hint would mislead there
// its own. The agent API sends `field` beside the code, so a refusal names what to change.
export const CLAIM_REFUSAL_FIELDS: Readonly<
  Partial<Record<PersonalTool, Partial<Record<ClaimRefusal, { field: string; hint?: string }>>>>
> = Object.freeze({
  propose_about_you: {
    not_standalone: { field: "statement" },
    multi_fact: { field: "statement" },
    negated_object: { field: "statement" },
    bad_fields: { field: "statement", hint: OLD_SHAPE },
    not_in_quote: { field: "statement", hint: OLD_SHAPE },
    not_owner_words: {
      field: "quote",
      hint: "quote is the owner's own words, not your statement or a part of it: copy what they said, or leave quote out if they did not say it",
    },
    goal_proposed_elsewhere: { field: "statement" },
  },
  propose_person: {
    not_in_quote: {
      field: "fields.name, fields.known_how",
      hint: "with a quote, every word that carries meaning in fields.name and fields.known_how must be in quote, in its order: use its words, or leave quote out",
    },
    multi_fact: { field: "fields.name, fields.known_how" },
    not_standalone: { field: "fields.known_how" },
    bad_fields: {
      field: "fields.email, fields.phone, fields.linkedin",
      hint: "email is one plain address, phone a phone number, linkedin a linkedin.com/in/ profile URL; leave out any you do not have",
    },
  },
  propose_goal: { vague_summary: { field: "summary" } },
  propose_goal_target: { vague_summary: { field: "summary" } },
  propose_task: { vague_summary: { field: "summary" }, bet_budget_spent: { field: "bet" } },
  propose_opportunity: {
    vague_summary: { field: "summary" },
    question_unpaid: { field: "tried" },
    bet_budget_spent: { field: "bet" },
    bet_needs_owner: { field: "bet" },
  },
  propose_hypothesis: { vague_summary: { field: "summary" } },
  close_commitment: {
    already_closed: { field: "commitment" },
    evidence_not_read: { field: "evidence" },
    evidence_unrelated: { field: "evidence" },
    evidence_predates: { field: "evidence" },
    reopened_by_owner: { field: "evidence" },
    label_wider: { field: "evidence" },
  },
  answer_owner_question: {
    not_owner_words: { field: "answer.quote" },
    not_a_question: { field: "opportunity" },
    work_not_held: { field: "opportunity" },
    work_closed: { field: "opportunity" },
    question_needs_owner_go: { field: "opportunity" },
    move_not_cleared: { field: "opportunity" },
    question_answered: { field: "opportunity" },
  },
  write_back: { question_unpaid: { field: "tried" } },
  hand_off: {
    question_unpaid: { field: "tried" },
    work_not_held: { field: "id" },
    work_closed: { field: "id" },
    owner_needs_record: { field: "record" },
    task_not_to_owner: { field: "role" },
    record_not_your_handoff: { field: "record" },
    record_not_taken_in: { field: "record" },
    record_removed: { field: "record" },
    record_label_wider: { field: "record" },
  },
  claim_opportunity: {
    work_held: { field: "id" },
    work_closed: { field: "id" },
    work_blocked: { field: "id" },
    work_for_other_role: { field: "id" },
    // Claim's own: the plan_move hint says to release work the caller does not hold.
    no_harness_mode: {
      field: "id",
      hint: "you are not cleared for this kind of work at its next stage (its board row's kind and stage), or the owner's permission for that work is off, so it is not yours to take: take other work from list_opportunities with scope open, which lists only work you may claim",
    },
    not_go: { field: "id" },
    kill_switch: {
      field: "id",
      hint: "the owner stopped all agent work, so no work is claimed and no lease is renewed until they start it again: stop, and read list_opportunities with scope mine when you next run",
    },
  },
  // A release of work the caller does not hold releases nothing: said so, never "claim first".
  release_opportunity: {
    work_not_held: {
      field: "id",
      hint: "you do not hold this work and it is not offered to you, so there is nothing to release: go on with other work",
    },
    work_closed: {
      field: "id",
      hint: "this work is closed already, as a done or failed report closes it: there is nothing to release",
    },
    release_needs_reason: { field: "reason" },
    record_not_your_handoff: { field: "record" },
    record_not_taken_in: { field: "record" },
    record_removed: { field: "record" },
    record_label_wider: { field: "record" },
  },
  set_intention: {
    work_not_held: {
      field: "opportunity",
      hint: "you hold no lease on this work, held none in the last 24 hours and no check-back of yours holds it: claim_opportunity first, then set_intention",
    },
    work_closed: { field: "opportunity" },
    due_too_soon: { field: "dueAt" },
    due_too_far: { field: "dueAt" },
    due_past_expiry: { field: "dueAt" },
    check_backs_full: { field: "keepEarlier" },
    holds_full: { field: "park" },
    kill_switch: {
      field: "opportunity",
      hint: "the owner stopped all agent work, so no check-back is set and no work is held further until they start it again: stop, and read list_opportunities with scope mine when you next run",
    },
  },
  relay_card_answer: {
    not_owner_words: {
      field: "quote",
      hint: "quote is what the owner said in answer, not what the card says or a part of it: copy the owner's own words, or release the task if they did not answer",
    },
    not_an_option: { field: "option" },
    not_question_role: { field: "card" },
    card_not_routed: { field: "card" },
    already_relayed: { field: "card" },
    owner_answered: { field: "card" },
    own_card: { field: "card" },
    kill_switch: {
      field: "card",
      hint: "the owner stopped all agent work, and no answer is relayed while it is stopped: stop; the question stays on the owner's page",
    },
    work_not_held: {
      field: "card",
      hint: "you hold no live lease on this card's card_relay task: claim it from list_opportunities first, and take card from its brief's relay.id",
    },
  },
  update_improvement: {
    closes_by_measure: { field: "status" },
    needs_fix_ref: { field: "fixRef" },
    fix_ref_refused: { field: "fixRef" },
  },
  mark_health_seen: {
    owners_card: { field: "card" },
    came_back_after_seen: { field: "card" },
    card_closed: { field: "card" },
  },
  set_anchor: { anchor_taken: { field: "value" } },
  propose_project: { area_unknown: { field: "area" } },
  update_project: { area_unknown: { field: "area" } },
  // A report that cannot be kept: what an agent does next decides whether its work is lost.
  report_move: {
    work_not_held: {
      field: "move",
      hint: "your report was not kept: your lease on this work ended. A finding you recorded stays. claim_opportunity again if list_opportunities offers it, plan_move, then send the same report with a new requestId",
    },
    work_closed: {
      field: "move",
      hint: "your report was not kept: this work closed before it came. A finding you recorded stays; take other work from list_opportunities with scope open",
    },
    move_closed: { field: "move" },
    due_too_soon: {
      field: "report.resumeAt",
      hint: "report.resumeAt must be at least one hour ahead: send a later instant, or leave it out to hold the work 7 days",
    },
    due_too_far: {
      field: "report.resumeAt",
      hint: "report.resumeAt must be at most 30 days ahead: send an earlier instant",
    },
    due_past_expiry: { field: "report.resumeAt" },
    holds_full: {
      field: "report.waitingOn",
      hint: "your report was not kept: you already hold 20 pieces of work by check-back, the most one agent may, so this one cannot be held to wait. Finish, release or hand off one first, or send blocked with waitingOn left out, which gives this work back to the board",
    },
  },
});

// The fixed hint sent with each claim refusal. The first is the owner's own words.
export const CLAIM_REFUSAL_HINTS: Readonly<Record<ClaimRefusal, string>> = Object.freeze({
  not_standalone: "name the thing itself: this fact must make sense with no conversation around it",
  multi_fact: "one fact per call: this phrase holds two facts or a list of three or more; propose each on its own",
  negated_object:
    "name the thing and put the negation in polarity: avoids with the thing itself, never avoids with a negated phrase",
  bad_fields:
    "the phrase must hold a word that carries meaning, in at most 12 words and 90 characters, with a domain from the list",
  not_in_quote:
    "every word of the phrase must be in quote, in its order; only a, an, the, my or our may be added; it may skip no not, over, instead, rather, than, except or but, and no not, no, never or n't may stand before it in its clause",
  not_what_was_said: "the phrase must say what the quote says, with the same polarity",
  not_owner_words: "each of quotes must be the owner's own words, not your statement or a part of it",
  already_closed: "this commitment is closed already, or another close of it is in force",
  evidence_not_read:
    "each evidence id must be an item you read whole by its id (read_message, get_document or read_item) and can still see; read each again, or leave out any you did not",
  evidence_unrelated:
    "at least one item must be related to the commitment: a message in its thread, or one, a meeting or a capture item its counterparty took part in",
  evidence_predates:
    "at least one related item must be newer than the commitment's latest statement; the promise itself does not show it ended",
  reopened_by_owner: "the owner reopened this commitment: close it only with a related item newer than their reopen",
  label_wider:
    "you can read compartments this commitment's readers cannot, or an item you cite is under one: such a close cannot be shown under the commitment's label",
  closes_off: "closing commitments is off until the owner turns it on",
  finding_untyped:
    "a finding must carry its facts as typed claims: a subject, a type, that type's fields and the passages it rests on",
  subject_ambiguous:
    "the name matches more than one person or organization: pick one of the candidates and name it by its id",
  subject_unknown: "no person or organization you can see has this id, address or name",
  fields_invalid: "the fields are not this type's: give exactly its key fields and value, as the type lists them",
  vague_summary:
    "summary must name the work itself, for someone who never saw your session: at least 3 words, 2 of them words that carry meaning (not a, the, to, it or them), never a placeholder such as x, test, tbd or todo",
  question_unpaid:
    'a question to the owner (an owner_question, a details.decisionNeeded, hand_off to role owner, or write_back needs_owner) pays first: search and read, and ask only what that leaves open. Send tried with all three: searches, 1 to 5 search tool calls you made in the last 24 hours (search, find_messages, find_facts, find_documents, find_records, find_paths, get_timeline, build_context_pack or context), each {"tool","query"}; sources, 1 to 10 ids of items you read by id in the last 24 hours (read_message, get_document, read_item, read_record), still visible to you and within the work\'s label; why, one sentence on why they did not settle it. For example "tried":{"searches":[{"tool":"find_messages","query":"venue for the spring offsite"}],"sources":["msg_..."],"why":"No message names a venue or a date."}',
  bet_budget_spent:
    "your bets for the last 7 days have used your budget: 3, one more for each of your bets the owner kept or confirmed in the last 7 days, two fewer for each answer of yours the owner took back in them, from 1 to 10. A place comes back 7 days after the bet that took it; agent_bootstrap's record shows bets.left. Cite your finding in report_move's basis: only the bet's own work counts. Propose it without bet, or wait",
  bet_needs_owner:
    "a bet approves only read-only work (investigate, meeting_prep, goal_step, life_admin) you propose yourself, with no details.decisionNeeded: work that drafts, sends or pays, and an owner_question, need the owner's go. Propose it without bet",
  ids_in_prose:
    "write names, not ids, in text a person reads (summary, deliverable, next, uncertain, reason, draft, statement, quote, note, body, basis, and details' whyNow, plan, decisionNeeded, risks): name the person, organization, message or meeting, with its date; put ids only in refs, cites and sources",
  subject_is_owner:
    "a fact about the owner goes through propose_about_you, a goal of theirs through propose_goal, and who someone is to them through propose_person: never a typed claim on a finding",
  goal_proposed_elsewhere:
    "a goal of the owner's, or a change to one, is proposed with propose_goal, never propose_about_you",
  not_a_question:
    "this work is not an owner_question, and only one takes an answer: finish it with report_move; a fact the owner told you is propose_about_you",
  not_a_task: "only a task is handed off: give this opportunity back with release_opportunity and a reason",
  kill_switch: "the owner stopped all work: nothing clears until they start it again.",
  not_go: "the owner has not said go on this work: it waits on their decision.",
  no_intent: "no standing permission covers this work: tell the owner, whose intent it needs.",
  intent_revoked: "the owner revoked the permission this work went ahead under: tell them, or release it.",
  kind_not_listed: "the owner's permission does not cover this kind of work: tell them, or release it.",
  client_not_listed:
    "the owner's permission for this work names other agents: release it, or tell them it should name you.",
  no_harness_mode: "you are not cleared for this stage of this kind of work: release it, or hand it off.",
  not_act: "you are cleared only to propose on this stage: release it, or hand it off.",
  not_next_stage: "that is not the stage this work is at: claim_opportunity's brief names the next one.",
  not_internal: "only an internal, read-only stage is ever cleared: drafting, sending and paying are not.",
  work_not_held:
    "you hold no live lease on this work: claim_opportunity first; a lease you let lapse returned it to the board, yours alone to claim for 24 hours, and report_move blocked gave up your lease",
  work_held:
    "another agent holds this work, or held it until its lease lapsed in the last 24 hours, or it is not yours to take: take other work from list_opportunities with scope open",
  work_closed: "this work is closed or no longer offered: take other work from list_opportunities with scope open",
  question_needs_owner_go:
    "you hold this question and your move is cleared, so what is missing is not yours to fix: an answer counts only after the owner said go on its card, and they have not: release_opportunity with reason blocked, and tell the owner",
  session_renewed:
    "something you read earlier in this session has been removed at its source, so nothing of this call was kept, and your session has started anew. Read again what you need, write only what those reads support, and do not restate what you read before this refusal",
  move_not_cleared:
    "plan_move with stage investigate first, and ask the owner once it is cleared; then send their exact words",
  question_answered: "this question has its answer: one answer finishes it, and the owner corrects it, not you",
  closes_by_measure:
    "the system filed this defect and closes it itself when its measure reads ok, or stops having data: set in_progress with a fixRef for what you changed, or triaged with fixRef none:owners_to_change when the change is not one you can make",
  needs_fix_ref:
    "taking a defect the system filed needs what it is taken with: send fixRef with in_progress, one of pr:<number>, commit:<hash> or lever:<key> (a lever you moved with set_lever); if you changed nothing, send triaged with fixRef none:not_reproducible, none:owners_to_change or none:duplicate",
  fix_ref_refused:
    "this fixRef does not stand: lever:<key> must name a lever whose latest change is yours (set_lever), made after this defect opened, and judged by the measure the defect is filed for (list_levers shows each lever's measure and last change); ops:<code> has no code open yet; none:<code> goes with status triaged only",
  record_not_taken_in:
    "your handoff record is written and not taken in yet, which takes about a minute: send the same call again in a minute",
  record_removed:
    "your handoff record was removed after you wrote it, so no work can rest on it: call record with kind handoff again, then send the new recordId",
  record_label_wider:
    "your handoff record carries your whole clearance as its label, which is wider than this work's, so this work cannot rest on it, and writing it again gives it the same label: send the same call without record. A hand-off to the owner needs one, so hand this work to a role or to any agent instead, or release_opportunity with reason blocked",
  record_not_your_handoff:
    "record must be the recordId of a handoff you wrote and can still see: call record with kind handoff, then send the recordId it answers",
  release_needs_reason: "releasing a task needs reason: not_my_role, blocked, no_time, duplicate or other",
  owner_needs_record:
    "handing work to the owner needs record, the note the owner reads: call record with kind handoff saying what they must decide, then send its recordId",
  task_not_to_owner:
    "a task is never handed to the owner: hand it to a role, or to any agent with role left out, or release_opportunity with reason blocked",
  due_too_soon: "dueAt must be at least one hour ahead: send a later instant",
  due_too_far:
    "dueAt must be at most 30 days ahead for a check-back that holds the work, and at most 90 days ahead with park false, which holds nothing: send an earlier instant",
  due_past_expiry:
    "dueAt is after this work would expire: a check-back counts no later than 90 days after the owner's go on the work, so send an instant before that, or finish or hand off the work",
  holds_full:
    "you already hold 20 pieces of work by check-back, the most one agent may: finish, release or hand off one first, or send park false, which sets a reminder and holds nothing",
  check_backs_full:
    "three of your check-backs already wait on this work: leave keepEarlier out, so this one replaces them",
  move_closed:
    "your report was not kept: this move is closed. A move you reported is finished, and one never reported closed failed when your lease ended. plan_move again, then send the report with the move it answers and a new requestId",
  work_blocked:
    "this work waits on other open work, named in its blockedBy: it can be claimed once each of those is closed; take other work from list_opportunities with scope open",
  work_for_other_role:
    "this task is routed to a role you do not hold (its board row's role; yours are roles.mine in list_opportunities with scope board), and only the owner gives roles: take other work from list_opportunities with scope open",
  area_unknown:
    "no area you can use has that key: list_projects answers areas, each one's key; take a key that is not retired, or leave area out",
  not_question_role:
    "only an agent holding the role the owner names for questions relays an answer, and you do not hold it: release the task",
  card_not_routed: "this card is of a kind the owner answers directly, never through an agent: release the task",
  already_relayed: "an answer was relayed on this card already, and a card takes one: there is nothing more to send",
  owner_answered:
    "the owner answered or opened this card on their page, or it no longer waits: their own word stands, so release the task",
  own_card:
    "you raised this card, or what it asks about, and an agent never relays the answer to its own question: release the task, and the owner answers it on their page",
  not_an_option:
    "option must be one of the card's own answers, your brief's relay.options: send the one the owner's words mean",
  owners_card:
    "this box health card is the owner's: it asks for what only they can do (lift a hold, take or test a dump, accept a key change, mend a process or their page's tailnet), or they already deferred it. Leave it: tell the owner what you found",
  came_back_after_seen:
    "an agent marked this condition seen before and it came back without mending, so it is the owner's now: leave it, and tell the owner what you found",
  anchor_taken:
    "an agent's live anchor you can see holds this place for another project: rule the time with rule_time, or leave it to the owner",
  card_closed:
    "this box health card no longer waits: it was marked seen, or what it told of mended. Nothing to do; get_health lists the cards that stand open",
  rate_limited_minute: "wait a minute and retry the same call",
  // The day's window is the last 24 hours, rolling: it comes back as the caller's reads age out of it.
  rate_limited_day:
    "your read budget for the last 24 hours is spent, and it comes back as your reads pass 24 hours old: stop reading and go on with other work, or ask the owner to raise it",
});
