# @intelligence/personal-mcp

The personal agent API: a hand-written MCP endpoint, over stdio and over HTTP, through which a registered client calls the tools its catalogue lists (`src/tool-catalogue.pin.json`, by the view each needs).

It is a thin gateway. For every request but `ping` it asks the context provider who the client is, checks the tool against the client's registration and views, parses the arguments with the tool's strict schema, makes one read, and checks the value against its strict result schema before sending it. A call it refuses for its tool or its arguments is not read for: the tool's name is handed to the provider's `refused`, which decides the code from the client's registration, records it in the call log and answers it. It keeps nothing between messages but each session's taint label (below), so a revoked client is refused on its next message. Protocol version `2025-06-18` only.

The two message tools are served as the other read tools are. `find_messages` lists stored messages by a person or organization or by a sender's address or domain, by date range and by category; `read_message` returns one message's text in slices, its attachments' names, types and sizes, and the link that opens its thread in Gmail. A message's text is passed on exactly as the provider returned it, inside `{ untrusted }`: nothing in it is read here, and a line break in it stays inside a JSON string, so a reply is always one line. The link is sent only when the result's schema accepts it. Their fixed descriptions also say that a sender's domain is matched exactly, and that account-recovery mail is held back until the owner releases it: the hold itself is the store's, and a held message never reaches this package.

`find_documents` and `get_document` list the owner's stored Drive files and read one document's text in a window, with its outline and the link that opens it in Google. A window is counted in UTF-16 code units, where `read_message` counts code points, and both descriptions say so. Results are parsed with `DocumentList` and `DocumentView`: a title, a heading, a text, a name or an address not wrapped as untrusted, a heading over 200 code units or a link of another form is never sent. The hold of account-recovery documents is the store's.

`find_facts` (view `work`) lists the facts extraction took from stored mail: receipts, commitments and plans, by type, by a person or organization and by date range. Its result is parsed with `FactList`, a strict union keyed by type, so a fact of a type the contract does not know, a bare text value or a fact without `agentReported` is never sent. Its fixed description says that a fact is a model's reading checked by code and can be wrong, that the message it names is the authority, and that `status` is a belief's age and whether the same person took it back, never that a commitment was kept or is overdue.

`build_context_pack` is dispatched to the port as the read tools are: its arguments are parsed, one `buildContextPack` call is made, and the pack is checked against `ContextPack` and passed on as the provider returned it. A purpose's own view is the provider's to refuse. `sync_memory` is dispatched the same way, to `syncMemory`, its result checked against `MemoryProjection`. `record` is a write: it is offered to a client whose registration holds it, with no view asked, and one `record` call is made. `propose_about_you` and `import_memory` are offered and dispatched the same way, to `proposeAboutYou` and `importMemory`, their arguments parsed with `ProposeAboutYouArgs` and `ImportMemoryArgs`. An agent record's body is never logged and never read here. A write tool's `rate_limited` is answered as the tool's own refusal.

The work tools (`list_opportunities`, `claim_opportunity`, `release_opportunity`, `propose_hypothesis`, `record_test`, `propose_opportunity`, `plan_move`, `report_move`, `set_intention`) and the run tools (`next_run`, `append_step`, `finish_run`) all need the view `work` (`WORK_TOOL_VIEW`), and each is offered only when the registration holds it. Their arguments are parsed with `PersonalWorkArgs`, strict, and their results with `PersonalWorkResults`, strict, so a summary not wrapped in `{ untrusted }` or a field the contract does not name is never sent. A call reaches its one `PersonalWork` method and no read method but `client`; a call refused here is handed to the work port's `refusedWork`, which decides and records the code as `refused` does for reads. Which client kind may hold a run tool, and every lease, label and authority check, is the store's.

Five more work tools (`post_agent_message`, `read_agent_inbox`, `submit_improvement`, `list_improvements`, `update_improvement`) are served as the other work tools are: the `work` view, offered only when the registration holds each, one port call each, the result parsed with its strict schema.

`draft_message` needs the view of `SEND_TOOL_VIEW`, `work`, and is offered only when the registration holds it. Its arguments are parsed with `DraftMessageArgs`, strict, so a label, a sender, a thread or a header is never accepted, and its result with `DraftMessageResult`, one key: the draft's id, whatever the gate decided. A call reaches `PersonalWork.draftMessage` and no read method but `client`; a call refused here goes to `refusedWork`. Its `rate_limited` (50 open drafts) is answered as the tool's own refusal, as `record`'s is. No tool's name or description offers to send: a draft is inert until the owner acts.

