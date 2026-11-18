// The command table's rows for what the owner rules on: cards and vetoes, erasure and retention,
// identity, people and organizations, facts and corrections, commitments, research, declassification
// and promotion.

import { PROMOTION_MOST_CLAIMS } from "@intelligence/contracts/personal";
import { checkPeopleTier, checkPeopleTiers, checkSelfReview, FACTS } from "./command-args.ts";
import {
  admin,
  commitments,
  declassification,
  erasure,
  exposures,
  flag,
  identity,
  KEY_FILE,
  notes,
  org,
  owner,
  ownerLists,
  promotion,
  queue,
  research,
  retain,
  rulings,
  text,
  WRITER_URL,
} from "./command-kit.ts";
import type { Rows } from "./command-types.ts";

// A retention class not built.
const RETAIN_HINTS = {
  not_supported: "only capture_moment, capture_block and capture_transcript have retention so far",
};

export const PEOPLE_AND_LISTS: Rows = {
  // The owner's whole view by warmth tier, and one person's stored warmth row.
  "people tiers": {
    ...admin,
    terminalOnly: true,
    args: "[--tier T] [--dormant] [--limit N] | --ruled",
    options: { tier: text, dormant: flag, limit: text, ruled: flag },
    check: checkPeopleTiers,
    body: owner("peopleTiers"),
  },
  // The owner's tier for a person, or its lift.
  "people tier": {
    ...admin,
    args: "ID|ADDRESS (TIER | --clear)",
    options: { clear: flag },
    positionals: [1, 2],
    check: checkPeopleTier,
    body: owner("peopleTier"),
  },
  "people warmth": { ...admin, terminalOnly: true, args: "ID|ADDRESS", positionals: 1, body: owner("peopleWarmth") },
  // The owner's lists of people. A name is read
  // from stdin, and printed by `lists` alone, to a terminal only.
  lists: { ...admin, terminalOnly: true, body: ownerLists("lists") },
  "lists create": { ...admin, args: "(the name on stdin)", body: ownerLists("listsCreate") },
  "lists rename": { ...admin, args: "LIST (the name on stdin)", positionals: 1, body: ownerLists("listsRename") },
  "lists delete": { ...admin, args: "LIST", positionals: 1, body: ownerLists("listsDelete") },
  "lists add": { ...admin, args: "LIST ID|ADDRESS", positionals: 2, body: ownerLists("listsAdd") },
  "lists remove": { ...admin, args: "LIST ID|ADDRESS", positionals: 2, body: ownerLists("listsRemove") },
};

