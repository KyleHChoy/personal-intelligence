# @intelligence/personal-core

What the shared connectors and claim pipeline lack for one owner's mail and calendar: the `RawItem` builders the Google connector and the fakes share, a message with its full text, the item facts the writer keeps, read by running the shared pipeline's parse and header reading, calendar events and their meeting records, the frozen part of a context pack, and the fakes and the synthetic world every personal test uses. No network, no database, no keys, no model.

- **May import:** `@intelligence/contracts`, and nothing else in this repository. It also uses `postal-mime`, `html-to-text` and `unpdf`, the parsers of `src/claim-pipeline/`.
- **Runs with:** no credentials. It reads seven files under `ontology/`, each once, the first time it is needed:
  - `public-suffix-list.dat`, the vendored public suffix list, when a domain is first folded;
  - `warmth.json`, the warmth rules, by `warmthRules`;
  - `relations.json`, the relation rules, by `relationRules`;
  - `contact-quality.json`, the contact quality rules, by `contactQualityRules`;
  - `activity-categories.json`, the activity categories, by `activityTable`;
  - `autonomy.json`, the autonomy windows, by `autonomyRules`;
  - `second-degree.json`, the second-degree weights, by `secondDegreeRules`.
- **Must never:** make a network call, read an attachment's bytes or an event's description, follow anything a header or a body says, take a person, a name or a time from a body, decide that two different addresses are one person, call a model, log a header value or any text, let a sentinel label or key leave memory, or choose what a client may see.
- **Entry points:** the root, `@intelligence/personal-core`, for the base, one subpath for each feature, and `@intelligence/personal-core/testing` for the fakes and the world (see "Layout").

## Layout

The base is the files directly in `src/`: what every personal package shares and what changes rarely. Units (`units.ts`), days and times (`days.ts`), hashing (`hash.ts`), ordering (`compare.ts`), the clock, value checks, canonical JSON (`json.ts`), the owner, item ids, limits, addresses, domains and the public suffix list, identity keys (`profile-key.ts`), text normal forms (`text.ts`, `key-phrase.ts`, `own-dates.ts`), credential masking and the repository's files. The root entry serves it.

Each feature is a folder with its own entry, its barrel the folder's `index.ts`:

| Entry | Folder | What |
| --- | --- | --- |
| `/items` | `src/items/` | Source items: the Google, contact, document, Lens-contact and agent-person item builders, their derivation into the facts the writer keeps, and the connector types. |
| `/lens` | `src/lens/` | Lens and work time: captures, anchors, activity, the moment lane and the work-time engine. |
| `/views` | `src/views/` | Read-time views of knowledge: facts, lines, people, context packs, the memory view, open items, next moves, paths and warmth. |
| `/planner` | `src/planner/` | Planner and ledger policy: gaps, frontier, levers, autonomy, outcome flow, merges and re-asking. |
| `/checks` | `src/checks/` | Checks on what agents write: claim intake, kind checks, phrase similarity, people intake and inbound memory. |
| `/outbound` | `src/outbound/` | What leaves: the send gate, disclosure and the canonical send payload. |
| `/research` | `src/research/` | The research lane: its gate, URLs, robots rules and fetched pages. |

A base file imports no feature. A feature imports the base, and only two import another feature: `planner` imports `items` and `views`, and `research` imports `items`.

## What it does

