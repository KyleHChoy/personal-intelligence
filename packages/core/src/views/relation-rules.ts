import { RelationRules } from "@intelligence/contracts/personal";
import { repoFile } from "../repo-root.ts";

// The relation rule table, `ontology/relations.json`, parsed once: the switch's thresholds, the
// evidence order and its margins, and the relation step's budget. Every value provisional, the same
// for every deployment.

export const relationRules: () => RelationRules = repoFile("ontology/relations.json", (text) =>
  RelationRules.parse(JSON.parse(text)),
);