export const REVIEW_AND_IDENTITY: Rows = {
  review: {
    ...admin,
    terminalOnly: true,
    args: "[--kind K] [--limit N]",
    options: { kind: text, limit: text },
    body: queue("review"),
  },
  show: { ...admin, terminalOnly: true, args: "CARD", positionals: 1, body: queue("show") },
  decide: {
    ...admin,
    // --reason, the owner's decline reason on a no.
    // --compartment, where an accepted goal proposal's goal is sealed.
    args: "CARD... --answer A [--labels L,...] [--note TEXT] [--reason R] [--compartment C]",
    options: { answer: text, labels: text, note: text, reason: text, compartment: text },
    positionals: Array.from({ length: 25 }, (_, n) => n + 1),
    body: queue("decide"),
  },
  // The owner's reopen of a fact settlement, of a card the policy expired, or of one a relayed
  // answer decided.
  "cards reopen": { ...admin, args: "SETTLEMENT|CARD", positionals: 1, body: queue("cardsReopen") },
  // The answers agents relayed, and this week's sample with the
  // owner's words as quoted, to a terminal only.
  "cards relayed": {
    ...admin,
    terminalOnly: true,
    args: "[--sample]",
    options: { sample: flag },
    body: queue("cardsRelayed"),
  },
  // the cards agents settled, this week's sample, and the owner's mark on one.
  "cards settled": {
    ...admin,
    terminalOnly: true,
    args: "[--sample]",
    options: { sample: flag },
    body: queue("cardsSettled"),
  },
  "cards mark": { ...admin, args: "CARD right|wrong", positionals: 2, body: queue("cardsMark") },
  "veto add": {
    ...admin,
    args: "[--entity ID] [--kind K]",
    options: { entity: text, kind: text },
    body: queue("vetoAdd"),
  },
  "veto list": { ...admin, body: queue("vetoList") },
  "veto lift": { ...admin, args: "ID", positionals: 1, body: queue("vetoLift") },
  "erase item": {
    ...admin,
    args: "ID [--dry-run]",
    options: { "dry-run": flag },
    positionals: 1,
    body: erasure("eraseItem"),
  },
  "erase person": {
    ...admin,
    args: "ID [--dry-run]",
    options: { "dry-run": flag },
    positionals: 1,
    body: erasure("erasePerson"),
  },
  "erase list": { ...admin, body: erasure("eraseList") },
  "erase lift": { ...admin, args: "ID", positionals: 1, body: erasure("eraseLift") },
  "erase replay": { ...admin, body: erasure("eraseReplay") },
  // Lens: the forgets from a Mac, each applied as an erasure of kind
  // device_forget. The box's timer runs it after every `pi sync`.
  "erase settle": { ...admin, args: "[--limit N]", options: { limit: text }, body: erasure("eraseSettle") },
  // What an erasure's items were given, and to whom; and the last 30 days, by recipient
  //. Names only on a terminal.
  "erase exposures": { ...admin, args: "ID", positionals: 1, body: exposures("eraseExposures") },
  "exposures status": { ...admin, body: exposures("exposuresStatus") },
  // Retention for Lens's capture classes: the owner's retention rules, and their run.
  "retain set": {
    hints: RETAIN_HINTS,
    ...admin,
    args: "CLASS (--days N | --keep) [--account ACC]",
    options: { days: text, keep: flag, account: text },
    positionals: 1,
    body: retain("retainSet"),
  },
  "retain adopt": { ...admin, body: retain("retainAdopt") },
  "retain list": { ...admin, body: retain("retainList") },
  "retain plan": { ...admin, body: retain("retainPlan") },
  "retain run": { ...admin, body: retain("retainRun") },
  // Contacts and identity ("Commands"): ids only, never an address.
  "identity link": { ...admin, args: "ENT ENT", positionals: 2, body: identity("identityLink") },
  "identity differ": { ...admin, args: "ENT ENT", positionals: 2, body: identity("identityDiffer") },
  "identity share": { ...admin, args: "ENT", positionals: 1, body: identity("identityShare") },
  "identity list": { ...admin, body: identity("identityList") },
  "identity lift": { ...admin, args: "RULING", positionals: 1, body: identity("identityLift") },
  "identity sweep": { ...admin, args: "[--dry-run]", options: { "dry-run": flag }, body: identity("identitySweep") },
  "identity dream-merges": {
    ...admin,
    scriptReads: "the timer reads its exit status alone",
    body: identity("identityDreamMerges"),
  },
  // The live joins that rest on little.
  "identity thin": { ...admin, body: identity("identityThin") },
  // The owner's switch for agents answering same-person pairs, and their answers listed.
  "identity agents": { ...admin, args: "[on|off]", positionals: [0, 1], body: identity("identityAgents") },
  // Rules proposed from the owner's own answers.
  "rules list": { ...admin, body: identity("rulesList") },
  "rules lift": { ...admin, args: "RULE", positionals: 1, body: identity("rulesLift") },
  // The owner's switch for automatic merges, and the policy's merges listed.
  "identity merges": {
    ...admin,
    args: "on|off | --auto [--lifted]",
    options: { auto: flag, lifted: flag },
    positionals: [0, 1],
    body: identity("identityMerges"),
  },
  // The owner's role and person marks, the reclassification of stored accounts,
  // and the ignore list. A mark or an ignore may name an address or a domain.
  "identity role": { ...admin, args: "ENT|ADDRESS", positionals: 1, body: identity("identityRole") },
  "identity person": { ...admin, args: "ENT|ADDRESS", positionals: 1, body: identity("identityPerson") },
  "identity reclassify": {
    ...admin,
    args: "[--dry-run]",
    options: { "dry-run": flag },
    body: identity("identityReclassify"),
  },
  "ignore add": { ...admin, args: "account|entity|domain VALUE", positionals: 2, body: identity("ignoreAdd") },
  "ignore list": { ...admin, body: identity("ignoreList") },
  "ignore lift": { ...admin, args: "RULING", positionals: 1, body: identity("ignoreLift") },
};

