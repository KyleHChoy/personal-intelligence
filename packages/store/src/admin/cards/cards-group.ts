import type { AdminContext } from "../../core/admin-context.ts";
import { bound, boundTx } from "../admin-bound.ts";
import * as settled from "./admin-agent-settled.ts";
import * as calibration from "./admin-calibration.ts";
import { digest } from "./admin-digest.ts";
import * as learning from "./admin-learning.ts";
import * as queue from "./admin-queue.ts";
import * as relays from "./admin-relays.ts";
import { ownerReopenCard } from "./admin-reopen.ts";
import * as ownerResults from "./admin-results.ts";

// The decide model's calibration, as `Admin.calibration`.
export const calibrationAdmin = (context: AdminContext) =>
  bound(context, {
    recordVerdict: calibration.recordVerdict,
    reviewSample: calibration.reviewSample,
    sameInput: calibration.sameInput,
    openForReview: calibration.openForReview,
    pointsWithVerdicts: calibration.pointsWithVerdicts,
    countedVerdicts: calibration.countedVerdicts,
    writeReport: calibration.writeReport,
    writeProposal: calibration.writeProposal,
    grantedDisagreement: calibration.grantedDisagreement,
    suspend: calibration.suspend,
    resume: calibration.resume,
    raiseDrift: calibration.raiseDrift,
    grants: calibration.grants,
    grantProposal: calibration.grantProposal,
    setThreshold: calibration.setThreshold,
    revokeThreshold: calibration.revokeThreshold,
    setTarget: calibration.setTarget,
    targetOf: calibration.targetOf,
    suspensions: calibration.suspensions,
    releaseRecord: calibration.releaseRecord,
    decisionCalls: calibration.decisionCalls,
  });
export type CalibrationAdmin = ReturnType<typeof calibrationAdmin>;

// The queue: cards, decisions, vetoes and the results of agent work (admin-queue.ts,
// admin-results.ts), and the digest of what waits for the owner (admin-digest.ts), as `Admin.cards`.
export const cardsAdmin = (context: AdminContext) => ({
  ...bound(context, {
    raiseCard: queue.raiseCard,
    // `pi web` runs it on a timer.
    sweepNameHolds: queue.sweepNameHolds,
    judgeResult: ownerResults.judgeResult,
    // The owner's Done or Drop on work handed to them, from the work's row.
    decideHanded: queue.decideHanded,
    addVeto: queue.addVeto,
    listVetoes: queue.listVetoes,
    liftVeto: queue.liftVeto,
    // What waits for the owner, as counts only (admin-digest.ts): cards by kind, held mail and
    // withheld items.
    digest: digest,
    listPending: queue.listPending,
    // With `view`, the read that shows the card to the owner also writes its view.
    card: queue.card,
    withLines: queue.cardsWithLines,
    results: ownerResults.results,
    openResult: ownerResults.openResult,
    decide: queue.decide,
    applyRelays: relays.applyRelays,
    listRelays: relays.listRelays,
    // the cards agents settled, and the week's sample the owner marks.
    listSettled: settled.listSettled,
  }),
  // A card the policy expired, or one a relayed answer decided, back in the queue.
  ...boundTx(context, {
    reopenExpiredCard: ownerReopenCard,
    reopenRelayed: relays.reopenRelayed,
    markSettled: settled.markSettled,
  }),
});

// The owner's commands and reads of learning and evaluation (admin-learning.ts), as `Admin.learning`.
export const learningAdmin = (context: AdminContext) =>
  bound(context, {
    markViewed: learning.markViewed,
    labelCard: learning.labelCard,
    drawSilences: learning.drawSilences,
    pendingSilences: learning.pendingSilences,
    recordSilenceVerdict: learning.recordSilenceVerdict,
  });
