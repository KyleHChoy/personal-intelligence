# @intelligence/personal-reasoner

`pi-reasoner`, the agent loops of Personal Intelligence. `once` takes at most one queued run through the agent API, reasons over it with a model and the read tools, finishes it, and exits. `measure` takes the weekly outcome test when it is due.

May import: `@intelligence/contracts`, `@intelligence/personal-ladder`, `@intelligence/personal-models`, and no third-party or dev dependency (`manifest.test.ts` pins this). Runs with one model key, OpenRouter's or Anthropic's, and the command that starts `pi mcp`: no database URL, no key file, no journal path, no client token. Listed under `agentLoops` in `zones.json`, so the import fence keeps it from every database and decryption package.

## Running

`node apps/reasoner/src/main.ts once`, or `measure` as the Unix user `tester`. Any other argument is a usage error, exit 2. The process runs in UTC, and an error nothing caught ends it with one fixed line.

| Variable | Holds |
| --- | --- |
| `PI_AGENT_API_COMMAND` | How to start `pi mcp`. Default `/usr/bin/sudo -n -u pimcp /usr/local/bin/pi-mcp`. Split on spaces, run with no shell. Only tests set it |
| `PI_REASONER_MODEL` | The model's id at the key's vendor: an OpenRouter id, or an Anthropic model id on an Anthropic key. Required; no default in code |
| `PI_REASONER_MODEL_KEY` | The reasoner's own key, never extraction's: an OpenRouter key, or an Anthropic key (it starts `sk-ant-`), which sends every call to Anthropic's Messages API instead. Required |
| `PI_REASONER_REASONING_EFFORT` | `low`, `medium` or `high`, sent as OpenRouter's reasoning effort or Anthropic's; unset or empty sends none. Another value is `bad_env` |
| `PI_REASONER_KEY_CAP_USD` | The most an OpenRouter key may spend in a month, in dollars with at most six decimals; default `50`. Not a secret. Another value is `bad_env`. An Anthropic key has no endpoint that reports its spend: its cap is the workspace's spend limit in Anthropic's console, and the run logs `spend_cap` with the code `anthropic_console` |
| `PI_REASONER_WEB_SEARCH` | On an Anthropic key only: the most web searches a request may make. Off unless set: unset, empty or `off` offers no search, and a whole number from 1 to 100 opts in. Another value is `bad_env`, on any key |
| `PI_REASONER_WEB_FETCH` | The same for web fetch: unset, empty or `off` offers none; 1 to 100 opts in |
| `PI_OPENROUTER_KEY_URL` | The spend-cap check's key endpoint, for the box's smoke test alone; unset is OpenRouter's. Only `http://127.0.0.1:<port>/...`, never a name such as `localhost`; another value is `bad_env`, before the key is read. Production never sets it |

There is no switch for retention: every model call carries the two retention fields.

## Pieces