Lens's two tools are rows of the table: `push_capture`, for a client of kind `device`, needs no view, and `sync_mirror` needs `self`. Each makes its one port call. Over REST, `sync_mirror`'s `stale_cursor` answers `409` and `unsupported_template` `406`, and its OpenAPI responses list both.

Every `tools/call` of a tool served is answered at its reply deadline: `DEADLINE_MS[tool]` after the line was handed to `handle`, by a monotonic clock, whatever it found, refusals and failures included, so the time a reply takes says nothing of rows the caller cannot see. A call whose work runs past it is answered at the next whole multiple and logs `reply_over_deadline` with the tool as its code and its `tool` and the count; a wake that comes late, a timer held up by work on the event loop, waits for the next multiple the clock has not passed. At the fourth multiple a call still working has its signal aborted (every port call is handed `{ signal }`; the store cancels its statement and rolls back) and is answered `unavailable` at once, without waiting for the rollback. A fault anywhere in a call is answered `unavailable` at its deadline. `ping`, `initialize`, `tools/list`, the protocol errors, a call with no token and a name that is no tool are answered at once: none reads a row under a compartment (the client lookup reads `policy.clients`). `mcp_call`'s `durationMs` is the reply's, a multiple of the deadline; its `tool`, for a `tools/call` past the envelope checks, is a tool served or `unknown`, never the name sent; a refusal's `reason` and `argument` are fixed codes and a key of the tool's own schema, never a name or a method sent; a REST call refused before `handle` logs `http_refused` alone. `serveStdio` holds the `logs` it is given from the moment a line is complete until its reply is written: `pi mcp` passes its logger's hold, so every log line of a call, its own and the store's, reaches stderr after the reply.

Session taint: each session, a token and the MCP session id the client sent back, has a label in this process's memory, the union of the compartments its reads were under (the caller's clearance) and an integrity mark, untrusted once it read raw text (a `text`-budget tool: `read_message`, `read_item`, `get_document`, `get_evidence_span`, `fetch_template`, `read_meeting`). Before a tool offered is called, a session marked untrusted is refused any read when the client is cleared for a restricted compartment: `tainted_session`. Its free text to other agents (`post_agent_message`, `propose_task`, `write_back` with `note` or `tried`) is served and counted, for every client. A session whose label holds a restricted compartment is refused raw text: `private_session`. A refusal is recorded through `refused` or `refusedWork` with its code as the reason and answered with its fixed hint; over REST it is 403. The same checks against a private compartment that is not restricted only count a would-refuse. Each decision is counted through the ports' `taintLedger`, when given. `serveStdio` keeps one session's labels per serve; the HTTP routes keep theirs per server and answer an `initialize` with an `Mcp-Session-Id`; `handle` called without its own uses the process's, and `taint: false` turns it off, which only a test of what taint stops passes. Each token has a label too, the join of its sessions', kept in its own map: the two restricted refusals read the session's label joined with its token's, so a new session id, or a session dropped from memory, never starts a token clean; the shadow counts read the session's alone. A label is forgotten after 12 hours without a call, and at most 10,000 sessions and 1,000 tokens are kept.

