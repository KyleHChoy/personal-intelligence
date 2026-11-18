import { type GapTrigger, OutcomeRules } from "@intelligence/contracts/personal";
import { repoFile } from "@intelligence/personal-core";

// The outcome table, `ontology/outcomes.json`: what each kind of work expects by default.
export const outcomeRules = repoFile("ontology/outcomes.json", (text) => OutcomeRules.parse(JSON.parse(text)));

// What code-raised work expects, by what raised it: `ontology/outcomes.json`'s gapTriggers, or none
// for a trigger whose work comes back as knowledge, not as anything the world does.
export const gapExpectation = (trigger: GapTrigger, table: OutcomeRules = outcomeRules()) => table.gapTriggers[trigger];