- `env.ts`: `assertNoDataAccess` refuses (`wrong_role_url`) any set `PG*` or `PI_DATABASE_URL_*` name, `DATABASE_URL`, `PI_KEY_FILE`, `PI_ERASURE_JOURNAL`, `PI_GOOGLE_CLIENT_SECRET` or `PI_CLIENT_TOKEN`, and any variable whose value is a Postgres connection URL (`postgres://` or `postgresql://`). `requireEnv` names the first unset variable (`missing_env`), never a value.
- `agent-api.ts`: `startAgentApi(command, { path })` starts the child with `PATH` alone, JSON-RPC one line each way, one request at a time. A child that exits, a reply over 4 MiB, a reply that is not JSON, or no reply within 60 seconds ends the client: every later call answers `unavailable`.
- `conversation.ts`: what the run's loop and the outcome test's share: the tools, a result's size, how a conversation is made shorter.
- `loop.ts`: `runLoop(request, { api, model, log })`, the run from its first turn to its `finish_run`, under the prompt its request names. Its output is checked by the ladder's `checkStageOutput` first: each refusal is recorded as an `output_check` step with its code and logged `output_refused` (index and code), the output gets one more turn with the codes, and a second refusal ends the run `bad_output`. A call refused `invalid_request` is answered with each argument its tool's schema refuses and the rule it broke, in fixed words, and a hint for `find_messages` and `build_context_pack` (`refusal.ts`); five refused calls in a row end the run `bad_output`; a call that succeeds starts the count again, and a hundred in all end it too.
- `fit.ts`: `fitResult(tool, value, max)`, a `get_self` or `get_entity` result over the 40 000 code point cap cut to fit: each belief's latest cite, facts without what the planner has no use for, then no facts in no belief, then fewer beliefs, least recently confirmed first, with `more` set. Pure.
- `outcome-test.ts`: `measureOnce(env, deps)`, the weekly outcome test. `jsonOf` reads an answer's JSON from the whole text, a final code fence or prose before an object; `inSections` matches a section whatever its case or spacing. `outcome-test.replay.test.ts` replays the eight visible tasks on recorded answers, scored at code's cap.
- `run.ts`: `runOnce(env, { startApi?, model?, log?, stderr?, keyFetch?, modelDeps? })` checks the environment, builds the model, checks an OpenRouter key's spend cap, starts the agent API, calls `next_run` and runs the loop. A trial run names a model and an effort the owner chose in its request: the loop then runs on that model and effort, with the same key, so the same spend cap bounds it; any other run uses `PI_REASONER_MODEL` and `PI_REASONER_REASONING_EFFORT`. Exit 0 for no run, a finished one or a stopped one; 1 for a failed run or a failure of the agent API or the environment. Nothing is kept between runs.
- `model.ts`: `createTurnModel` (the live `TurnModel`, also used by pi's prompt check) and `turnModelFromEnv(env, deps?, trial?)` (a trial's model, else `PI_REASONER_MODEL`). On an Anthropic key it offers Anthropic's `web_search` and `web_fetch` server tools from the two web variables (`serverToolsFromEnv`), with `WEB_RULES` after the stage's prompt: web results are data, and what rests on them says "from the web". The search and fetch run on the vendor's side; this process fetches nothing.
- `loop.ts` records each search's query and each fetch's URL as a `web_search` or `web_fetch` step, which the store seals under the run's label; server tool blocks stay on the assistant turn, which goes back to the model unchanged, and never reach the agent API. When the context is compacted, `compactWeb` leaves earlier turns' searches and fetches out, named in a text block, and `dropThinking` drops every thinking block, so no block bound to the old history is sent.

Each `model_call` step carries the reply's token counts, when the vendor gave them, and the call's wall-clock milliseconds: counts only.

Logs carry ids, counts and codes only: `spend_cap` with its code and the limit and room left in micro-dollars, `output_refused` for each refused action, `result_fitted` with how many beliefs and facts a cut result lost, `tool_refused` and `tool_failed` with the call's place and code, `tool_argument_refused` with the call's place, the issue code as a count and the argument's name as the code (`other` for a key no tool takes), `pack_refused` with the call's place, its purpose as the code (`other` when it is none) and whether an event or entity id was given, `output_malformed` with the turn and each issue code of an answer that does not fit its stage's form (it gets one more turn, told each path and rule, `output-issues.ts`), `model_call_failed` with the turn and what failed (`timed_out`, `http_<status>`, or the client's code), `output_refs_dropped` with the turn and how many basis refs and items were dropped from an answer whose basis cited refs the form does not take (`salvage.ts`; the rest go on to the checks), `web_requests` with the turn and the counts of searches, fetches and searches billed (never a query or URL), `run_ended` once per run, `reasoner_failed` with a code.

## What the host must provide

The host's setup builds them; this package decides none of it. Its end-to-end tests are pi's `work.e2e.db.test.ts` and `work-rungs.db.test.ts`, `work-reasoner-limits.db.test.ts` and `work-owner-control.db.test.ts`, with a recorded model.