- Builds the `RawItem` of a Gmail message, at depth `full`, and of a calendar event, at depth `headers`, and the `SourceDeletion` of a deleted event. A message's payload is its message block: its listed headers, its text, its HTML and one line of facts for each attachment (name, type and size), written as the `message/rfc822` bytes the shared parse reads. An attachment's bytes are never held.
- Turns a stored item into the facts the writer keeps (`deriveItem`). An email is read by the shared `parse` and `interactionFor`, through an in-memory `PipelineItem` whose label and key are sentinels that verify under no key. This package adds Gmail's bulk signals, the owner (outbound means the `SENT` label without `SPAM`, and the owner is never a counterpart), display names and the subject. A calendar event is read here, and gets a meeting record.
- Reads a message's text through the shared parse, HTML included: the plain part, or the HTML as text when there is none. The text is kept for reading and takes no part in who a message is from or to: no person, name or time comes from a body. A body the parse refuses leaves the message read by its headers, marked unreadable, with its people.
- An item whose headers the shared parse refuses, or an event that cannot be read, is `unread`: its evidence is kept and nothing is derived. A bulk message resolves nobody, and still has its message facts.
- Reads whether a message authenticates for its From domain (`mailAuthOf`): `pass` for an aligned DKIM, SPF or DMARC pass in the topmost `Authentication-Results` header, `fail` when that header holds none, `none` without it; carried as the message facts' `auth`.
- Says which messages are junk (`isJunk`): anything under Gmail's Spam label, and one under Promotions that the owner did not send. Sync stores nothing of it, not even evidence. Updates is bulk and no junk.
- Says which messages are conditional (`isConditional`): one under Social or Forums that the owner did not send. Sync stores it only when the owner has written to its sender or posted in its thread.
- Fixes a context pack's envelope (`packs.ts`): the versioned templates, each section's view, whether it is required, its cap and, for `notes`, its cut; the assembly, which keeps sections in the template's order, cuts a required section in its given order and says so in `truncated`, and asks a selector only which optional items to keep; and the hash, over the pack's JSON with sorted keys. A template version never changes, and the test pins its hash. What a selector may vary is which optional items of a section are kept, inside that section's universe and cap; an answer naming an id outside it, an id twice or more than the cap is discarded for the code order, and kept items stay in the universe's order. Nothing here reads an item's value or chooses which rows a client may see: the reader's queries do, under the client's token.
- Fixes the outbound memory adapter's view (`memory.ts`): the versioned template, the assembly that cuts each section to its cap in the order given, the canonical values the store hashes for a projection id, the rendering of the one file the adapter owns, and `findStamps`, which reads the stamps back. Every character it writes is a fixed word, an id, a date or a number: no word from a source.
- Builds a Drive file's `RawItem`, with no sender, no addressees and the owner's own address as the only one who can see it: a file's sharing is not read. Its payload is a document block: one HTML document built by code from the reading, whose head holds the file's facts as the base64url of their JSON and its name as the title, and whose body has one element for each heading, paragraph, list item and table row, text escaped. It is a rebuilt rendering, not Google's bytes.
- Reads a document's facts: the file facts from the block's head, which this package wrote, and the text and sections from the shared parse, read by sections. The value handed to the parse, and only that value, carries the sentinel reference kind `register`, which reaches no stored value. Nothing in a document's text makes a person, an alias or an entity. A document is held by the same recovery markers as mail, matched against its title and first 2 000 code points, with no sender.
- Cuts a document's sections into passages for extraction.
- Walks find_paths' routes (`findPaths`, adapted from the team system's path walk): from the owner, through a person the owner has an own tie to, over the ties and affiliations it is handed, with the team system's bounds and a `cut` that says one stopped it. It reads no database, key or clock.
- Measures warmth (`warmth.ts`): `warmthOf` turns one person's direct messages and kept meetings into `active`, `depth`, `warmth`, two-way contact, responsiveness and channels, days in the owner's zone, in one forward pass, with the same fields as of `hysteresisDays` ago; `rankAudience` cuts one audience into tiers by rank, the owner's closeness labels first, the better of now and then served, and marks `dormant`. Pure; the rule table is `ontology/warmth.json`, read once by `warmthRules`.
- Checks a contact's organizations, titles and addresses before they become claims (`contact-quality.ts`): no organization from a domain, a provider's domain or a headline, no role from a headline title, and no claim from a function's mailbox, under `contact-claims@3` and `contact-import@5`.
- Marks account-recovery mail as held (`recoveryHold`): a password reset, a sign-in link or a one-time code, matched by a fixed, versioned list of terms and sender local parts (`RECOVERY_MARKERS`). The message is stored and derived as any other, and no client is given it until the owner releases it. Code only, and provisional until the owner confirms it.

## What it exports