- **May import:** `@intelligence/contracts`, its root and `./personal` entries, and nothing else in this repository.
- **Runs with:** no credentials of its own. It is handed a `PersonalReads` and a `PersonalWrites` port and a `PersonalWork` port (from `@intelligence/contracts/personal`, implemented by the store's `Reader` and `Work` in `pi`), a `PersonalLogger` and the client token.
- **Must never:** hold SQL or a key; decide a clearance; offer a tool outside the read tools, the write tools, the work and run tools, `draft_message` and Lens's `push_capture`; offer a tool that sends or say why a draft was held; follow, shorten or rewrite anything a message's text says; write anything but JSON-RPC to stdout; serve a tool over HTTP by any path but `handle`; put evidence text in a tool description, an error message or anything but a result's data fields; log a token, an argument value or a result value; import `zod`, the store, any database code, or any package of this repository but `@intelligence/contracts`.

## Tools served

Every name in `TOOL_NAMES` (contracts, `tools.ts`). The tool catalogue lists them.

## Exports

- `handle(ports, log, token, message, options?)`, with `ports` `{ provider, work, commit?, taintLedger? }`: one line of JSON-RPC in, one reply out, or `null` when nothing is sent. `options` is `{ clock?, sleep?, tally?, taint?, session? }`: `taint` the sessions' labels and `session` the MCP session id; `tally`, given by `pi http` alone, runs a call under the store's statement count and logs `tool_work`. `clock` and `sleep`: the clock deadlines are kept by and the wait, `performance.now` and a timer unless a test hands fakes.
- `serveStdio(ports, log, token, input, output, options?)`: newline-delimited JSON-RPC, one message per line, handled one at a time in order, so a second call sent at once is answered at the first's deadline plus its own. It resolves when `input` ends, and rejects if the input or the output fails. `options` is `handle`'s and `logs`, `{ hold(), flush() }`, held from the moment a line is complete and flushed once its reply is written.

- `serveHttp(ports, log, options?)` and `createRoutes(...)`: the same endpoint over HTTP, for `pi http`. `POST /mcp` hands its body to `handle`; `GET /v1/tools`, `POST /v1/tools/<name>` and `GET /openapi.json` are a `tools/list` or `tools/call` message handed to `handle` and its reply mapped to a status and JSON; `GET /healthz` answers `ok`. Every refusal of a token or a tool on the REST routes is `403 {"error":"not_permitted"}`; a 400, 404 or 422 (`unknown_role`) carries the tool result's details, its `hint` among them. A 64 KiB body cap, header and request timeouts, a per-address throttle of failed token checks, no CORS, and `options.held` for the read hold. An address is the socket's, or the last `X-Forwarded-For` entry only with `options.trustForwarded` (`PI_HTTP_TRUST_PROXY`), and every limit keys an IPv6 address on its `/64` (`addressKey`). With `options.oauth`, OAuth's limits (`oauth.ts`) are per address and per pending request as well as global: 10 pending requests from an address, 20 from an IPv6 /48 (`blockKey`) and 200 in all, five codes for each request, a request that spent them keeping its place until it expires, and no budget shared between requests, 10 registrations an hour from an address, 20 from a /48 and 100 in all, counting only those stored (one the store fails is given back). Requests are served concurrently; each `tools/call` still waits for its own deadline.

## Files

| File | What |
| --- | --- |
| `src/jsonrpc.ts` | Parsing, the envelope checks and the fixed protocol errors |
| `src/handle.ts` | The methods, the error table, the reply deadline and the one `mcp_call` log event per request. `hintFor`, the fixed hint every tool refusal carries (a claim refusal's, the tool's own, else the code's; a tool not offered, the code's: list the tools again); the program tools (`PROGRAM_TOOLS`) carry none |
| `src/deadlines.ts` | `DEADLINE_MS`, each tool's reply deadline: its tier, or a row where it is measured off it; and `MAX_MULTIPLES` |
| `src/tools.ts` | The tools, built from the contracts' rows: the one call each makes, which a client is offered, and the recording of a refused call |
| `src/tool-descriptions.ts` | Each tool's fixed description |
| `src/call-forms.ts`, `src/examples.ts` | The plain forms a first call sends, and the worked examples |
| `src/stdio.ts` | Framing: lines, the 1 MiB limit, end of input |
| `src/session-taint.ts` | Session taint: each session's and each token's label, their expiry, and the verdict on a call |
| `src/http.ts` | The HTTP routes and server over `handle` |
| `src/http-answers.ts`, `src/capture-route.ts`, `src/windows.ts` | What a route answers with, the body cap; Lens's admission to its larger body; counting by fixed window |

`handle.ts` and `tools.ts` are adapted from the team system's agent API.

## Adding a read tool

A tool is one row in the contracts; the ports, this package's table, the deadlines, compaction and the test fakes read from the rows. Before you start: keep each file under 800 lines. If a step below would push a file past that, split the file first, in a change of its own.

1. **Decide the shape.** The arguments, the result, the view, the budget and the order of every list.
2. **Contracts** (`packages/contracts/src/personal/`).
   - `tools.ts`: the row in `READ_TOOLS`: its view, and `list` or `text` (a text tool serves the text of an item asked for by id; anything else is a list). Give `compact` the paths of its result's beliefs, facts and pack items, when it has any; a result for a program, `compact: false`.
   - `tool-wire.ts`: the row in `READ_TOOL_WIRE`: its arguments and its result. The port's method follows from the name: `get_open_items` is `getOpenItems`.
   - The result schema in its own module (as `warmth.ts` holds `PeopleList` and `about.ts` holds `AboutView`), exported from the entry. Strict objects, and every value that came from evidence an `UntrustedString`.
   - When its refusals need words, its entry in `REFUSAL_HINTS` (`tools-refusals.ts`); each code has a general hint otherwise.
   - `handles.ts`: a `BESIDE_PATHS` entry only when the result carries a fact, a claim or a belief state an agent passes back that its `compact` paths do not say.
3. **Migration** (`db/personal/migrations/`, the next free number).
   - The call log and the read log reference that table, so without the row every logged call of the tool fails. `database.db.test.ts` holds the table to `TOOL_NAMES`.
   - A backfill, only when agents registered before the tool should get it. A client's tools are stored on its registration (`policy.clients.tools`), copied from the defaults when it registers, so a tool added to the defaults later never reaches an earlier agent by itself. They are stored, not computed from the defaults at each call, so that an agent the owner narrowed stays narrowed, and so that no store function that checks a tool has to change.
   - Every migration test applies over a populated database shaped like a deployed one.
4. **Store** (`packages/store/src/`).
   - `read/read-<tool>.ts`: the work function, `(ctx, args, client) => Found<T> | null`, with fixed statements only. When the tool is a new area of reads, name it in the `src/read/` row of the store's README.
   - Beside the read: a `<NAME>_TOOL: ReadTool<Args, Result>` constant (`core/read-tool.ts`) giving the tool's name, `parse` and `work`.
   - `read/read.ts`: the `Reader` method, one line, `return this.#read(<NAME>_TOOL, token, args, options);`. `#read` checks the token, the client, the tool and its view, parses the arguments, counts the budget, and writes the read log and the call log, so `work` does none of that.
   - `admin/clients/admin-clients.ts` in the store: nothing, for a built tool. `DEFAULT_AGENT_TOOLS` is every read tool not on `UNBUILT_READ_TOOLS`, so a new agent is given it at registration. Only a tool that lands before anything serves it goes on `UNBUILT_READ_TOOLS`, which `admin/admin.test.ts` pins.
5. **Agent API** (this package).
   - `src/tool-descriptions.ts`: the description, a fixed string of at most 600 characters built from the shared sentences (`UNTRUSTED`, `FORM`, `STALE`, `HIDDEN`), never evidence text.
   - `src/deadlines.ts`: nothing until it is measured: a text read takes `ONE`, any other read `WIDE`.
   - Tests: a call and a sample value in `TOOL_CALLS` (`src/test-support/handle-fixtures.ts`), which the `src/handle-*.test.ts` files read; `ARGS` in `src/quota.test.ts`, when a valid call takes arguments.
6. **Security tests**, in the store's `src/read/*.db.test.ts`. For the new read:
   - an id that does not exist and one the client cannot see answer the same `not_found`, with the same statements;
   - rows the client cannot see change nothing it gets: the answer is byte-identical with and without claims under a compartment it is not cleared for;
   - every statement that can return more than one row ends in an `order by` that includes a unique key;
   - a client cleared only for `public` gets nothing from `own` rows, and its counts and order are an empty store's;
   - a subject, a title or a body that holds instructions comes back as data under `{ untrusted }` and changes nothing else;
   - a message held as account-recovery mail, and an item erased, leave nothing in the answer; a read over a new table needs that table's row in `ERASURE_HOOKS` (`erasure/erasure-hooks.ts`);
   - a client without the tool's view gets `not_permitted`.

The asks of `core/read-tools-hidden-rows.db.test.ts` take a new read that reaches for the world's rows.
7. **Optional.** The tool's words in the owner's web app (`apps/web/src/agent-words.ts`), and a `pi measure` command when its cost needs watching.
8. **Run** only what the change touches:
   - `pnpm exec vitest run --config vitest.config.ts <each unit test file touched> tests/structure`;
   - each database test file added or changed, one at a time: `pnpm exec vitest run --config vitest.db.config.ts <path>.db.test.ts`;
   - `pnpm typecheck` once, at the end.

A call's arguments first pass `callForm` (`src/call-forms.ts`), which turns a plain form a first call sends, such as another tool's name for an id field or a ref as a bare id, into the tool's own arguments. The tool's strict schema and every check after it then run as they would on any call.
