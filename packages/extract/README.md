# @intelligence/personal-extract

Extraction for Personal Intelligence. It triages each stored item by rules, asks a model for its claims through the shared replay (one call per item; a document, a meeting or a group of moments is split into at most a fixed number of requests), checks every candidate in code, and rebuilds the commitment beliefs, once per audience. A model proposes; code decides every subject kind, time, speaker, compartment, reader, fact key and id.

Each prompt's versions are rows in `lane-versions.ts`; what each version changed is in `prompts.ts` and its siblings, not here.

- **May import:** `@intelligence/contracts`, `@intelligence/personal-core`, `@intelligence/personal-models` and `@intelligence/personal-beliefs` (the belief rules, grounding, fact keys, the ontology and tiers; this package re-exports their names). In its tests also `@intelligence/personal-models/testing`.
- **Runs with:** no credentials. It is handed a `PersonalPipelineStore`, a `ModelClient`, a `PersonalLogger` and a clock. Which model reads an item, and which lanes are on, are the deployment's configuration: `pi extract` reads them from its environment (`PI_EXTRACT_MODEL` and the other `PI_EXTRACT_*` settings, `apps/pi/README.md`) and passes them in `ExtractDeps`.
- **Must never:** let model output set a subject kind, a time, a speaker, a context, a compartment, a reader, a lane, a fact key, a disclosure class or an id; call a model with tools; keep a text value that is not a slice of the passage it cites; write a belief except from `buildBelief`; create a person or an organization; follow anything a message or a model output says; log claim text, a name or an address.

## Two models by role

Code and configuration name the two models Jev, the rung 1 model, and Luna, the rung 2 model.

- **The extraction model** (Luna) reads an item and writes its claims. Which one is configuration.
- **The screening model** (Jev, the decide model, rung 1: `DECIDE_SCREEN`, `DECIDE_RECOVERY`, `DECIDE_RECORD`) answers fixed questions with a probability. When `ExtractDeps.decideModel` is set it runs before extraction and may withhold an item (`quarantine`, `sensitive`), holds account-recovery mail, and screens an agent's finding for instructions. With no `decideModel`, every item takes the plain path. Screening raises no generation, so no claim id changes.

`exposing(client, store, modelId)` wraps a vendor client so each request's item is noted in the vendor exposure record, committed, before the request leaves; `pi extract` wraps both clients with it, innermost.

## Files

| File | What |
| --- | --- |
| `run.ts` | `runExtraction`: one run over the due items, under the extract lock (`already_running` when it is held); the relation step after the rebuild and before the trigger pass |
| `triage.ts` | Triage by rules for mail, documents, meetings and moments |
| `process-item.ts`, `process-item-steps.ts` | One email item: screen, ask, check, commit |
| `lane-versions.ts` | One row for each version of each lane's prompt: its types, its place in its lane's history, its rules. The version tables, the decision point's pins and the check's rules by version are read from it |
| `asked-version.ts` | Which version an item gets, for every lane, the retry and the refusal report |
| `lane-check.ts`, `capture-check.ts` | The one check of an answer, for lanes, trials and evaluations; what the two capture lanes share |
| `prompts.ts`, `message-prompts.ts`, `meeting-prompts.ts`, `moment-prompts.ts`, `question-prompts.ts`, `prompt-preamble.ts` | The prompts and their versions (`EXTRACT_PROMPTS`); the screening, relation and source-check questions; the lines and example spans they share |
| `check.ts` | The personal checks over the shared checker (`personalCheck`) |
| `refused.ts`, `reask-prompt.ts`, `refusals.ts` | A refused candidate's detail, the one re-ask and its prompts, and `pi extract refusals` |
| `screen.ts`, `recovery.ts`, `fit.ts`, `backlog.ts`, `decide-call.ts` | The screening model's calls, slots and backlog passes |
| `documents.ts` | The document lane (`processDocument`, `planDocument`) |
| `meetings.ts`, `meeting-plan.ts`, `meeting-identity.ts`, `meeting-check.ts`, `turns.ts` | The meeting lane: plan, speaker identity and credit, checks, turn repair |
| `moments.ts`, `moments-plan.ts`, `moments-check.ts` | The moment lane |
| `relations.ts`, `source-check.ts` | The relation step and the nightly source check |
| `restatement.ts`, `same-fact.ts` | Whether a claim restates one already held |
| `exposing.ts` | The vendor exposure wrapper |
| `activity.ts`, `link.ts`, `project-named.ts`, `phrase-words.ts`, `common-words.ts` | The Lens lane's code-only steps: the owner's activity facts, a meeting or moment's project link, and which project a message is in |
| `own-lines.ts`, `own-lines-prompt.ts`, `own-lines-trial.ts`, `own-word.ts` | The own-lines lane: which agent-app moments it asks, its prompt, its trial and the owner's word |
| `proposal.ts`, `person-proposal.ts`, `time-proposal.ts`, `fill.ts`, `close.ts`, `owner-quoted.ts`, `standalone.ts`, `code-claim.ts` | Claims built by code from an agent's record: proposals, a person, a time proposal, an explore fill, a commitment's close, the checks of a quoted proposal, and the one builder of a claim code makes |
| `outcome-judge.ts`, `recall-audit.ts` | The outcome judge inside the relation step; the recall audit of what the closed filters drop |
| `interpret.ts`, `message.ts`, `cite.ts`, `mentions.ts`, `fields-detail.ts`, `call-failure.ts`, `commitment-bar.ts` | Reading one answer: the shared interpret step, the `message` slot, cited passages, filed name mentions, refusal detail and the commitment bar |
| `decision-points.ts`, `item-ends.ts`, `kept-versions.ts`, `fact-kind-wording.ts`, `notice-deadline-prompt.ts` | The extraction decision points, how an item ends, what a retry keeps, and the prompt wording that versions share |
| `evals.ts`, `index.ts` | The package's exports |
| `trial.ts` | `runTrial`: replays a lane's saved calls under another prompt version |
| `config.ts` | `EXTRACT_CONFIG`, `EXTRACT_GENERATION`, `CALL_GENERATION` |
| `eval/` | The evaluations `pi extract check` runs, and their synthetic sets; `eval-score.ts` is how they score alike: type lines and gates, the one-to-one pairing of facts, pooled runs and printed lines |
| `test-support/` | The in-memory pipeline store and this package's test helpers; no production module imports it. The pipeline contract suite in `pi`'s extraction tests runs the same port calls on the memory store and the real store, so the two cannot drift |

The evaluation sets under `src/eval/` are synthetic, yet they stay in production source: `pi extract check` scores a live model on them, so the command ships with them. The package root exports only the evaluations and their report lines, never a set; another package's test reaches the sets through `@intelligence/personal-extract/testing`.

The `extract_run` log line carries the run's counts under snake-case keys (`live_calls`, `beliefs_changed`), since the personal logger accepts no other; `vault.extraction_runs` and `RunSummary` keep the contract's keys.
