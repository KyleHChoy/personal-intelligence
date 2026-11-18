# Security

Personal Intelligence holds one person's mail, documents, calendar and contacts, and lets agents read parts of them. A flaw here exposes someone's private life, so reports are welcome.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: the "Report a vulnerability" button on this repository's Security tab. Please don't open a public issue. Say what you found, how to reproduce it, and what an attacker gains.

## The core rule

<!-- core-rule -->**The core rule:** no agent or person learns anything from the system that its clearance does not cover, unless the owner released it. Five things are outside that rule by design: the model vendor reads each item it extracts; an agent can pass on what it was cleared to read; an agent's research fill about a person is stored under the owner's own data (`own`), with no card; while the owner's standing close release is on, an agent's close of a commitment is stored under the commitment's own label, with no card; and an agent cleared for an owner question can record the owner's answer to it, verbatim, with no card.<!-- /core-rule -->

## What it protects

- An agent reads only what its clearance covers. The database derives the clearance from the agent's token, and row-level security and the database's own functions hold every read to it.
- Content is encrypted at rest under a key per compartment, so a stolen database or dump without the key file does not reveal what any message, document or fact says. Its shape does show: ids, times, kinds, labels, and keyed fingerprints of addresses, domains and threads, so a reader can see when the owner exchanged mail, how often, and that two rows name the same correspondent, but not who that is or what was said.
- Text from mail, documents and the web is data. No code follows it, and a model's output can only narrow who sees something.
- No message is sent without the owner. Drafts pass an outbound gate when made and again at send, and only the send process, a Unix user of its own, holds the send credentials.
- An erasure removes everything derived from the item, and holds after a database restore, because the erasure journal on the box's volume is replayed first. The replay is tested in code; a restore of a running box from a dump has not been drilled.

A way around any of these is a vulnerability.

## What leaves with no owner step

No message leaves without the owner, but this data does, by design:

- **Item text, to the model vendor** configured for triage and extraction, one item per call, with data collection denied on OpenRouter requests.
- **What an agent reads, to that agent's vendor,** within its clearance.
- **Memory adapter writes** into an agent vendor's own memory, within the agent's clearance.
- **Agent messages** between agents that share compartments, and the read-only tasks they hand each other. Labels limit who receives them; the owner does not see them first.
- **Work notices** to an agent's registered webhook: ids and codes only, signed.
- **The reasoner's web searches and page fetches,** when the owner turns them on. A query is written by the model and may hold names it read. Each is recorded; none is gated.
- **Anything Claude Code in the box sends.** It runs as its own user with an unrestricted network. It reads only through the agent API, under its clearance, but what it reads it can send anywhere.

## What agents may file with no card

Most of what an agent proposes waits for the owner as a card. These do not:

- **A research fill about a person** is stored as claims under `own`, so every agent cleared for `own` reads it.
- **A commitment close,** while the owner's standing close release is on, is stored under the commitment's own label.
- **The owner's answer to a question.** An agent cleared for an owner question can record the owner's answer, verbatim, with no confirm card (`packages/store/src/cards/answer.ts`). The system cannot tell whether the words it records are really the owner's.

## What an agent may answer for the owner

Off until the owner names a question role (`pia work route --questions ROLE`). While one is named, a card of the kinds in `CARD_RELAY_KINDS` (`packages/contracts/src/personal/card-relays.ts`) is asked through an agent in that role, and that agent may relay the owner's answer:

- The agent quotes the owner's words and names the option they mean. The quote is the agent's statement of what the owner said. Code checks only that it holds a word and is not the card's own text; it cannot tell whether the owner said it.
- The answer is applied as the owner's, marked as relayed, with the agent and the time. The quote is kept sealed with it.
- A card that releases, sends, pays or grants is never asked this way (`CARD_RELAY_NEVER`, in the same file): the owner answers it directly.
- The owner sees every relayed answer (`pia cards relayed`) and can undo each one (`pia cards reopen`).

So an agent in the question role that is misled or compromised can answer those kinds of card as the owner until the owner looks.

## Supported configuration

The latest commit on `main`, run as the container image in `deploy/` on a host you control, with Postgres on a private network.

## Limits to know before you deploy

- Whoever runs the host can read everything. The key file sits on the same volume as the data.
- Google refresh tokens are sealed in the database under the key file. The key file plus a database dump is therefore not only everything synced so far but live, read-only access to every connected mailbox and calendar, until the owner revokes the grant in the Google account.
- The image downloads Claude Code (from npm) and Tailscale (from Tailscale's package server) at build time. Each download is pinned to a version and checked against a hash written in `deploy/Dockerfile` (Tailscale's published SHA-256, npm's sha512 integrity for Claude Code), so a changed file fails the build; trusting those hashes is trusting the vendors that published them.
- On first start the Tailscale login link is printed to the container's log. Anyone who can read that log before the owner uses the link can join the box to their own tailnet. Use the link at once, and keep the host's logs private.
- The agent API's narrowed copy of the key file only grows. When a client is revoked, the compartment keys it was cleared for stay in the copy, because a running `pi http` refuses a key that goes away (`apps/pi/src/agents/agent-keys.ts`). No command shrinks the copy today, so after revoking a client with a wide clearance, treat the agent API's user as still able to open those compartments.
- The pipeline reads every compartment, and item text goes to the model vendor you configure for extraction.
- An agent can send whatever it is cleared to read to its own model vendor. Clearing an agent for `own` gives it the owner's mail and, until the restricted categories are built, health, money and legal facts too. That is why a new registration is narrow.
- A model screens for injected instructions only when `PI_DECIDE_MODEL` is set, and it can miss. The bounds above are what hold when it does. Agents can message each other with no owner step in between, so one misled agent can mislead another.
- The internet-facing `pi http` runs as `pimcp`, the same user that owns the agent token files (`deploy/bin/pi-token`, `deploy/lib/mcp-run`) and a narrowed copy of the key file. A remote code execution bug in `pi http` would expose those tokens, and with them what any registered agent is cleared to read.
- `pi http` speaks plain HTTP. Put a TLS-terminating proxy in front of it, and set `PI_HTTP_TRUST_PROXY=1` only if that proxy appends the caller's address to `X-Forwarded-For`; otherwise a caller can choose the address every limit is keyed by.
- The box's connection to the database is encrypted (`sslmode=require`) but checks no certificate until the owner installs the database's CA, which turns on `verify-full`; until then a box health card, `tls_unverified`, stands.
- Invariant 6, that nothing a client cannot see changes anything it sees, is not fully held for timing: some reads still take longer when hidden rows exist. The known residuals are marked as expected failures in `packages/store/src/core/reader-work-plans.db.slow-test.ts`.
- An erasure cannot recall what a model vendor or an agent's vendor already received.

## Test keys

The tests contain made-up keys and tokens used as test vectors. None of them is real.