export const LOCAL_NAMES: Rows = {
  // Every contact's claims made again at the current contact-claims
  // version, as the writer: run it as `pi-sync contacts reclaim`.
  // The local-part name fingerprints of every account that has none, as the writer: run it as
  // `pi-sync identity local-names-backfill`.
  "identity local-names-backfill": {
    role: "writer",
    requires: [WRITER_URL, KEY_FILE],
    body: identity("identityLocalNamesBackfill"),
  },
};

export const BINDINGS_AND_NAMES: Rows = {
  // The filed name mentions, the owner's binding of one, its lift, and the
  // refile of what was committed before. Names only on a terminal.
  "identity mentions": {
    ...admin,
    args: "[--limit N | --summary]",
    options: { limit: text, summary: flag },
    body: identity("identityMentions"),
  },
  "identity bind": { ...admin, args: "MENTION ENT", positionals: 2, body: identity("identityBind") },
  "identity unbind": { ...admin, args: "BINDING", positionals: 1, body: identity("identityUnbind") },
  // The bindings the sync made for meetings' participants, to lift one.
  "identity bindings": { ...admin, args: "[--limit N]", options: { limit: text }, body: identity("identityBindings") },
  "identity refile": { ...admin, body: identity("identityRefile") },
  // Organizations: the owner's name for one, and the
  // refold of those minted from subdomains, which re-derives and so runs as the writer.
  "org name": { ...admin, args: "ORG NAME", positionals: 2, body: org("orgName") },
  // The owner's name for a person, its clear, and the Undo of either.
  "person name": {
    ...admin,
    args: "PERSON (NAME | --clear)",
    options: { clear: flag },
    positionals: [1, 2],
    body: org("personName"),
  },
  "person name lift": { ...admin, args: "RULING", positionals: 1, body: org("personNameLift") },
  "org refold": {
    role: "writer",
    requires: [WRITER_URL, KEY_FILE],
    args: "[--dry-run]",
    options: { "dry-run": flag },
    body: org("orgRefold"),
  },
};