| Export | What |
| --- | --- |
| `GmailMessage`, `Attachment`, `CalendarEvent`, `CalendarTime`, `CalendarPerson` | Types: what the Google connector reads of a message, an attachment and an event. |
| `ListingMark`, `PersonalPage`, `PersonalConnector`, `ConnectorOptions`, `PersonalSource` | Types: a page and a connector as sync takes them. A `PersonalConnector` is a shared `Connector`. |
| `ItemContext`, `ItemMembers`, `ItemFacts`, `MessageFacts`, `EventFacts`, `Person` | Types: what the writer hands `deriveItem`, and what it keeps of an item. `MessageFacts` is what it keeps of every message for the message tools: its subject, time, sender, category, text, attachments, whether it is unreadable or held, and its `Message-ID` and `References`. |
| `THE_OWNER` | The owner, wherever a shared shape names a member. |
| `normalizeAddress` | An address trimmed and lower-cased, or `null`. |
| `organizationDomain`, `organizationOfDomain`, `mentionOrganization`, `foldDomain`, `consumerDomain`, `CONSUMER_DOMAINS` | An address's, a domain's or a `domain:` mention's organization: its registrable domain, or `null` on a provider's domain (free mail, internet providers, relays, hosting). `foldDomain` is the key a domain is matched under, by the vendored list alone. Tests fold the synthetic data's documentation domains apart with `useDocumentationFold` (`src/test-support/domains.ts`, through the seam `useRegistrableDomain`), installed by `src/test-support/fold-setup.ts`. |
| `registrableDomain`, `registrableDomainIn`, `parseSuffixRules`, `publicSuffixRules` | The public suffix list's algorithm over the vendored list, or over rules a caller parses. |
| `headerBlock`, `messageBlock`, `gmailItem`, `calendarItem`, `isBareCancellation` | The `RawItem` builders: a Gmail message as a full-depth item whose payload is its message block, a calendar event as a headers-depth item, and a deleted event as a `SourceDeletion`. |
| `headersOnly`, `attachmentsOf` | A message block read back: its headers alone, and the attachment facts it carries. |
| `gmailLink` | The link that opens a message's conversation in Gmail, from Gmail's own thread id alone, or `null`. |
| `whitelistedEvent` | The one reading of the calendar whitelist: a value as a `CalendarEvent` with the whitelist's keys and nothing else, or `null` when a field has the wrong type. The Google connector, `calendarItem` and `deriveItem` all read an event through it. |
| `PERSONAL_LIMITS`, `EXTRACTOR_GENERATION` | The limits the shared parse runs under for a personal item, and the generation its request ids are made under. |
| `isDraft`, `personalBulk` | A draft, which sync drops, and Gmail's own bulk signals, which add to the shared `automated` rule. Social and Forums are no bulk signal for a sender the owner has written to. |
| `automatedAddress` | A machine's address by its shape alone: a no-reply mailbox, in any case, or one that says "unsubscribe" anywhere. `get_self` ranks such a contact last. |
| `ownerSent` | The one test of "the owner sent it": a message under `SENT` and not under `SPAM`. |
| `isJunk` | Junk, which sync never stores and removes when it is stored: a message under `SPAM`, whatever else it carries, or under `CATEGORY_PROMOTIONS` when the owner did not send it. |
| `isConditional`, `isConditionalLabels` | A conditional message, of an item and of its labels alone: under `CATEGORY_SOCIAL` or `CATEGORY_FORUMS`, not one the owner sent, and not junk. |
| `messageCategory` | Where Gmail filed a message: `promotions`, `social`, `forums` or `updates`, else `primary`. |
| `whitelistedContact`, `contactItem`, `contactItemId`, `contactDeletion`, `contactKept`, `CONTACT_LIMITS`, `REFUSED_MARKER` | A saved contact: the one field-by-field reading of a People answer's person, its addresses read strictly; the `crm` item and deletion built from it; and `contactKept`, which sync asks before the writer: `no_address` and `own_contact` are never stored. `deriveItem` reads a contact with code alone, never the claim pipeline: its addresses become people one by one, and only a one-address contact's names become aliases. No address on a contact links to another. |
| `byText` | Text compared by code unit, as the database sorts under the "C" collation. The one text comparison of personal code (`compare.ts`). |
| `sha256` | The hex SHA-256 of text, read as UTF-8, or of bytes. The one hex digest of personal code (`hash.ts`). |
| `systemNow` | The one real clock, the default where a module is handed none (`clock.ts`). |
| `gmailItemId`, `parseGmailItemId` | A Gmail message's source item id, `gmail-id:<id>`, and its inverse. Every place that builds or reads one calls these. |
| `sendGate`, `revealedClaims`, `canonicalPayload` | The outbound gate, its disclosure check at rung 0 and a payload's canonical bytes: pure, no clock, file, database or network. |
| `revealedContacts` | Pure. Called by the store's draft and send checks. |
| `contactClaims` | Pure. |
| `parseCsv`, `readContacts`, `dateOf`, `importItem`, `importClaims`, `importClaimCounts` | Contact import: RFC 4180 read leniently; a contact file read by an adapter (`linkedin-connections`, `google-contacts-csv`, `mapped-csv` with the owner's mapping) into records and per-row refusal codes; a record as a saved contact's `crm` item with its further fields as `imported`; and the role and affiliation claims code makes from an imported contact (current and past roles, boards, schools, `works_at`), with the row's confidence and standing. Pure. |
| `profileKey`, `isProfileKey`, `PROFILE_KEY_PREFIX` | A LinkedIn profile URL folded to an identity key, the one identifier of an imported row with no address; `isProfileKey` checks a key's exact shape. |
| `canonicalUrl`, `isPrivateUrl`, `idShaped` | The research lane's URLs and identifiers: a page URL's canonical form; whether a URL has a query, a fragment, a user part, a port, a percent byte or a token-shaped segment; and whether an identifier is shaped like an id (adapted from the team system's research check). |
| `researchGate`, `filingAnswer`, `resolveQuery`, `sealCandidates` | The research gate: every check run and every cause returned, from facts the caller gathers, with no clock, file or network; the map from causes at filing to a client's answer (`vetoed`, `erased` and `sealed` give none); a search's query, the template's words and the values in order; and the host and domain names a seal on which stops a request. |
| `pageItem`, `pagePayloadForParse` | A fetched page as a `web_research` item, and what the shared parse is handed for it: HTML unchanged, a `text/plain` body escaped into one `<pre>`. `deriveItem` gives a page its page facts, from the request the context names, and resolves nothing on it. |
| `robotsDisallow`, `robotsAllows` | robots.txt read by code: the `User-agent: *` groups' `Disallow` rules from the first 500 lines, and whether a path may be fetched. |
| `warmthOf`, `rankAudience`, `warmthRules`, `WarmthMessage`, `WarmthMeeting`, `WarmthInput`, `WarmthFields`, `RankInput`, `RankedTier` | One person's warmth fields, one audience's served tiers and dormant state, and the rule table. |
| `RECOVERY_MARKERS`, `recoveryHold` | The fixed list of recovery markers, with its version, and whether a message's subject, sender and text match it. |
| `derivingLabels` | The labels among a message's that its derived rows depend on: `SENT` and the bulk markers. A Gmail item's revision tag covers them, and the connector reads a label change only when it touches one. |
| `membersOf` | Who of the owner is on an item: always a participant, and its sender when the owner sent the message (`ownerSent`) or organizes the event. The writer checks facts' members against it. |
| `pipelineItemOf` | The in-memory `PipelineItem` the shared functions take, with its sentinel label and key. |
| `namesOf` | The display names and the subject of a message's headers. |
| `passageOf`, `KeptTexts` | The passage a fact cites: the segment its span falls in, from the body and subject the store keeps, read again by the shared `parse` and `segmentAt` over a message block the shared builder writes from them. A span over an attachment, or past the text, has none. |
| `recordPassageOf` | A finding's passage: an agent record's body is one segment, `chars:0-<length>`, as the extract lane reads it, so a span inside it gives the whole body and one outside it none. |
| `readEvent`, `meetingRecord` | What an event says, and its meeting record, with every participant but the owner resolved through the identity port. |
| `deriveItem` | The whole path: one stored item to its `ItemFacts`. |
| `PACK_TEMPLATES`, `templateFor` | The context pack templates, deep-frozen, one entry per purpose and version, and a purpose's highest version. |
| `assemblePack`, `selectInOrder`, `SELECTOR_IN_ORDER`, `packHash` | A pack from a template and each section's items as the reader read them; the code selector and the name it is logged by; the pack's hash. |
| `PackTemplate`, `PackTemplateSection`, `PackInput`, `Selector` | Their types. |
| `MEMORY_TEMPLATES`, `memoryTemplate`, `assembleMemory`, `entryValues` | The memory templates, deep-frozen, the highest version, the assembly and what a projection id is hashed over. |
| `OWNED_HEADER`, `renderEntry`, `renderBlock`, `findStamps` | The owned file's first line, one entry's line, the whole file, and the stamps read back from a text. |
| `MemoryTemplate`, `MemoryTemplateSection` | Their types. |
| `DriveFile`, `DrivePerson`, `DocBody`, `DocBlock`, `DocumentFacts`, `Passage` | GD's types: a Drive file as the connector reads it, a Google Doc's reading, what the writer keeps of a document, one passage. `PersonalPage` has `left`, and `ConnectorOptions` `roots` and `stored`. |
| `DRIVE_READING`, `documentKind`, `driveRevisionTag`, `documentBlock`, `driveItem`, `documentTooLong`, `documentLink` | The reading rules' version; a file's kind; its revision tag; its block and item; whether the shared parse would refuse a reading's block; the link that opens a file, from its id and kind alone. |
| `documentPassages`, `PASSAGE_CHARS` | A document's sections as passages of at most 4 000 code units, cut at paragraph ends, then white space, never inside a surrogate pair. |
| `findPathsWithObserved`, `ObservedVia`, `ObservedSeen`, `StatedVia` | The stated walk, then the walk with hops code observed, every stated path first |
| `findPaths`, `MAX_PATHS`, `MAX_LINKS`, `MAX_STEPS`, `Tie`, `Affiliation`, `Path`, `PathHop`, `PathInput` | find_paths' walk: every path starts with the owner's own tie, `maxHops` counts it, each hop cites fact ids, shortest first then by entity id, at most 20; at most 5 000 ties and 5 000 affiliations, the first by entity id, and 10 000 neighbours looked at. |
| `ownStatement` | Whether a claim about the owner is one of the owner's own facts: the owner is its speaker, its basis is `explicit_self`, and it is a statement, a decision or a reversal. The extract package's belief rules and the store's `get_self` and `pi self review` read it. |
| `SHORT_TIME_WORDS`, `saysShortTime` | The pinned same-day and next-day words (today, tonight, tomorrow, tmrw, this morning, this afternoon, this evening, right now), and whether a text holds one as a whole word or phrase in any case. The extract package's belief build reads them to leave out a question that is logistics, not a lasting need. |
| `byBeliefOrder`, `BeliefOrder` | `compileFacts`' order of beliefs (kind in its subject kind's order, open first, latest confirmed, fact), which `get_beliefs` applies to beliefs of several subjects, every one ranked by the People view's kinds. |
| `matchWords`, `matchScore`, `isMatchSide`, `byMatch`, `MATCH_SIDES`, `MatchMode` |  |
| `viewKindOf`, `VIEW_KINDS`, `ViewKind`, `ViewOntology` | Which view a type's claims belong to: the shared `viewKindOf`, copied, never imported, held equal to its answers by a pinned table. |
| `placeholdersOf` | fetch_template's placeholders: every `{{name:kind}}` of a text, in order, with its ordinal, at most 100; a name is trimmed, and one of white space alone is none. |
| `strictAddress` |  |
| `captureBlock`, `captureFacts`, `CaptureFacts`, `meetingText` | Lens's items: an item's canonical JSON as UTF-8, the payload sealed in the vault; what `knowledge.captures` seals, mentions and counts and no text; a meeting's segments as `S<n>: text` lines with each `seg:<i>` span. |
| `meetingOwner` | Whether a meeting's mention is the owner, decided before any name or address is matched: an address of the owner's, or with no address a name the meeting knows the owner by (its owner-marked speaker's, or any mention's with the owner's address). Names are folded as the store's name fingerprint folds them. A namesake loses. |
| `SERVED_ID_PREFIXES`, `systemIdIn` | A store test checks every `IdPrefix` is on the list. |
| `mirrorValue`, `mirrorEntryValues` | The mirror: a value with every `Who` cut to its entity id, and an entry's canonical JSON without its stamp, which the store hashes. |
| `renderLine`, `HELD_PHRASE` |  |
| `rankLines`, `sectionOf`, `AFFILIATION_SECTIONS`, `collapseByGroup`, `buildSections`, `SectionedLine` | D19: one belief of each joined set, the highest tier; the self page's sections, cut to ten lines and five people. |
| `DOMAIN_KEYWORDS` |  |
| `phraseSimilarity`, `SAME_FACT_SIMILARITY` |  |
| `deviceAnchorKey`, `captureMatchKeys` | The device anchors: an anchor's normal form or its refusal, and an item's match keys from its own fields, each `<kind>:<normal form>`. |
| `normalTitle`, `titleMatchKeys`, `titleKeysOf`, `titleTooDeep` | `captureWorkOf` seals them given the store's `TitleSeal` (`titleFpsOf`, memoized by app and title; `sealedTitle`), with a block title's name fingerprints once a day (`withTitles`, also the catch-up's and the erasure's); `creditBlock`'s step 4b reads them, its credit of basis `title`. `titleTooDeep`: whether a title anchor lies past the twelve kept prefixes, which `deviceAnchorKey` refuses `bad_anchor`. |
| `blockMatchKeys`, `creditBlock`, `WORK_TIME_RULE` |  |
| `captureWorkOf`, `attributeCheck`, `lineCount` | Work time's drain half: what the drain seals in `knowledge.captures.work_enc` for one item, the attributes it keeps and drops by method, a block's category from the box's table, a moment's new lines. |
| `workTime`, `workWindows`, `creditIntervals`, `sessionsOf`, `deepWorkOf`, `matchWorkedOn`, `fitWorkNow` and their parts | Work time's read half: every view (`get_self`'s `work`, a day's half-days and deep work, a project's time and timeline, worked-on minutes) computed at read from the rows, links, anchors and projects the caller's token returned, and the union of windows a read must gather. The views and windows are in `work-time.ts`, the read's inputs, credited sub-spans, sessions, task state and worked-on matching in `work-time-credit.ts`, deep work in `work-time-deep.ts`, and the helpers they share in `work-time-units.ts`. Pure; stores nothing. |
| `categoryOf`, `activityDay`, `activityTable`, `parseActivityTable` | The activity categories of `ontology/activity-categories.json` (read once), a surface's category by its most specific row, and one local day's minutes by category from its blocks; a view, never stored. |
| `momentBatchCutoff` | The latest 00:00 or 12:00 on a zone's clock at or before an instant, which the batched moment lane reads to. |
| `codePoints`, `DAY_MS` | The length of a text in code points, which every text limit counts (`units.ts`, which also holds `tenths`), and a day in milliseconds (`days.ts`, which also holds the minute and hour, `daysBetween`, the day of an instant, `wallInstant` and the month and weekday words; `values.ts` holds the builders' shape checks and `unique`, inside the package). |

## The testing entry point

`@intelligence/personal-core/testing` (`src/testing.ts`, over the modules in `src/test-support/`, which no production module imports) is what personal tests use for synthetic data. Everything is in memory and deterministic: no random value, and no clock read but the `now` a fake is given. Reserved domains only, but for one group-calendar attendee on Google's calendar system domain.

| Export | What |
| --- | --- |
| `world({ now })` | The synthetic world: one owner, a `personal` and a `work` account, their mail, events and Drive placed relative to `now`, the canaries (and `documentCanaries`), the handles a test looks items up by, and the expected gate answers, written by hand (`expected.documents` for the Drive). A world Drive has two roots of the personal account, one reference, one root of the work account, files of every kind, a document outside every root, one held document and one shared by an address on `example.org`. |
| `fakeGmail(account, { now, pageSize?, order? })` | One mailbox, with the pages the Google connector would hand over: listings that stop at the window or run to the end, live history, expiry, and the controls `add`, `trash`, `relabel`, `deletePermanently`, `expireHistoryBefore`, `forbid`, `goneAtGet`, `failAt` and `calls`. A listing pages over the mailbox it had at its first page. |
| `fakeCalendar(account, { now, pageSize? })` | One calendar: listings that keep the `since` and the set of events they started with, sync tokens, expiry, and the controls `upsert`, `remove`, `expireSyncTokens`, `failAt` and `calls`. |
| `fakeDrive(account, { now, pageSize? })` | Its controls are `createFolder`, `put`, `edit`, `move`, `trash`, `restore`, `deletePermanently`, `unshare`, `moveFolder`, `trashFolder`, `forbid`, `tooLarge`, `goneAtGet`, `failAt`, `calls` and `fetched`. |
| `fakeSources(world, options?)` | One `PersonalSource` per account over its fakes, in the shape sync takes, with the fakes on it as `gmail`, `calendar`, `contacts` and, for an account with Drive roots, `drive`. `contacts` names the labels whose People fake answers; another label's source refuses `google_contacts`. |
| `LINKEDIN_CONNECTIONS`, `GOOGLE_CONTACTS`, `GOOGLE_CONTACTS_OLD`, `RESEARCH_SHEET`, `RESEARCH_SHEET_MAPPING`, `csvOf` | Synthetic contact files for the contact import's tests: LinkedIn's export with its notes, Google's two CSV forms, and a research sheet of people, households and venues with the mapping that reads it. |
| `fakeContacts(contacts, { now, pageSize? })` | One label's saved contacts, with the pages the People connector would hand over: a listing, then changes by sync token, expiry, and the controls `upsert`, `remove`, `expireSyncTokens`, `failAt` and `calls`. The world's accounts carry their contacts. |
| `fakeProvider({ clients, answers? })` | The reads, writes and work ports at once, for the stages built against the contracts before the store serves them. It answers as the ports say: `unauthorized` for a token it does not know, `not_permitted` for a tool or view the client lacks (a pack's purpose view included; `record` needs none), `invalid_request` for arguments the tool's schema refuses, then the tool's scripted answer, checked against its strict result, or `unavailable` with none. `refused` and `refusedWork` decide their code from the registration. `calls` records every call in order. A scripted value that is not the tool's result throws. |
| `fakeWeb({ search?, pages, robots })` | The fetcher's line protocol answered from a recorded web: searches by query (`no_provider` with no `search`), pages and robots files, answered as the fetcher answers (no redirect followed, text only, 1 MiB and 64 KiB bounds, 404 and 410 `gone`). `requests` records every request as given. The world's `research` holds the research subjects (one under `own`, one under `employer:example`), their mail, kept out of the accounts' mail so no count changes, the links, the web and each page's expected claims. |
| `fakeTurnModel(replies)` | The reasoner's model: each turn checked as a `TurnRequest` and recorded in `requests`, answered by the next reply in order, checked as a `TurnReply`; an `Error` in the list is thrown in its turn, and past the last reply every turn throws `unavailable`. |
| `fakeLens({ now })` | Lens's device `mac`: its meetings, moments, a block day under two compartments and forgets, each with its handles and a canary; the world holds it as `lens`. `LensWorld`, `LensHandles` and `LensScopeRule` are its types. |
| `FailureKind` | How `failAt` makes a call fail: `unavailable`, `rate_limited`, `oauth_failed` or `not_found`. |
| `World`, `WorldAccount`, `WorldHandles`, `WorldDrive`, `WorldDocument`, `FakeGmail`, `FakeCalendar`, `FakeDrive`, `FakeDriveFile`, `FakeProvider`, `ProviderCall`, `ScriptedAnswer` | Their types. |
