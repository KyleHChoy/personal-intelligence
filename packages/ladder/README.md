# @intelligence/personal-ladder

The decision point registry of Personal Intelligence: the rules every definition must pass when the module loads, the rung 0 functions of the first version, `decide`, and the reasoning run's prompt.

- `REGISTRY`: the contracts' `DECISION_POINTS`, loaded under `DECISION_POINT_PINS`, `PROMPT_PINS` and `THRESHOLD_PINS`. A definition that maps a model rung to an `external` effect, or any rung but 4 to an owner-only effect, stops every process that imports this package. It keeps every version and answers `current(id)` and `at(id, version)`, never a lookup by id alone. The load rules L7 to L10 check model entries, fallbacks and `whileWaiting`; `UNBANDED` is the frozen list of older definitions with model rungs and no entries.
- `climb(registry, point, input)`: rung 0, then each model rung through a runner the caller hands it, banded by `bandFor` under the effective thresholds, then the fallback or rung 4. It never calls a model itself.
- `decide(registry, point, facts, rung0)`: `climb` with no runners at the current version: a `DecisionPointCall`, settled at rung 0, the fallback, or escalated to the owner's rung 4.
- `wakeWorthRun`, `opportunityGo`, `basisTrusted`: rung 0, pure, over the fact types in `src/facts.ts`.
- `sendClearRung0(outcome)`: rung 0 of `send_clear`, pure: `refuse` when the gate held the draft, `cannot_decide` when it cleared it, and never `clear`. The send proxy's three points (`send_clear`, `send_first_contact`, `draft_disclosure`) are in `REGISTRY` with the rest.
- Calibration, pure, in `src/calibrate.ts`, over the owner's deliberate verdicts only (the caller leaves out hurried, batch and over-cap answers, and releases): `bandOf` and `weightOf` for review sampling; `report`, the weekly report's counts, weighted shares and Wilson intervals on the effective sample size; `proposeThreshold`, a hold by recall, a `clear` by miss, the lane by agreement, an `accept` by precision and a `reject` by miss, from the scored verdicts; `checkGrant` (`out_of_bounds`); `findDrift`, which suspends only `extract_triage` and `draft_disclosure` and never drifts `identity_rank`.
- `RUN_PROMPT`, `RUN_PROMPTS`, `runPromptFor`, `renderRunInput`: the system prompt of `run_outcome` (version 4, the planner that reads the stores, steered by the owner's mission and confirmed lessons; versions 1 to 3 kept for the runs queued under them), the prompt a run's request names, and the request's data blocks.
- `checkRunOutput(output, request)`, pure: the code checks of a run's output before `finish_run`, each refusal an action's index and a code (`RUN_CHECK_CODES`), and `refusalText`, what the model is told of them.

May import: `@intelligence/contracts`, and `node:crypto` for SHA-256. Runs with no credentials: no clock, no file, no network, no database.

Test support: `src/test-support/points.ts`, model-entry definitions for this package's own tests. The package has no `./testing` entry, since no other package uses it.