export const FACTS_AND_RULINGS: Rows = {
  // Corrections and fact vetoes, declassification, the digest and the web page.
  // `facts show` and `web link` print to a terminal only.
  "facts show": { ...admin, terminalOnly: true, args: "FACT", positionals: 1, body: rulings("factsShow") },
  // The owner's correction of a fact's life domain or kind; `correct lift` lifts it.
  "facts domain": { ...admin, args: "FACT DOMAIN", positionals: 2, body: rulings("factsDomain") },
  "facts kind": { ...admin, args: "FACT KIND", positionals: 2, body: rulings("factsKind") },
  // The owner's join and split of two facts, their list and lift, grouping's
  // mode and its shadow report.
  "facts join": { ...admin, args: "FACT FACT", positionals: 2, body: rulings("factsJoin") },
  "facts split": { ...admin, args: "FACT FACT", positionals: 2, body: rulings("factsSplit") },
  "facts rulings": { ...admin, body: rulings("factsRulings") },
  "facts lift": { ...admin, args: "RULING", positionals: 1, body: rulings("factsLift") },
  "facts grouping": { ...admin, args: "off|shadow|apply", positionals: 1, body: rulings("factsGrouping") },
  "facts groupings": { ...admin, body: rulings("factsGroupings") },
  // The owner's release of what they confirmed before a confirm released it.
  "facts release": {
    ...admin,
    args: "--dry-run | --plan HASH",
    options: { "dry-run": flag, plan: text },
    body: rulings("factsRelease"),
  },
  // The cleanup of what the store holds about the owner: a dry run, then the owner's apply of exactly its
  // plan. It prints the facts' text, so to a terminal alone.
  "facts clean": {
    ...admin,
    terminalOnly: true,
    args: "[--apply --plan HASH] [--fact-kinds LANES]",
    options: { apply: flag, plan: text, "fact-kinds": text },
    body: rulings("factsClean"),
  },
  // The owner's standing release of an agent's quoted facts of one kind, its lift and list.
  "facts grant": { ...admin, args: "AGENT KIND", positionals: 2, body: rulings("factsGrant") },
  "facts grant-lift": { ...admin, args: "AGENT KIND", positionals: 2, body: rulings("factsGrantLift") },
  "facts grants": { ...admin, body: rulings("factsGrants") },
  // The owner's switch for learning from one agent's proposals, and the confirm rates.
  "facts learning": { ...admin, args: "AGENT on|off", positionals: 2, body: rulings("factsLearning") },
  "facts rates": { ...admin, body: rulings("factsRates") },
  "correct reject": { ...admin, args: "FACT...", positionals: FACTS, body: rulings("correctReject") },
  "correct veto": { ...admin, args: "FACT", positionals: 1, body: rulings("correctVeto") },
  "correct list": { ...admin, body: rulings("correctList") },
  "correct lift": { ...admin, args: "RULING", positionals: 1, body: rulings("correctLift") },
  // A correction with the true value, the owner's value on stdin.
  "correct value": {
    ...admin,
    args: "FACT FIELD [NAME=VALUE ...] < VALUE",
    positionals: [2, 3, 4],
    body: notes("correctValue"),
  },
  // The owner's review of what the store holds about them, and a fact retired.
  "self review": {
    ...admin,
    terminalOnly: true,
    args: "[--kind K] [--status S]",
    options: { kind: text, status: text },
    check: checkSelfReview,
    body: rulings("selfReview"),
  },
  "self retire": { ...admin, args: "FACT...", positionals: FACTS, body: rulings("selfRetire") },
  // The owner's commitments, their close and reopen, the closes, and their standing release.
  "commitments list": {
    ...admin,
    terminalOnly: true,
    args: "[--open]",
    options: { open: flag },
    body: commitments("commitmentsList"),
  },
  "commitments close": {
    ...admin,
    args: "FACT --done|--cancelled|--released [--at TIME]",
    options: { done: flag, cancelled: flag, released: flag, at: text },
    positionals: 1,
    body: commitments("commitmentsClose"),
  },
  // What the owner owes and what is overdue; their Done or Drop on an item that is no commitment.
  "open-items list": { ...admin, terminalOnly: true, body: commitments("openItemsList") },
  "open-items close": {
    ...admin,
    args: "next_step|plan|calendar KEY --done|--dropped",
    options: { done: flag, dropped: flag },
    positionals: 2,
    body: commitments("openItemsClose"),
  },
  "open-items reopen": { ...admin, args: "KEY", positionals: 1, body: commitments("openItemsReopen") },
  "commitments reopen": { ...admin, args: "FACT", positionals: 1, body: commitments("commitmentsReopen") },
  "commitments closed": {
    ...admin,
    terminalOnly: true,
    args: "[--by-agents] [--since DATE]",
    options: { "by-agents": flag, since: text },
    body: commitments("commitmentsClosed"),
  },
  "commitments agent-closes": { ...admin, args: "on|off", positionals: 1, body: commitments("commitmentsAgentCloses") },
  "research landed": {
    ...admin,
    terminalOnly: true,
    args: "[--since DATE]",
    options: { since: text },
    body: research("researchLanded"),
  },
  "research lift": { ...admin, args: "REC", positionals: 1, body: research("researchLift") },
  "declassify add": { ...admin, args: "FACT", positionals: 1, body: declassification("declassifyAdd") },
  "declassify list": { ...admin, body: declassification("declassifyList") },
  "declassify revoke": { ...admin, args: "RULING", positionals: 1, body: declassification("declassifyRevoke") },
  // The promotion gate: the owner's claims, approved by id, as one bundle to carry to a receiving
  // instance; its revoke and what follows; and, on the receiving instance, the intake.
  "promotion add": {
    ...admin,
    args: "CLAIM [CLAIM...]",
    positionals: Array.from({ length: PROMOTION_MOST_CLAIMS }, (_, index) => index + 1),
    body: promotion("promotionAdd"),
  },
  "promotion list": { ...admin, body: promotion("promotionList") },
  "promotion revoke": { ...admin, args: "PROMOTION", positionals: 1, body: promotion("promotionRevoke") },
  "promotion outbox": { ...admin, body: promotion("promotionOutbox") },
  "promotion take": {
    ...admin,
    args: "[--compartment C] < MESSAGES",
    options: { compartment: text },
    body: promotion("promotionTake"),
  },
};
