# @intelligence/pi

The owner CLI and the agent API's process: of the three apps, the one that opens the store (the reasoner and the web page's client hold no database URL). It sets up keys and the database, connects Google accounts, syncs, extracts, registers and revokes clients, and serves the agent API over stdio. Logic lives in the packages; sync is the one piece that lives here.

Which models extraction uses is configuration, read from the environment (the `PI_EXTRACT_*`, `PI_DECIDE_MODEL` and `PI_JUDGE_MODEL` rows below); none is chosen in code.

- **May import:** `@intelligence/contracts`, `@intelligence/personal-core`, `@intelligence/personal-google`, `@intelligence/personal-store`, `@intelligence/personal-mcp`, `@intelligence/personal-models`, `@intelligence/personal-extract` and `@intelligence/personal-ladder`. It never imports `pg` and holds no SQL.
- **Runs with:** per command, only its own role's environment file, on the box as the `pi` user, but `mcp` and `http` as `pimcp`, `send` as `pisend` and `notify` as `pinotify`: one database role for each command (`sync` as `pi_writer`, `mcp` as `pi_reader`, `extract` and `extract check` as `pi_pipeline`, every owner command as `pi_admin`).
- **Must never:** give a command a database role it does not need; print a secret except a new client token, once; accept a secret as an argument; write anything but JSON-RPC to stdout in `pi mcp`; run an agent loop.

The memory adapter runs where an agent's memory is, as `pi adapter run`, `check` and `clear`, each naming one target of its configuration file (`~/.config/pi/adapters.json`, or `PI_ADAPTER_CONFIG`). It requires no variable, refuses every credential, opens no store, and imports only `@intelligence/contracts` and `@intelligence/personal-core`. Its files are `src/memory/memory-*.ts`; the owner's side is `pi memory status`, `exposures`, `imports` and `purge`.

Two entries besides `main.ts` are not `pi` commands and are run by the box's wrappers alone: `send/send-keys.ts` (narrows the key file for the send user) and `work/webhook-keys.ts` (stores or removes one webhook key, read on stdin).

It runs as `node apps/pi/src/main.ts` (Node 24 strips the types), or `pnpm pi` from the repository root.

## Commands

