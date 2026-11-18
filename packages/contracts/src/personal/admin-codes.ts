// The admin's refusals (pia and the owner's surface): the code an `AdminError` carries, which is all
// a caller reads of it.
export const ADMIN_CODES = [
  "invalid_registration",
  "duplicate_name",
  "invalid_address",
  "not_found",
  "invalid_argument",
  // A goal's target by a name more than one holds: the owner picks with `pia goal target --entity`.
  "name_held_by_several",
  // A goal's target by a name someone came to hold after the card on it was raised.
  "holders_changed",
  // An owner read while the owner's audience has no built belief: a removal emptied it, or it was
  // never built. The page shows it as rebuilding, as warmth does.
  "rebuilding",
  // The extraction retry and release.
  "confirm_needed",
  "extract_running",
  // The owner surface's: the queue's, then the erasure's.
  "not_pending",
  // A relayed answer the owner's own act on the card came after: never applied.
  "owner_answered",
  // A relayed answer on a card of a kind no longer asked through an agent: never applied.
  "kind_not_relayed",
  "invalid_answer",
  "not_built",
  "not_a_person",
  // The promotion gate's: a claim the gate may not send, a message that is no promotion, and a
  // promotion revoked before.
  "not_promotable",
  "invalid_promotion",
  "promotion_revoked",
  "sync_running",
  "journal_refused",
  "erasure_replay_needed",
  // A client that records needs every key of its label, and the deployment's setting.
  "unknown_compartment",
  "record_disabled",
  // Contacts and identity: the rulings' and the contacts' refusals.
  "conflicting_ruling",
  "shared_address",
  "contacts_connected",
  "already_settled",
  // The owner surface's rest: a ruling already in force, a claim whose type builds no belief, a claim that may
  // not be declassified or already is, and a web page already served on the socket.
  "already_ruled",
  // `pia facts release --plan` whose list is no longer the dry run's.
  "plan_changed",
  "agreement_unmet",
  "not_automatable",
  "no_belief",
  "not_declassifiable",
  "already_declassified",
  // The thresholds and suspensions.
  "out_of_bounds",
  "not_suspended",
  // A restatement mark the owner cleared before.
  "already_cleared",
  // A label on a card the owner has not decided.
  "not_decided",
  // A binding to a person with no account under the item's compartments, and an anchor to a
  // thread of another compartment than its project's.
  "compartment_mismatch",
  // A clearance of more than MAX_COMPARTMENTS.
  "too_many_compartments",
  // A change of a client's compartments that leaves out one it holds.
  "would_narrow",
  // An OAuth registration fingerprint that names no registration held, or more than one.
  "unknown_registration",
  // Research: a link outside the owner's own mail, and a private URL without --private-url.
  "not_permitted",
  // A lesson retired again, or lifted while in force; nothing is written.
  "unchanged",
  // A run of a planner stage the `research_only` planner does not run.
  "research_only",
  "private_url",
  // Lens: a device client is fixed once `pi lens add` made it, and a mirror client is never cleared
  // for a restricted compartment.
  "device_fixed",
  "restricted_not_served",
  // Lens's capture scope: a rule on a multi-account surface with no account, and a bundle rule for
  // a known browser.
  "account_required",
  "browser_bundle",
  // A source rule whose bundle is not its source's app.
  "source_bundle",
  // An agent-app rule that would admit meetings, and a retention class whose expiry is not built.
  "agent_app_meeting",
  "not_supported",
  // Device anchors: a value that does not parse, one too common to anchor, a key another active
  // project holds, and a meeting with no series.
  "bad_anchor",
  "bad_range",
  "no_block",
  "generic_anchor",
  "anchor_taken",
  "no_series",
  // Lens: a person's erasure that the captures hook could not finish, a capture item's key being
  // absent from the key file.
  "keys_missing",
  // A join of two keys not of one subject, kind and domain.
  "not_one_fact",
  // A fact settlement the owner already reopened.
  "already_reopened",
  // A default task role no active agent holds.
  "unknown_role",
  // An owner's close dated at or before the commitment's latest statement, and a reopen of a
  // commitment no close of which is in force.
  "at_predates",
  "not_closed",
  // An account the map and a scope rule would give two compartments, either way round; `rules`
  // names the rules.
  "rule_conflict",
  // A withdrawal of a task an agent has claimed.
  "already_claimed",
] as const;
export type AdminCode = (typeof ADMIN_CODES)[number];
