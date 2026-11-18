import type pg from "pg";
import type { AdminContext } from "../../core/admin-context.ts";
import { type DreamMergeCounts, settleDreamMergesLocked } from "../../identity/dream-merges.ts";
import {
  dryRunIdentity,
  type IdentityDecideModel,
  proposeIdentity,
  type SweepCounts,
} from "../../identity/identity-sweep.ts";
import * as gate from "../../promotion/promotion-gate.ts";
import * as intake from "../../promotion/promotion-intake.ts";
import { bound, boundQuery, boundTx } from "../admin-bound.ts";
import * as rates from "../cards/admin-confirm-rates.ts";
import { learnAfterNotTrue } from "../cards/admin-confirm-rates.ts";
import * as history from "../history/admin-history.ts";
import { listImports, removeImport } from "../people/admin-imports.ts";
import * as clean from "./admin-clean.ts";
import * as declassified from "./admin-declassify.ts";
import * as factRulings from "./admin-fact-rulings.ts";
import { factViews } from "./admin-fact-views.ts";
import * as grants from "./admin-grants.ts";
import * as identity from "./admin-identity.ts";
import * as ignore from "./admin-ignore.ts";
import * as organizations from "./admin-organizations.ts";
import * as personNames from "./admin-person-names.ts";
import * as releases from "./admin-release.ts";
import * as rulings from "./admin-rulings.ts";

// Facts and the owner's rulings on them: a fact's view, vetoes and retirements, joins and splits,
// grouping and history (admin-rulings.ts, admin-fact-rulings.ts, admin-history.ts), as
// `Admin.facts`.
export const factsAdmin = (context: AdminContext) => ({
  ...bound(context, {
    show: rulings.factShow,
    // Several claims as factShow renders each, in one transaction; one not held is left out.
    views: factViews,
    vetoFact: rulings.vetoFact,
    // `pi self retire`, true until the fact is stated again.
    retireFact: rulings.retireFact,
    beliefsAsOf: history.beliefsAsOf,
    learnedSince: history.learnedSince,
    reclassifyFact: rulings.reclassifyFact,
    listRulings: rulings.listRulings,
    joinFacts: factRulings.joinFacts,
    splitFacts: factRulings.splitFacts,
    listFactRulings: factRulings.listFactRulings,
    // The latest claim of each fact key, by id: what the page's Settings names a join or split by.
    latestClaims: factRulings.latestClaims,
    liftFactRuling: factRulings.liftFactRuling,
    setGroupingMode: factRulings.setGroupingMode,
    groupingReport: factRulings.groupingReport,
    liftRuling: rulings.liftRuling,
    rejectClaim: rulings.rejectClaim,
    learnAfterNotTrue: learnAfterNotTrue,
    // `pia facts clean`, its dry run and the owner's apply of exactly its plan (admin-clean.ts).
    cleanFacts: clean.cleanFacts,
  }),
  ...boundQuery(context, {
    reopenSettlement: factRulings.reopenFactSettlement,
    relationOverride: factRulings.relationOverride,
  }),
  ...boundTx(context, { convertGroupings: factRulings.convertGroupings }),
});

// Who is the same person: identity rulings, addresses, imports and the names the owner gives
// (admin-identity.ts, admin-imports.ts, admin-person-names.ts, admin-organizations.ts), as
// `Admin.identity`.
export function identityAdmin(context: AdminContext, pool: pg.Pool) {
  return {
    ...bound(context, {
      // Contacts and identity: the owner's rulings, in admin-identity.ts, and the sweep, in
      // identity-sweep.ts.
      linkPeople: identity.linkPeople,
      markShared: identity.markShared,
      liftIdentity: identity.liftIdentity,
      setIdentityAgents: identity.setIdentityAgents,
      listIdentityAnswers: identity.listIdentityAnswers,
      listQuestionRules: identity.listQuestionRules,
      liftQuestionRule: identity.liftQuestionRule,
      listThinMerges: identity.listThinMerges,
      // The owner's switch for automatic merges, the sweep's dry run, and their reopen of
      // a fact settlement.
      setIdentityMerges: identity.setIdentityMerges,
      dryRunIdentity: dryRunIdentity,
      // The owner's role and person marks, the reclassification of stored accounts, and
      // the ignore list, in admin-identity.ts and admin-ignore.ts.
      markAddress: identity.markAddress,
      reclassifyAccounts: identity.reclassifyAccounts,
      // The owner's name for an organization, in admin-organizations.ts.
      nameOrganization: organizations.nameOrganization,
      // The owner's name for a person, null to clear it, and the Undo of either, in
      // admin-person-names.ts.
      namePerson: personNames.namePerson,
      liftPersonName: personNames.liftPersonName,
      removeContacts: identity.removeContacts,
      // Contact import, in admin-imports.ts.
      listImports: listImports,
      removeImport: removeImport,
      listIdentity: identity.listIdentity,
    }),
    proposeIdentity(options: {
      now: Date;
      decideModel?: IdentityDecideModel;
      clock?: () => number;
    }): Promise<SweepCounts> {
      return proposeIdentity(context, pool, options);
    },
    // The dream candidates alone, as the timer runs it after each dream pass.
    dreamMerges(): Promise<DreamMergeCounts> {
      return settleDreamMergesLocked(context, pool);
    },
  };
}

// What the owner ignores (admin-ignore.ts), as `Admin.ignores`.
export const ignoresAdmin = (context: AdminContext) =>
  bound(context, {
    addIgnore: ignore.addIgnore,
    listIgnore: ignore.listIgnore,
    // The page's Settings: whom each ignore ruling covers, by name.
    ignoredWho: ignore.ignoredWho,
    liftIgnore: ignore.liftIgnore,
  });

// Releases, standing grants and declassification (admin-release.ts, admin-grants.ts,
// admin-declassify.ts), as `Admin.releases`.
export const releasesAdmin = (context: AdminContext) =>
  bound(context, {
    // `pia facts release --dry-run | --plan HASH`, the owner's release of what they
    // confirmed or answered before a confirm released it, exactly the dry run's list. Counts and ids.
    confirmed: releases.releaseConfirmed,
    // `pia facts grant AGENT KIND`, the owner's standing release of an agent's quoted
    // facts of one kind; `pia facts grant-lift AGENT KIND`, its lift, ending every release made under
    // it; and Settings' read of each grant with its counts.
    grantRelease: grants.grantRelease,
    liftReleaseGrant: grants.liftReleaseGrant,
    grants: grants.releaseGrants,
    // Settings' confirm rates by agent and kind, and the owner's switch for learning from one agent
    // (`pia facts learning AGENT on|off`).
    confirmRates: rates.confirmRates,
    setLearning: rates.setLearning,
    declassify: declassified.declassify,
    listDeclassified: declassified.listDeclassified,
    revokeDeclassified: declassified.revokeDeclassified,
  });

// The promotion gate and its intake (promotion-gate.ts, promotion-intake.ts), as `Admin.promotions`:
// the owner's promotions sent, their revokes and outbox, and a message taken from another instance.
export const promotionsAdmin = (context: AdminContext) =>
  bound(context, {
    promote: gate.promote,
    revoke: gate.revoke,
    list: gate.listPromotions,
    outbox: gate.outbox,
    take: intake.take,
  });