| Command | Role | Does |
| --- | --- | --- |
| `pi keys init [--compartments C,...]` | none | Writes the key file, with a key for each compartment (default `own`). Refuses to overwrite |
| `pi keys add-compartment C` | none | Adds one compartment's key, keeping every existing key. A `restricted:<category>` key goes to `PI_RESTRICTED_KEY_FILE`, which its first key creates, and then, with `PI_DATABASE_URL_ADMIN`, the category's row of `policy.restricted_categories`: the key first. Refused with `restricted_key_file_unset` when that variable is unset, and with `wrapped` once the restricted file is wrapped |
| `pi keys restricted-init` | `pi_admin` | To a terminal only. Wraps `PI_RESTRICTED_KEY_FILE` under a new recovery secret, with a key for each of health, money and legal and every key a plain file there held, and prints the recovery secret once; then turns those three categories on. The keys then open only through the dashboard's passkey unlock. A file already wrapped prints nothing and turns the categories on |
| `pi keys agent-copy [--http]` | `pi_admin` | Prints, to a pipe only (`not_a_pipe` to a terminal), the key file narrowed to the fingerprint key, `own`, `public`, every `agent:` key and every compartment a registered client holds or once held (`agent-keys.ts`; the names are kept in `<key file>.agent-held`, which only grows): the agent API's own key file, which the box writes as `pimcp`. With `--http`, the same narrowed to every client but the reasoner, by `<key file>.http-held`: `pi http`'s, written as `pihttp` |
| `pi keys agent-journal` | none | Prints the erasure journal's mark, `{"mark":N}`, and nothing of its entries (`journal_refused` when it is missing): the agent API's copy, which the box writes as `pimcp` (the timer, and `pi web serve --agent-journal` in its own process) |
| `pi keys accept-fingerprint` | `pi_admin` | The owner's word that the key file changed on purpose: the box's record of which keys it holds becomes the keys held now, and the `key_changed` box health card closes. Prints `recorded` |
| `pi db migrate [--auto]` | bootstrap | Makes the roles, with the passwords in the role URLs (`pi_restricted`'s is optional), and applies the migrations; a new database starts from the baseline, one file in place of the migrations it stands for. `--auto` is the box's unattended run, as the migration role: files only, no role and no password |
| `pi db pending [--deploy]` | `pi_admin` | Prints one word, `pending` when a migration file waits and `none` otherwise; with `--deploy`, `none`, `unattended` (the box's start applies it) or `owner` (only `pi-migrate` would), for the host's pre-deploy step |
| `pi db export DIR`, `pi db import DIR` | `pi_owner` (the bootstrap URL) | The owner's rows to JSON Lines under `DIR`, and back into an empty database |
| `pi google connect --account LABEL [--compartment C \| --contacts \| --drive] [--port P]` | `pi_admin` | Runs the loopback OAuth flow and stores the label's client and refresh token, sealed. The compartment is `own` (the default) or `employer:<slug>`. The mail grant needs `PI_GOOGLE_CLIENT_ID` and `PI_GOOGLE_CLIENT_SECRET`. `--contacts` and `--drive` add that grant to an existing label with its stored client and store only their own token (`wrong_account` or `account_mismatch` when consent comes from another address). A label with no stored client or address is `not_found` |
| `pi google list` | `pi_admin` | Each connected label: its compartment, its source accounts and their last sync, when its refresh token was stored, and whether its contacts token exists (`contacts`) and when it was stored, and whether its Drive token exists (`drive`) |
| `pi google disconnect LABEL [--contacts \| --drive]` | `pi_admin` | Deletes the label's secrets: the Drive token first, then the contacts token, then the refresh token, then the client, so sync stops reading it. With `--contacts`, the contacts token alone; with `--drive`, the Drive token alone. A label with nothing to delete is `not_found` |
| `pi sync [--backfill-days N] [--reset gmail\|calendar\|drive\|contacts]... [--fast \| --send-as]` | `pi_writer` | Takes new agent records into the vault, then syncs every connected label (mail, calendar, then contacts where a contacts token exists) under one lock. `--fast`, the timer's quick sync: mail and calendar alone. `--send-as`: each label's send-as list. Raises no card |
| `pi ties backfill --days N [--dry-run]` | `pi_writer` | Mail older than the sync window, by its headers alone, into the interaction log and warmth: no body, no subject, no message row, no extraction. Run as `pi-sync ties backfill`, by the owner; resumes by running it again |
| `pi sync --records` | `pi_writer` | The proposal wake's intake. Takes new agent records into the vault and nothing else, under the sync lock as every intake is; with the lock held it prints `busy` and exits 0. `records_refused` when one was refused |
| `pi identity link ENT ENT`, `pi identity differ ENT ENT` | `pi_admin` | A `same` or a `different` ruling between two people, by entity id, never an address. Prints `{ ruling }`, or `{ code: "already_settled", rulings }` for a pair already joined, writing nothing. `conflicting_ruling` and `shared_address` are refusals |
| `pi identity share ENT`, `pi identity list`, `pi identity lift RULING` | `pi_admin` | Marks a person's address shared and prints `{ ruling }`; lists the identity rulings, oldest first, by ids, verdict and times; lifts one and prints `{ lifted }` (`not_found` for an id that is no ruling in force) |
| `pi identity sweep [--dry-run]` | `pi_admin` | Raises the identity candidates as cards in the queue, by rules alone, and prints `{ candidates, raised, skipped }`. `--dry-run` prints what a sweep would merge and card, by basis and exception, and writes nothing. `sync_running` while a sync holds the lock. |
| `pi contacts remove LABEL` | `pi_admin` | Removes every stored contact of the label and prints `{ items }`; no erasure, every ruling stays. `contacts_connected` while the label's contacts token exists |
| `pi import contacts --adapter linkedin-connections\|google-contacts-csv\|mapped-csv [--map PATH] --name NAME [--dry-run] [--allow-removals]` | `pi_writer` | Imports a contact file from stdin as one complete listing of the import's account, then runs the identity sweep. Refuses a file that would empty the import, or remove most of it without `--allow-removals`. Prints counts as JSON; `--dry-run` writes nothing |
| `pi import list`, `pi import remove NAME` | `pi_admin` | Each import's contacts and last run; every contact of one removed through the deletion path, no erasure |
| `pi owner add-address ADDRESS [--compartment C]` | `pi_admin` | Records an owner address. It takes effect at the next sync |
| `pi clients add NAME [--views V,...] [--tools T,...] [--kind agent\|reasoner] [--runtime local\|cloud] [--compartments C,... \| --own \| --broad] [--retention R] [--no-work]` | `pi_admin` | Registers a client and prints its token, once. With no `--views` or `--tools`, the defaults of `pi clients defaults`. Compartments: bare, `public` and its own `agent:<name>` when it records; `--own` adds `own` (its old name, `--isolated`, still works); `--broad` adds `own` and every `--broad` agent's, shared both ways. `record` needs `PI_RECORD_ENABLED=1` (`record_disabled`). While no restricted category is on, clearing a client for `own` warns on stderr |
| `pi clients set-tools NAME --tools T,...` | `pi_admin` | Replaces a registered client's tools and keeps its token. Prints nothing. Adding `record` does what `clients add` does with it, the same refusal included |
| `pi clients set-compartments NAME --compartments C,... (widens only: to narrow, revoke and register a new name)` | `pi_admin` | Widens a client's clearance in place, keeping its token, tools and views, and writes one `combining_grant` decision. Refuses an unknown compartment (`unknown_compartment`) and any narrowing (`would_narrow`): to narrow, revoke the client and register a new name |
| `pi clients defaults NAME [--no-work] [--broad]` | `pi_admin` | Brings an agent to a new registration's setup (the default tools, harness grants, an intent), only adding; with `--broad`, two-way sharing too, and the agent then shares as one registered `--broad` does. `--own` (or `--isolated`, its deprecated old name) is accepted and changes nothing. A `clients add` or `oauth approve` with no `--views` or `--tools` runs it. Prints nothing. |
| `pi oauth approve NAME --registration FINGERPRINT [--views V,...] [--tools T,...] [--runtime local\|cloud] [--compartments C,... \| --own \| --broad] [--retention R] [--no-work]`, `pi oauth code NAME --registration FINGERPRINT` | `pi_admin` | Optional OAuth, to a terminal only. `approve` registers the client as `clients add` does and prints a one-time approval code instead of a token; `code` prints a new code for a registered client. The code opens only the registration `--registration` names. Without it, each lists the registrations waiting as JSON and exits 1 with `registration_needed` |
| `pi clients rotate NAME` | `pi_admin` | Replaces a client's token and prints the new one, once. Its name, compartments, agent records and audience stay |
| `pi clients list` | `pi_admin` | Every client, never a token or its hash |
| `pi clients revoke NAME` | `pi_admin` | Revokes a client. It keeps its name |
| `pi clients quota NAME [--items N] [--chars N] [--rows N] [--per-minute N]` | `pi_admin` | Sets a client's read budgets (`clients.ts`); those named replace the stored ones. Each within `ClientQuota`'s bounds, else a usage error before any connection. `clients add` stores the kind's defaults |
| `pi clients usage [NAME]` | `pi_admin` | Each client's use of its budgets in the last 24 hours and minute, and its `rate_limited` reads, as one JSON document. Counts only |
| `pi agents record [--weeks N]` | `pi_admin` | Each agent's bets, questions to the owner (paid and refused) and answers taken back, by ISO week, newest first, as JSON: names, dates and counts |
| `pi agent-records list [--client NAME] [--kind K] [--state S] [--limit N]` | `pi_admin` | Agent records as JSON: ids, names, kinds, times, labels, states and flags, never content |
| `pi agent-records show ID` | `pi_admin` | One agent record with its body, to a terminal only |
| `pi agent-records rm ID` | `pi_admin` | Removes that one agent record, its evidence row and blob, and prints `{ removed }` |
| `pi inspect ID\|ADDRESS` | `pi_admin` | Prints one entity, decrypted, to a terminal only |
| `pi mcp` | `pi_reader` | Serves the agent API on stdin and stdout for the client in `PI_CLIENT_TOKEN`: the read tools, `build_context_pack` among them, and `record` for a client that holds it |
| `pi lens add NAME [--compartments C,...] [--views V,...]`, `pi lens list`, `pi lens rotate NAME (--capture \| --mirror)`, `pi lens revoke NAME`, `pi lens tasks NAME (on \| off)` | `pi_admin` | Lens's devices. `add` registers a Mac's capture client `NAME-capture` and mirror client `NAME` and prints the capture token once, to a terminal only; the mirror gets its token at its first `rotate --mirror`. `list` prints each device's counts and times; `rotate` prints one channel's new token; `revoke` ends both clients; `tasks` switches the device's task items (off by default) |
| `pi lens scope add (--bundle ID \| --host HOST) [--account A] --compartment C [--kinds meeting,moment,block] [--agent-app [--client NAME]] [--source imessage]`, `pi lens scope list [--show]`, `pi lens scope remove ID` | `pi_admin` | Lens's capture scope. `add` prints the rule's id; it refuses `account_required` for a multi-account surface with no account and `browser_bundle` for a browser. `--agent-app` marks an agent app's rule and `--client` names the agent that runs in it; `--source imessage` makes a source rule for Messages. `list` prints the rules (`--show` adds values, to a terminal only); `remove` ends one, keeping what it admitted |
| `pi lens time [--from DATE] [--to DATE]` | `pi_admin` | A bad date or a `--from` after `--to` is `usage` |
| `pi time day [DATE] [--half am\|pm]`, `pi time project PROJECT [--days N]` | `pi_admin` | Work time: a local day's half-days in the owner's zone with their coverage, then its deep work and hours of deep, switching and meeting time; a project's time, sessions and tasks with advisory worked-on minutes. Computed at read, stored nowhere; to a terminal only. `pi time day` also prints the day's live proposals. |
| `pi time assign FROM TO (PROJECT \| --none [--compartment C])`, `pi time unassign RULING`, `pi time veto PROPOSAL [--to PROJECT]`, `pi time except add (--bundle ID \| --host HOST)`, `pi time except remove ID`, `pi time except list` | `pi_admin` | The owner's time rulings and the owner's answer to what the daily pass proposed. A veto is final. `except list` to a terminal only. |
| `pi canary setup` | `pi_admin` | Once, by the owner: the standing end-to-end check's keys, clients, device, scope rule, Drive root and tokens' file |
| `pi canary plant --day YYYY-MM-DD` | `pi_writer` | The check's items for a UTC day: over the agent API, then the connector seam, the records and the Lens inbox |
| `pi canary answer --day YYYY-MM-DD` | `pi_admin` | The check's proposal card answered, and the same proposal asked again |
| `pi canary check --day YYYY-MM-DD [--started EPOCH] [--budget]` | `pi_admin` | Each source followed to where it is used: one `ledger.job_runs` row and one `source code` line each |
| `pi improvements [--owners]` | `pi_admin` | The improvement store in ids, counts and codes, with its oldest open and what each cause measures; `--owners`, the open defects an agent marked the owner's to change |
| `pi improvements file` | `pi_admin` | One filing pass, by code |
| `pi improvements nightly --red N` | `pi_admin` | Records how many test files a scheduled full test run found failing, a measure the filing pass reads |
| `pi improvements close IMPROVEMENT --as wont_do\|duplicate [--of IMPROVEMENT]` | `pi_admin` | The owner's dismissal of a defect |
| `pi improvements role IMPROVEMENT ROLE\|--none` | `pi_admin` | The role whose agents work a defect |
| `pi improvements default-role ROLE\|--none` | `pi_admin` | The role defects go to; unset, no agent is assigned any |
| `pi levers` | `pi_admin` | Every registered lever: its range, value, mover, judging measure and last change |
| `pi levers set KEY VALUE` | `pi_admin` | The owner's change to a lever, inside its range |
| `pi levers undo KEY` | `pi_admin` | A lever back to the value before its last change |
| `pi ledger` | `pi_admin` | The capability ledger: for each job `ledger.job_runs` accepts, its run count over the last 14 days and its latest run's start and code, a job that never ran included. One JSON document of ids, counts, times and codes. Read-only |
| `pi doctor` | none | Checks every local dependency: the Node major against `.nvmrc`, pnpm against `packageManager`, Docker, the local Postgres server, and, when set, `PI_DATABASE_URL_ADMIN`'s pending migrations and `PI_KEY_FILE`'s mode. Prints one line a check and, under each failure, the command that fixes it; exits 1 on any failure |
| `pi loops [--days N]` | `pi_admin` | What each automatic loop produced over the last N days (7 unless given) and over the N before: extraction, dreaming, the work tick, agents, questions, the planner, the outcome loop and the measures. A loop's `state` rests on its output, not on having run: a dream pass that ended ok with nothing taking effect reads `idle` or `empty`. Counts only. Read-only |
| `pi outcomes [--days N]` | `pi_admin` | Whether each feature does what it is for and whether it is used: each outcome metric's value, sample, threshold and state, and each MCP tool's and feature table's use. One JSON document of ids, counts and codes. Read-only |
| `pi status [--storage]`, `pi status --coverage [--days N] [--record]` | `pi_admin` | Row counts, source accounts and their last sync, clients, and the key check; from Lens, each device's counts and the database's size beside `PI_CAPTURE_STORAGE_CEILING_BYTES`, with the storage alarm and a warning on stderr past 70 percent. `--storage` prints the alarm's code alone (`storage-alarm.ts`). `--coverage` prints the coverage report over the last `--days` days, and `--record` records it |
| `pi retain set CLASS (--days N \| --keep) [--account ACC]`, `pi retain adopt`, `list`, `plan`, `run` | `pi_admin` | Capture retention: one rule a decision and a journal line; `adopt` writes the capture defaults; `plan` counts what would go, against the defaults before any rule; `run` expires what is due. Any class but the three capture classes is `not_supported` |
| `pi db verifier` | none | Reads a password on stdin (not a terminal) and prints one SCRAM-SHA-256 verifier of it. No URL, no key file, no connection |
| `pi send list`, `show DRAFT`, `draft DRAFT --code C [--first-contact] [--new-thread] [--reveal R]`, `settle SEND --sent\|--not-sent`, `connect --account LABEL --port N`, `disconnect --account LABEL`, `status` | `pi_proxy` | The owner's sending |
| `pi messages held` | `pi_admin` | How many messages are held back from agents as account-recovery mail, and the newest fifty by id and time: nothing a message says. Provisional, with the hold |
| `pi messages release ID`, `pi messages release --older-than Nd` | `pi_admin` | Releases one held message, or every one older than `N` days, and prints `{ released: n }`. Exactly one of the two forms; an id that names no held message is `not_found` |
| `pi review [--kind K] [--limit N]` | `pi_admin` | The pending cards, oldest first, by id, kind, author, times, options, target and refs: nothing a card says. To a terminal only |
| `pi show CARD` | `pi_admin` | One card's lines, to a terminal only. A line someone other than code wrote is prefixed with who: `source:`, `model:`, `agent:` or `owner:` |
| `pi decide CARD... --answer A [--labels L,...] [--note TEXT] [--reason R] [--compartment C]` | `pi_admin` | Decides 1 to 25 cards with one answer and prints each ruling id. `--note`: a one-line note the planner reads; `--reason`: a decline reason from the fixed list, on a no only; `--compartment`: where an accepted goal is sealed. Running the same command again is refused as `not_pending` |
| `pi veto add [--entity ID] [--kind K]`, `pi veto list`, `pi veto lift ID` | `pi_admin` | Adds a veto on a person, an organization or a kind of work and prints its ruling id; lists the standing ones; lifts one, printing nothing. `--kind` is an `OpportunityKind` or `proposal`; another word is a usage error |
| `pi goal add --domain D [--compartment C]` (the domain required), `pia goals backfill`, `pi goal list`, `pi goal set ID --status active\|paused\|done\|dropped`; the `intent`, `harness` and `work` families ("Every command", below); `clients add` with `--kind reasoner` | `pi_admin` | Durable work's owner commands (`work-owner.ts`). A goal's statement comes from stdin only; `goal list` and `work show` print to a terminal only; `work run` prints `{ run }` or `{ silenced }`; a harness mode is `act` on an internal stage or `not_built`; one active reasoner at most |
| `pi extract [--max-calls N] [--agent-records \| --capture ID \| --canary]` | `pi_pipeline` | One extraction run on `PI_EXTRACT_MODEL` with the stored OpenRouter key, under the run's and the day's budgets. Exit 0 for `ok`, `budget`, `model_unavailable` and `already_running`; 1 for other refusals. Before its first call it checks the key's spend limit on OpenRouter and stops with a `spend_cap_*` code when the limit is missing, too high or reached. `PI_EXTRACT_MOMENTS=1` turns on the moment lane |
| `extract`'s `--capture ID`, `--agent-records` and `--canary` | `pi_pipeline` | `--canary`: the standing check's two compartments alone, every lane on, no relation step and no sweep. `--capture ID`: one stored meeting or moment, refused `not_due` until `pi extract retry --capture` set it waiting. `--agent-records`: the proposal wake's run, of agent records alone, which prints `busy` while another run holds the lock |
| `pi extract wake RUN` | `pi_pipeline` | Listens on `pi_agent_write`, waits 2 seconds for a burst, then starts RUN (the box's `lib/wake-run`); once at its start too, again 15 seconds after RUN exits 75. One `extract_wake` line a wake. Reads nothing, loads no key; pings its connection every 60 seconds; exits 0 after a day, 1 `unavailable` when its connection is lost or stops answering (`src/extract/wake.ts`) |
| `pi extract check [--world --lane document\|meeting\|moment\|correspondence\|transaction\|second-degree [--vendor openrouter\|anthropic] [--model ID] [--effort low\|medium\|high\|max] [--detail] [--runs 1-5] [--pseudonymise]]` | `pi_pipeline` | With no `--world`, first prints `spend_cap: ok limit_micro_usd=<n> remaining_micro_usd=<n>`, or `spend_cap: <code>` and exits 1 with that code before any call. Writes one usage row with the outcome `check` |
| `pi dream [--pass nightly\|weekly] [--max-calls N] [--usd D] [--seconds S]` | `pi_pipeline` | One night of the dream pass under the extract lock, on `PI_JUDGE_MODEL` (else `PI_EXTRACT_MODEL`) and its own nightly budget: the relations sweep, the fulfilled-commitments sweep, a source check of a sample, the relation switching job and the audit cards. Every relation stays in shadow. Prints its counts as one JSON line |
| `extract check`'s `--world --lane document` | `pi_pipeline` | Stores no evidence, and checks the key's spend limit first, as `pi extract` does |
| `extract check`'s `--world --lane correspondence` | `pi_pipeline` | Runs the 8 synthetic correspondence messages through `personal_correspondence` version 4 and prints the expected, found and extra counts per type, the refusals and the failed messages. Exit 0 only when every expected fact, and nothing else, is found and every owner-side claim has a domain (`check_failed` otherwise). Stores no evidence |
| `extract check`'s `--world --lane ...` with `--vendor`, `--model`, `--effort`, `--detail`, `--runs` and `--pseudonymise` | `pi_pipeline` | With no `--vendor`, the configured model and key. `--vendor anthropic` runs the same synthetic evaluation on Anthropic's API with `PI_EXTRACT_ANTHROPIC_KEY`, for comparing models; `--vendor openrouter`, `PI_EXTRACT_MODEL` on the stored key. An answer with no cost fails `check_failed`. `--detail` adds a line per item with its missed and extra facts, latency and cost; `--runs N` (1 to 5) pools the meeting and moment lanes' scores over N runs; `--pseudonymise` runs the set twice, plain and then pseudonymised (`PI_PSEUDONYMISE`'s pseudonymiser, whatever the switch says), prints each run's lines prefixed `plain` and `pseudonymised`, then a `delta NAME: PLAIN => PSEUDONYMISED` line for each line the two wrote differently and `pseudonymise: lines_changed N`, and fails when either run fails |
| `pi extract status` | `pi_admin` | One JSON document of counts, runs, spend and the withheld list, ids and times only |
| `pi extract review [--type T] [--sample N]` | `pi_admin` | To a terminal only. Shows sampled items and takes one answer per line: `right`, `wrong` or `wrong_date` for each claim, `missed` or an empty line for the item. An item with no claim and an empty line is stored as `nothing`, so it is not sampled again |
| `pi extract review-export [--type T] [--sample N]` | `pi_admin` | The same sample as `pi extract review`, as one JSON document (`ReviewExport`): a `sample_id`, the generation, and for each item what the terminal review shows and the ids its verdicts need. To a terminal only (`not_a_terminal`, with a hint, otherwise): the export holds decrypted mail from every compartment, so it is never piped or written to a file. Stores nothing |
| `pi extract review-import` | `pi_admin` | Reads one `ReviewImport` document from stdin and stores the verdicts it gives, in one transaction. Refuses, writing nothing, an invalid or stale document, an unknown or duplicate id, an item with a claim not judged, or a run in progress (`review_*`, `extract_running`). Prints `{ reviewed, stored }` |
| `pi extract retry (--all \| --status S \| --message ID \| --document ID) [--lane L] [--yes]` | `pi_admin` | Deletes the selected items' saved calls and sets them waiting; over fifty without `--yes`, `confirm_needed`. `extract_running` while a run holds the lock |
| `pi extract retry --kind meeting\|moment [--status S] [--yes]` | `pi_admin` | The same over every stored meeting or every moment, or those of one status |
| `pi extract retry --in-lane correspondence\|transaction\|agent [--status S] [--yes] [--keep-answers [--fact-kinds LANES]]` | `pi_admin` | The same over the items one message lane holds now; it sets no lane. `--keep-answers` keeps their saved calls, so each replays, but a message in a project under the lane's switch |
| `pi extract retry --capture ID` | `pi_admin` | One stored meeting or moment, by its `cap_` id or capture key: its saved calls deleted and the item set waiting, for `pi extract --capture` with the same id |
| `pi extract retry --message ID --override` | `pi_admin` | The owner's release of one withheld item; its saved answer is replayed with its narrowing ignored |
| `pi extract refusals [--sample N] [--show]` | `pi_pipeline` | The newest refused messages' saved answers replayed through today's check, the repair off and on: counts and code words, no request and nothing written; `--show`, to a terminal only, what each said |
| `pi extract replay-refused [--yes]` | `pi_admin` | The done items with a `bad_fields` refusal or a claim a repair kept set waiting, where a replay costs nothing; over fifty without `--yes` it prints the count |
| `pi extract reroute [--dry-run]` | `pi_admin` | The done transaction-lane messages from known correspondents set waiting for the correspondence lane, saved answers kept, as backfill. Counts only; `--dry-run` writes nothing. `extract_running` while a run holds the lock, but for a dry run |
| `pi extract item --message ID` | `pi_admin` | One message's lane, status, generation, triage line (`by`), Jev's `human_written`, claims by type and unmapped by reason. Ids, codes and counts only |
| `pi models set-key` | `pi_admin` | Reads the OpenRouter key from standard input and stores it sealed as `openrouter/key` |
| `pi models import-key` | `pi_admin` | The box's start: stores `PI_OPENROUTER_KEY` sealed as `openrouter/key`, writing nothing when the same value is stored |
| `pi self review [--kind K] [--status S]`, `pi self retire FACT...` | `pi_admin` | `review` prints, to a terminal only, every belief about the owner and the claims beside it, one numbered line each, with the claim ids it rests on. `retire` rules each fact named true but past: it closes the belief until the owner states the fact again, and `correct lift` lifts it |
| `pi facts show FACT`, `pi correct reject FACT...`, `pi correct veto FACT`, `pi correct list`, `pi correct lift RULING` | `pi_admin` | Corrections and fact vetoes. `facts show` prints one claim's lines, to a terminal only; `reject` rules that a claim counts in no belief and `veto` closes its fact key's belief, each printing its ruling id; `list` prints every ruling; `lift` ends one. The next `pi extract` rebuilds the affected beliefs |
| `pi declassify add FACT`, `pi declassify list`, `pi declassify revoke RULING` | `pi_admin` | Declassification. `add` copies one claim, sealed under the `declassified` key, for the clients cleared for it, and prints `{ ruling }`; `list` prints each as `standing`, `revoked` or `gone`; `revoke` deletes the copy and prints `{ exposed }`, the count of clients that may have read it. None prints content or a client's name |
| `pi promotion add CLAIM [CLAIM...]`, `pi promotion list`, `pi promotion revoke PROMOTION`, `pi promotion outbox`, `pi promotion take [--compartment C] < MESSAGES` | `pi_admin` | The promotion gate and its intake. `add` checks each claim named (labelled exactly `own` or `public`, the owner's or a source's, no third party's fact, no veto in force, no held source), records the promotion in `ledger.promotions` and prints its bundle: the claims' kinds and statements, with no id, key or label of this instance, a provenance hash and the release record. `list` prints each promotion sent by id, count and times; `revoke` prints its deletion notice; `outbox` prints, one line each, the bundle of every promotion in force and the notice of every revoked one, revoking first any whose claim is gone. On the receiving instance, `take` reads those lines from stdin and takes each: a bundle's claims under the compartment named (`own` by default) with ids it mints, a notice removing what its promotion gave; anything that is not exactly one is refused `invalid_promotion` |
| `pi digest` | `pi_admin` | The digest: pending cards by kind, deferred cards, the oldest pending card's age in whole days, held messages and withheld items. Counts only, as one JSON document |
| `pi web serve [--agent-journal]` | `pi_admin` | The owner's dashboard server, supervised; prints nothing. It listens on two Unix sockets beside the key file, never a TCP port, serves the web client and its routes (`src/web/web-routes.ts`), checks `Host`, `Origin` and the Tailscale login header, and accepts a passkey on the tailnet name. Sessions end after 30 minutes idle (10 for a passkey) and 8 hours in all. `--agent-journal` hands each new erasure-journal mark to the agent API's copy. Ends at SIGINT, SIGTERM or `pi web stop` |
| `pi web link [--register]` | `pi_admin` | To a terminal only. Asks the running server over the control socket for a new 256-bit code, good once within 5 minutes, and prints the link at `https://PI_WEB_TS_HOST`, or `http://localhost:8765` when none is set; `web_not_running` when none answers. `--register`: a code, kept apart from the login code, to register the phone's passkey, printed as `https://PI_WEB_TS_HOST/register?code=...`; `usage` without a `ts.net` name |
| `pi web stop` | `pi_admin` | Ends the running server at once; `web_not_running` when none answers |
| `pi restricted list` | `pi_admin` | The on categories, each with how many items carry it, its pending requests and its lifts. Counts only |
| `pi restricted reclassify [--apply]` | `pi_admin` | The one-time reclassification of stored mail: the term screen over every stored message, and for each on category how many items it would restrict. With `--apply`, a pending restriction request for each such item and its messages kept from every client (`restricting`) until sync's relabel. Counts only |
| `pi restricted lift --message ID --category C` | `pi_admin` | The lift. A stub: `not_built` |
| `pi --help` | none | The commands. It loads no package and no database driver |

A list argument is comma-separated, with no spaces. A compartment is a `PersonalCompartment`; a label is in the `ClientName` form.

## Every command

The table above describes the main commands. Every registered command, by family; `pi --help` prints each with its arguments. `readme.test.ts` checks this table against the command registry.

| Family | Commands |
| --- | --- |
| `pi adapter` | `run`, `check`, `clear` |
| `pi agent-records` | `list`, `show`, `rm`, `release` |
| `pi agents` | `record` |
| `pi areas` | itself, `add`, `rename`, `order`, `retire`, `default` |
| `pi backtest` | `record` |
| `pi backup` | `taken` |
| `pi canary` | `setup`, `plant`, `answer`, `check` |
| `pi capture` | `lines-backfill` |
| `pi cards` | `reopen`, `relayed`, `settled`, `mark` |
| `pi clients` | `add`, `defaults`, `set-tools`, `set-compartments`, `roles`, `rotate`, `list`, `revoke`, `webhook set`, `webhook rm`, `quota`, `usage` |
| `pi commitments` | `list`, `close`, `reopen`, `closed`, `agent-closes` |
| `pi contacts` | `remove`, `reclaim`, `file-org-names` |
| `pi correct` | `reject`, `veto`, `list`, `lift`, `value` |
| `pi db` | `migrate`, `pending`, `export`, `import`, `verifier` |
| `pi decide` | itself |
| `pi declassify` | `add`, `list`, `revoke` |
| `pi digest` | itself |
| `pi doctor` | itself |
| `pi documents` | `held`, `release` |
| `pi dream` | itself, `line`, `model`, `lines`, `sample`, `mark`, `settlements lift`, `findings`, `nights`, `trial` |
| `pi drive` | `add`, `list`, `set`, `remove` |
| `pi erase` | `item`, `person`, `list`, `lift`, `replay`, `settle`, `exposures` |
| `pi exposures` | `status` |
| `pi extract` | itself, `check`, `wake`, `match-backfill`, `age`, `status`, `value-fp-backfill`, `carry-over`, `measure-beliefs`, `measure-about`, `measure-reads`, `measure-disputes`, `measure-projects`, `review`, `review-export`, `review-import`, `reroute`, `item`, `retry`, `trial`, `refusals`, `replay-refused` |
| `pi facts` | `show`, `domain`, `kind`, `join`, `split`, `rulings`, `lift`, `grouping`, `groupings`, `release`, `clean`, `grant`, `grant-lift`, `grants`, `learning`, `rates` |
| `pi goal` | `add`, `list`, `set`, `edit`, `rank`, `adopt`, `unadopt`, `hide`, `unhide`, `target` |
| `pi goals` | `backfill` |
| `pi google` | `connect`, `list`, `disconnect` |
| `pi harness` | `grant`, `list`, `revoke` |
| `pi health` | `job`, `hold`, `restarting`, `dashboard-down`, `dream-due`, `open`, `keys` |
| `pi http` | itself |
| `pi identity` | `link`, `differ`, `share`, `list`, `lift`, `sweep`, `dream-merges`, `thin`, `agents`, `merges`, `role`, `person`, `reclassify`, `local-names-backfill`, `mentions`, `bind`, `unbind`, `bindings`, `refile` |
| `pi ignore` | `add`, `list`, `lift` |
| `pi import` | `contacts`, `list`, `remove` |
| `pi improvements` | itself, `file`, `nightly`, `close`, `role`, `default-role` |
| `pi inspect` | itself |
| `pi intent` | `add`, `role`, `list`, `revoke` |
| `pi keys` | `init`, `add-compartment`, `restricted-init`, `agent-copy`, `agent-journal`, `accept-fingerprint` |
| `pi ladder` | `review`, `calibrate`, `resume` |
| `pi learn` | `label`, `silences` |
| `pi ledger` | itself |
| `pi lens` | `add`, `list`, `rotate`, `revoke`, `tasks`, `contacts`, `backfill vouch`, `scope add`, `scope list`, `scope remove`, `browsing`, `browsing exclude`, `browsing account`, `time` |
| `pi levers` | itself, `set`, `undo` |
| `pi lists` | itself, `create`, `rename`, `delete`, `add`, `remove` |
| `pi loops` | itself |
| `pi mcp` | itself |
| `pi memory` | `status`, `exposures`, `imports`, `purge` |
| `pi messages` | `held`, `release` |
| `pi models` | `set-key`, `import-key` |
| `pi note` | `add`, `edit`, `retire`, `list` |
| `pi notify` | itself |
| `pi oauth` | `approve`, `code` |
| `pi open-items` | `list`, `close`, `reopen` |
| `pi org` | `name`, `refold` |
| `pi outcomes` | itself |
| `pi owner` | `add-address`, `aliases`, `timezone` |
| `pi people` | `tiers`, `tier`, `warmth` |
| `pi person` | `name`, `name lift` |
| `pi project` | `add`, `anchor`, `unanchor`, `close`, `list`, `area` |
| `pi promotion` | `add`, `list`, `revoke`, `outbox`, `take` |
| `pi relations` | `on`, `off`, `convert-groupings` |
| `pi research` | `landed`, `lift` |
| `pi restatements` | `list`, `clear` |
| `pi restore` | `check` |
| `pi restricted` | `list`, `reclassify`, `lift` |
| `pi retain` | `set`, `adopt`, `list`, `plan`, `run` |
| `pi review` | itself |
| `pi rules` | `list`, `lift` |
| `pi self` | `review`, `retire` |
| `pi send` | `list`, `show`, `draft`, `settle`, `connect`, `disconnect`, `status` |
| `pi show` | itself |
| `pi status` | itself |
| `pi sync` | itself |
| `pi thresholds` | `list`, `target`, `grant`, `set`, `revoke` |
| `pi ties` | `backfill` |
| `pi time` | `day`, `project`, `assign`, `unassign`, `veto`, `except add`, `except remove`, `except list`, `agents`, `agents lift`, `agents mark`, `titles` |
| `pi triggers` | `seed` |
| `pi veto` | `add`, `list`, `lift` |
| `pi web` | `serve`, `link`, `stop` |
| `pi work` | `tick`, `gaps`, `status`, `stop`, `start`, `tasks`, `route`, `cancel`, `free`, `task`, `task withdraw`, `result`, `budget`, `lesson`, `learnings`, `learning`, `mission`, `run`, `show`, `report`, `trial`, `trials`, `trial-show`, `pings` |

## Environment

`src/switches.ts` holds every variable, with who reads it, the box files that carry it and who may hold it. Its rows say what each one does.

## Output

- stdout carries only a command's result (a token printed once, a URL, one JSON document, or JSON-RPC from `pi mcp`); every log line goes to stderr as one JSON object of an event code, ids, counts, a duration and a code, and nothing else.
- A failure is one `command_failed` line with its code, then its fixed hint where it has one; an uncaught error is the same one line, with no message, stack or cause.
- Sync writes a line of counts for what it skipped or did not store, per item or per account, so an account's counts match its lines; one item never stops an account. A run in which the store or a connector refused an item exits 1 with `items_refused`.
- Before reading or writing, `sync`, `mcp` and the owner commands compare the erasure journal beside the key file with the database, and exit 1 with `erasure_replay_needed` when they differ.
- Exit codes: `0` success (also `already_running` and `no_accounts`), `1` a refused or failed operation, `2` a usage error.

## Files

`src/` holds the entry, the command table and what every command shares; each command area is a folder of its own, its tests beside its files:

| Folder | Holds |
| --- | --- |
| `src/` | `main.ts`, `index.ts`, the command table (`commands*.ts`, `command-kit.ts`), `env.ts`, `logger.ts`, and `owner.ts`, the owner commands' shared bodies and helpers; `e2e.db.test.ts`, the core end to end |
| `src/intake/` | Sync, the Google and Drive connections, contact import, the people confirmed from agents, and Lens's devices and scopes |
| `src/canary/` | The standing end-to-end check: its steps, what it follows each source to, and the connector seam it plants through |
| `src/extract/` | Extraction and its steps after the rebuild (relations, outcomes, same-fact), the dream, the wake, the check, the measures, the model key, and the owner's extraction review |
| `src/owner/` | The owner's commands on what the store holds: identity, the queue and vetoes, rulings, erasure, exposures and retention, declassification, notes, lists, names, projects, areas, research, time, and the ladder's calibration |
| `src/work/` | Durable work: the tick, the owner's work commands, the notice sender and its webhook keys, and the planner's end-to-end tests |
| `src/agents/` | The agent API (`pi mcp`, `pi http`), the agents' key file, client quotas, and agent records end to end |
| `src/web/` | The owner's dashboard: its server, route registry, names, client files and passkey, and `pi digest` |
| `src/memory/` | The memory adapter and the owner's memory reads |
| `src/send/` | `pi send` and the send wrapper's key step |
| `src/box/` | The box's health, `pi db verifier` and the storage alarm |
| `src/dev/` | `check-prompt.ts`, run from a checkout over the synthetic world, never on the box |
| `src/test-support/` | The tests' fixtures and harnesses. No production file loads them, which a structure test checks |

| File | Holds |
| --- | --- |
| `src/main.ts` | The entry: it sets the process to UTC, calls `run` once, and holds the fixed line for an error nothing caught and the log event for a process warning |
| `src/commands.ts` | `run`: the secret-argument check, the command table's sections in the order `--help` prints them, the checks before a body, the failure line |
| `src/command-kit.ts` | What the command table is built from: the lazy body loaders, the option shapes, the environment names and role presets, and the argument checks run before any connection |
| `src/commands-box.ts` | The table's sections of rows for the box: keys, database, status, health, backup, the agent API's and sender's processes, the page, the reports |
| `src/commands-sources.ts` | Its rows for what comes in: Google, Drive, sync, addresses, Lens, capture, contact import, ties, held messages |
| `src/commands-agents.ts` | Its rows for agents: clients, OAuth, agent records, memory and its adapter, intents, harness modes, send |
| `src/commands-extract.ts` | Its rows for extraction and what steers it: runs, the dream, relations, the ladder, learning, thresholds, models, restricted |
| `src/commands-rulings.ts` | Its rows for what the owner rules on: cards, vetoes, erasure, retention, identity, people, facts, commitments, research |
| `src/commands-work.ts` | Its rows for durable work: work, notes, goals, projects, areas, work time |
| `src/commands-canary.ts` | Its rows for the standing end-to-end check |
| `src/switches.ts` | Every `PI_*` switch and database role, one row each: who reads it, which box file carries it, where it is documented, who may hold it |
| `src/env.ts` | The role check, the missing-variable check, and `pi`'s refusals |
| `src/logger.ts` | The `PersonalLogger`, on stderr |
| `src/owner.ts` | The owner commands' bodies |
| `src/extract/extract.ts` | `extract`, `extract trial`, `extract age`, `extract match-backfill` and `triggers seed` |
| `src/extract/extract-config.ts` | What every extraction command reads before any connection: its settings, models and vendor, the pipeline, the model and Jev clients, and the spend-cap check |
| `src/extract/extract-check.ts` | `extract check`, and its `--world` lane evaluations |
| `src/extract/same-fact.ts` | The same-fact sweep `pi extract` runs after the rebuild |
| `src/extract/extract-owner.ts` | `extract status`, `review` and `retry` |
| `src/extract/models.ts` | `models set-key` and `models import-key` |
| `src/test-support/extract-fixtures.ts` | A test helper: the world synced, its facts and statuses read back. Never imported by `pi` |
| `src/intake/sync.ts` | `runSync`, personal ingest: each label's mail, calendar, contacts and Drive |
| `src/intake/sync-drive.ts` | One label's Drive pages, and the removals pass at the storage ceiling |
| `src/intake/sync-pages.ts` | What the mail and Drive syncs share: the refusals no retry mends, the page size, the derive step and the recorded outcome |
| `src/intake/sync-google.ts` | One connected Google label: its stored client, the connected labels, and the source built from its tokens |
| `src/intake/ties-backfill.ts` | The `ties backfill` command: older mail by its headers, each batch stored under the sync lock |
| `src/intake/sync-command.ts` | The `sync` command: options, the job-run row, the sync lock, records, Lens's drain and the steps after the labels |
| `src/owner/identity.ts` | The identity commands' and `contacts remove`'s bodies |
| `src/intake/contact-import.ts` | `import contacts`, `import list` and `import remove` |
| `src/intake/lens.ts` | `lens add`, `list`, `rotate` and `revoke`, and `lens scope add`, `list` and `remove` |
| `src/send/send.ts` | The `pi send` commands' bodies. The only importer of `@intelligence/personal-google/send` |
| `src/send/send-keys.ts` | Not a `pi` command and not imported by `main.ts`: the box's `pi-send` runs it as root, from an empty environment, to narrow the key file's bytes a `pi` process hands it on standard input to the copy `pi send` holds (`forSending`), written to its one argument, mode 0600, never over a file. It imports `@intelligence/personal-store/keys` alone and prints nothing |
| `src/box/verifier.ts` | `pi db verifier` |
| `src/agents/mcp.ts` | The `mcp` command |
| `src/work/tick.ts` | `runTick` and `pi work tick`: the start check, then the dispatcher's seven steps under the work lock, the ladder called between the store's reads and its writes, then the learning item's two outcome steps, the kill switch on or off; one `work_tick` log line of counts, `links` and `assessed` among them |
| `src/work/work-owner.ts` | The work board's owner commands: status, stop and start, tasks, routes, pings, cancel, free, results and the budget |
| `src/work/goals.ts` | The owner's goal commands |
| `src/work/intents.ts` | The intent and harness-mode commands |
| `src/work/work-runs.ts` | Lessons, learnings, the mission, the planner's runs, reports and trials, and `work show` |
| `src/work/work-args.ts` | What the work commands share: their argument readers and the owner's words from stdin |
| `src/test-support/work-harness.ts` | Test support for durable work's end-to-end tests and the prompt check: steps 1 to 4 of the sequence on a test database (keys, migrate, one sync of the synthetic world, the journal, the reasoner and the worker with their wrapper scripts, a goal, an intent, a harness mode, a queued run), and the reasoner's `runOnce` with a recorded model. Loaded by no command |
| `src/dev/check-prompt.ts` | The prompt check, a script the owner runs once on their own computer, below |
| `src/web/web-commands.ts` | `pi digest` and `pi web serve`, `link` and `stop`: the server's start and the control socket's words |
| `src/web/web.ts` | The dashboard's server, composed of the files below: the two sockets, the control socket's words, the name holds' sweep and the close |
| `src/web/web-answer.ts` | Every answer with the security headers, the client's files in an accepted encoding, a long read compressed, and a JSON body within its limit |
| `src/web/web-sessions.ts` | The login codes and the sessions, in memory and hashed: one per device, idle and lifetime |
| `src/web/web-ceremony.ts` | The passkey's ceremonies: options, registration and assertion, each challenge used once |
| `src/web/web-guards.ts` | The Host and Tailscale header check, and the Origin and token check of a POST |
| `src/web/web-router.ts` | Each request by its path: the link login, a ceremony, the registry's reads, streams and writes, or the client's files |
| `src/web/web-api.ts` | Which Admin call each route of the registry (`web-routes.ts`) makes, with its fixed arguments |
| `src/web/web-client.ts` | The client's shell and assets, read once from its manifest, or the placeholder |
| `src/web/web-passkey.ts` | The phone's passkey: a registration's and an assertion's checks with `node:crypto`, and the credential's file. `test-support/passkey-fixtures.ts` is the tests' software authenticator |

## The prompt check

`node apps/pi/src/dev/check-prompt.ts <model id> [<second model id>]`, from a checkout with a local Postgres (`pnpm db:up`), before durable work starts on a deployment and whenever `RUN_PROMPT`'s version changes. It reads the reasoner's key from standard input only, runs the reasoner once over the work harness with the live model, and prints the run's end, output, refusals, turns and cost as one JSON object. With two ids it runs each on its own copy of the request. It keeps nothing.

## What the host must provide

With "Recovery: what the host must state" it is the input of the host's setup. This package decides none of it.

## Tests

The `commands-*.test.ts` files, `logger.test.ts`, `web.test.ts` and `check-prompt.test.ts` need no database. The `*.db.test.ts` files run against the local Postgres, each in a test database of its own, on the fakes and the synthetic world of `@intelligence/personal-core/testing`. End-to-end files (`e2e*.db.test.ts`, `work*.db.test.ts`, `send-*.db.test.ts`, `contacts-gate.db.test.ts`) run the real `pi` process. No test calls Google, OpenRouter or another vendor: models are recorded or faked (`fakeModelClient`, a fake `fetch`).
