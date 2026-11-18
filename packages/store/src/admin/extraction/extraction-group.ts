import type { AdminContext } from "../../core/admin-context.ts";
import { carryGate } from "../../pipeline/carry-gate.ts";
import { bound, boundQuery, boundTx } from "../admin-bound.ts";
import { anchorRulings } from "../rulings/ruling-anchors.ts";
import {
  dreamFindings,
  dreamLinesView,
  dreamNights,
  dreamSample,
  dreamTrial,
  liftSettlement,
  markDreamCheck,
  setDreamLine,
  setDreamModel,
} from "./admin-dream.ts";
import { itemView, releaseItem, replayRefused, reroute, retry } from "./admin-extraction.ts";
import { importReview, recordReview, reviewSample } from "./admin-extraction-review.ts";
import { extractionStatus } from "./admin-extraction-status.ts";
import * as mentions from "./admin-mentions.ts";
import { carryOver, valueFpBackfill } from "./admin-query-time.ts";
import { reattach } from "./admin-reattach.ts";

// Extraction's owner commands: status, review, retries, routes, releases and the carry-over of
// values and rulings (admin-extraction*.ts, admin-query-time.ts, admin-reattach.ts), as
// `Admin.extraction`.
export const extractionAdmin = (context: AdminContext) => ({
  ...bound(context, {
    valueFpBackfill: valueFpBackfill,
    // `pia extract carry-over --reattach`, each unfound ruling re-attached by
    // code, found gone, asked about or skipped, each in its own transaction. Counts only.
    reattachRulings: reattach,
    // `pia extract carry-over --anchor`, each ruling in force without its anchors given them from the
    // claims its key still names. Counts only.
    anchorRulings: anchorRulings,
  }),
  // `pia extract carry-over`, the rulings and owner-judged relations no claim of `generation` or later finds.
  // `--gate`: what the generation would do to the rulings in force, and whether the gate refuses it.
  ...boundQuery(context, {
    carryOver: carryOver,
    carryGate: carryGate,
    // The owner's lines, the owner's marks on the week's sample, the owner's lift of an agent's
    // settlement, and the trial nights (admin-dream.ts).
    setDreamLine,
    setDreamModel,
    dreamLines: dreamLinesView,
    markDreamCheck,
    liftSettlement,
    dreamNights,
    dreamTrial,
  }),
  dreamSample: () => context.transaction((query) => dreamSample(query, context.now(), context.keys)),
  // `pia dream findings`: AdminError "invalid_argument" for a kind no relation has or a limit out of range.
  dreamFindings: (options: Parameters<typeof dreamFindings>[2]) =>
    context.transaction((query) => dreamFindings(query, context.keys, options)),
  ...boundTx(context, {
    // `generation` is the extractor's, for the count of what is due.
    status: extractionStatus,
    reviewSample: reviewSample,
    // Throws AdminError "extract_running" while a run holds the extract lock, and whatever `check`
    // throws; either way nothing is written.
    importReview: importReview,
    recordReview: recordReview,
    // Throws AdminError "extract_running" while a run holds the extract lock, "confirm_needed" with the count for more
    // than fifty items by status or for all, and for any retry that keeps its answers unconfirmed with what it would
    // pay, and "not_found" for a message id that names no message. Nothing is changed by a refusal.
    retry: retry,
    // `pia extract reroute`. Throws AdminError "extract_running" while a run holds the
    // extract lock, unless `dryRun`, which writes nothing. Counts only.
    reroute: reroute,
    // `pia extract replay-refused`. Throws AdminError "extract_running" while a run holds the
    // extract lock. Counts only.
    replayRefused: replayRefused,
    // `pia extract item --message ID`, ids, codes and counts; null for no such message.
    extractItem: itemView,
    // Throws AdminError "extract_running", or "not_found" for an id that names no message or an item
    // that is not withheld.
    release: releaseItem,
  }),
});

// Mentions and their bindings (admin-mentions.ts), as `Admin.mentions`.
export const mentionsAdmin = (context: AdminContext) =>
  bound(context, {
    // The filed rows counted by type, field, has_speaker and first_hand.
    summarizeMentions: mentions.summarizeMentions,
    // The last three throw AdminError "extract_running" while a run holds the extract lock.
    listMentions: mentions.listMentions,
    bindMention: mentions.bindMention,
    // The sync's code bindings in force.
    listCodeBindings: mentions.listCodeBindings,
    unbindMention: mentions.unbindMention,
    refileMentions: mentions.refileMentions,
  });
