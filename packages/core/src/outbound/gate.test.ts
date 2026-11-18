import { GateCheckKind } from "@intelligence/contracts";
import {
  GATE_CAUSE_CHECK,
  type GateCause,
  GateInput,
  GateOutcome,
  type GatePhase,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { sendGate } from "./gate.ts";

// The outbound gate's tests. Made-up facts only.

// The nine checks, in the order of the shared GateCheckKind.
const CHECKS = [
  "authority",
  "vetoes",
  "conflict_lists",
  "contact_policy",
  "disclosure",
  "freshness",
  "consent",
  "channel_cap",
  "payload_hash",
] as const;
type Check = (typeof CHECKS)[number];

// Facts and inputs for which the gate clears at phase send: a reply on a found thread, for a
// named opportunity that is go and open. A fresh deep copy on each call.
function clearing(phase: GatePhase = "send"): GateInput {
  return structuredClone({
    phase,
    facts: {
      draft: {
        found: true,
        tainted: false,
        status: phase === "send" ? "made" : "new",
        ageSeconds: 3_600,
        withinCap: true,
        consentFree: true,
        authorCurrent: true,
        disclosureOnly: false,
      },
      account: { connected: true, own: true, copyMissing: false, syncAgeSeconds: 60 },
      recipients: { count: 2, vetoed: 0, suppressed: 0, firstContact: 0 },
      about: { vetoed: false },
      basis: { missing: 0, tainted: 0, flagged: 0, unscreened: 0 },
      beliefs: { changed: 0 },
      thread: { isNew: false, found: true, newer: 0 },
      sent: { already: false },
      work: { named: true, go: true, open: true, tainted: false },
      killSwitch: false,
    },
    revealed: 0,
    released: 0,
    computedFp: "a".repeat(64),
    storedFp: "a".repeat(64),
  } satisfies GateInput);
}

// The clearing input changed in one way, at one phase.
function changed(phase: GatePhase, change: (input: GateInput) => void): GateInput {
  const input = clearing(phase);
  change(input);
  return input;
}

// A view of an input that lets a test break its shape.
type Loose = { [key: string]: Loose } & Record<string, unknown>;
const loose = (input: GateInput): Loose => input as unknown as Loose;
const gate = (input: unknown): GateOutcome => sendGate(input as GateInput);

// The outcome has its shape: exactly the nine checks, and cleared only when all nine are true.
function shaped(outcome: GateOutcome): GateOutcome {
  expect(GateOutcome.parse(outcome)).toEqual(outcome);
  expect(Object.keys(outcome.checks).sort()).toEqual([...CHECKS].sort());
  expect(outcome.cleared).toBe(CHECKS.every((check) => outcome.checks[check] === true));
  if (outcome.cleared) expect(outcome.causes).toEqual([]);
  for (const cause of outcome.causes)
    if (cause !== "cannot_answer") expect(outcome.checks[GATE_CAUSE_CHECK[cause]], cause).toBe(false);
  return outcome;
}

// Every check is true but those named, which are false; and causes are exactly these.
function expectFalse(outcome: GateOutcome, falseChecks: readonly Check[], causes: readonly GateCause[]): void {
  shaped(outcome);
  for (const check of CHECKS) expect(outcome.checks[check], check).toBe(!falseChecks.includes(check));
  expect(outcome.causes).toEqual(causes);
}

function expectCleared(outcome: GateOutcome): void {
  expectFalse(outcome, [], []);
  expect(outcome.cleared).toBe(true);
}

// One failing clause: the phases it runs at, the change, its check and its cause.
type Case = {
  name: string;
  phases: readonly GatePhase[];
  change: (input: GateInput) => void;
  check: Check;
  cause: GateCause;
};
const BOTH = ["draft", "send"] as const;
const SEND = ["send"] as const;
const DRAFT = ["draft"] as const;

const CASES: readonly Case[] = [
  {
    name: "R17: authority: a draft that is not found fails it with draft_missing",
    phases: BOTH,
    change: (i) => void (i.facts.draft.found = false),
    check: "authority",
    cause: "draft_missing",
  },
  {
    name: "R17: authority: a draft whose author is not a current client with the tool is held, author_not_current",
    phases: DRAFT,
    change: (i) => void (i.facts.draft.authorCurrent = false),
    check: "authority",
    cause: "author_not_current",
  },
  ...(["new", "sent", "rejected", "expired"] as const).map(
    (status): Case => ({
      name: `R17: authority: at send, a draft that is ${status} fails it with not_made`,
      phases: SEND,
      change: (i) => void (i.facts.draft.status = status),
      check: "authority",
      cause: "not_made",
    }),
  ),
  {
    name: "R17: authority: at send, a held draft not held by disclosure alone fails it with held_at_draft",
    phases: SEND,
    change: (i) => void (i.facts.draft.status = "held"),
    check: "authority",
    cause: "held_at_draft",
  },
  {
    name: "R17: authority: at send, the kill switch fails it with switch_on",
    phases: SEND,
    change: (i) => void (i.facts.killSwitch = true),
    check: "authority",
    cause: "switch_on",
  },
  {
    name: "R17: authority: at send, a named opportunity that is not go fails it with no_go",
    phases: SEND,
    change: (i) => void (i.facts.work.go = false),
    check: "authority",
    cause: "no_go",
  },
  {
    name: "R17: authority: at send, a tainted opportunity fails it with work_tainted",
    phases: SEND,
    change: (i) => void (i.facts.work.tainted = true),
    check: "authority",
    cause: "work_tainted",
  },
  {
    name: "an expired or done opportunity (open false) fails authority with work_closed",
    phases: SEND,
    change: (i) => void (i.facts.work.open = false),
    check: "authority",
    cause: "work_closed",
  },
  {
    name: "R18: vetoes: a veto on a recipient fails it with recipient_vetoed",
    phases: BOTH,
    change: (i) => void (i.facts.recipients.vetoed = 1),
    check: "vetoes",
    cause: "recipient_vetoed",
  },
  {
    name: "R18: vetoes: a veto on what the work is about fails it with about_vetoed",
    phases: BOTH,
    change: (i) => void (i.facts.about.vetoed = true),
    check: "vetoes",
    cause: "about_vetoed",
  },
  {
    name: "R19: conflict_lists: a suppressed address among the recipients fails it",
    phases: BOTH,
    change: (i) => void (i.facts.recipients.suppressed = 1),
    check: "conflict_lists",
    cause: "recipient_suppressed",
  },
  {
    name: "R20: contact_policy: no recipient fails it",
    phases: BOTH,
    change: (i) => void (i.facts.recipients.count = 0),
    check: "contact_policy",
    cause: "recipient_count",
  },
  {
    name: "R20: contact_policy: more than 10 recipients fails it",
    phases: BOTH,
    change: (i) => void (i.facts.recipients.count = 11),
    check: "contact_policy",
    cause: "recipient_count",
  },
  {
    name: "R21: disclosure: a use-only claim the draft reveals fails it",
    phases: BOTH,
    change: (i) => void (i.revealed = 1),
    check: "disclosure",
    cause: "use_only_revealed",
  },
  {
    name: "R22: freshness: a tainted draft fails it with draft_tainted",
    phases: BOTH,
    change: (i) => void (i.facts.draft.tainted = true),
    check: "freshness",
    cause: "draft_tainted",
  },
  {
    name: "R22: freshness: a draft older than seven days fails it with too_old",
    phases: BOTH,
    change: (i) => void (i.facts.draft.ageSeconds = 604_801),
    check: "freshness",
    cause: "too_old",
  },
  {
    name: "R22: freshness: a missing ref fails it with ref_missing",
    phases: BOTH,
    change: (i) => void (i.facts.basis.missing = 1),
    check: "freshness",
    cause: "ref_missing",
  },
  {
    name: "R22: freshness: a tainted ref fails it with ref_tainted",
    phases: BOTH,
    change: (i) => void (i.facts.basis.tainted = 1),
    check: "freshness",
    cause: "ref_tainted",
  },
  {
    name: "R22: freshness: a belief whose served state moved fails it with belief_moved",
    phases: BOTH,
    change: (i) => void (i.facts.beliefs.changed = 1),
    check: "freshness",
    cause: "belief_moved",
  },
  {
    name: "R22: freshness: a reply whose thread is not found fails it with thread_missing",
    phases: BOTH,
    change: (i) => void (i.facts.thread.found = false),
    check: "freshness",
    cause: "thread_missing",
  },
  {
    name: "R22: freshness: a later message on the thread answered fails it with later_message",
    phases: BOTH,
    change: (i) => void (i.facts.thread.newer = 1),
    check: "freshness",
    cause: "later_message",
  },
  {
    name: "R22: freshness: a message already sent fails it with already_sent",
    phases: BOTH,
    change: (i) => void (i.facts.sent.already = true),
    check: "freshness",
    cause: "already_sent",
  },
  {
    name: "R22: freshness: at send, a sync more than 30 minutes old fails it with sync_stale",
    phases: SEND,
    change: (i) => void (i.facts.account.syncAgeSeconds = 1_801),
    check: "freshness",
    cause: "sync_stale",
  },
  {
    name: "R22: freshness: at send, a last sync that did not end ok (null) fails it with sync_stale",
    phases: SEND,
    change: (i) => void (i.facts.account.syncAgeSeconds = null),
    check: "freshness",
    cause: "sync_stale",
  },
  {
    name: "R23: consent: a kind of work outside reply, follow_up and a proposal fails it",
    phases: BOTH,
    change: (i) => void (i.facts.draft.consentFree = false),
    check: "consent",
    cause: "consent_needed",
  },
  {
    name: "R24: channel_cap: a label outside the cap fails it with label_over_cap",
    phases: BOTH,
    change: (i) => void (i.facts.draft.withinCap = false),
    check: "channel_cap",
    cause: "label_over_cap",
  },
  {
    name: "R24: channel_cap: an account that is not own fails it with account_not_own",
    phases: BOTH,
    change: (i) => void (i.facts.account.own = false),
    check: "channel_cap",
    cause: "account_not_own",
  },
  {
    name: "R24: channel_cap: at send, an account with no send secret fails it with not_connected",
    phases: SEND,
    change: (i) => void (i.facts.account.connected = false),
    check: "channel_cap",
    cause: "not_connected",
  },
  {
    name: "R24: channel_cap: at send, an account with a missing copy fails it with copy_missing",
    phases: SEND,
    change: (i) => void (i.facts.account.copyMissing = true),
    check: "channel_cap",
    cause: "copy_missing",
  },
  {
    name: "R25: payload_hash: a fingerprint that differs from the draft's fails it",
    phases: BOTH,
    change: (i) => void (i.computedFp = "b".repeat(64)),
    check: "payload_hash",
    cause: "payload_changed",
  },
  {
    name: "R25: payload_hash: two empty fingerprints fail it",
    phases: BOTH,
    change: (i) => {
      i.computedFp = "";
      i.storedFp = "";
    },
    check: "payload_hash",
    cause: "payload_changed",
  },
];

describe("the clearing input", () => {
  it("parses as GateInput and clears at both phases", () => {
    for (const phase of BOTH) {
      expect(GateInput.safeParse(clearing(phase)).success, phase).toBe(true);
      expectCleared(gate(clearing(phase)));
    }
  });

  it("the nine checks are GateCheckKind's, in its order", () => {
    expect(GateCheckKind.options).toEqual([...CHECKS]);
  });
});

describe("one failing clause: the check is false, its cause is in causes, and no other check changes", () => {
  for (const one of CASES)
    for (const phase of one.phases)
      it(`${one.name} (phase ${phase})`, () => {
        expectFalse(gate(changed(phase, one.change)), [one.check], [one.cause]);
      });
});

describe("authority", () => {
  it("at draft, an author that is not current is false", () => {
    expectFalse(
      gate(changed("draft", (i) => void (i.facts.draft.authorCurrent = false))),
      ["authority"],
      ["author_not_current"],
    );
  });

  it("at send, a draft that is not made, a named opportunity that is not go, a tainted opportunity and the kill switch are each false", () => {
    const changes: [(i: GateInput) => void, GateCause][] = [
      [(i) => void (i.facts.draft.status = "new"), "not_made"],
      [(i) => void (i.facts.work.go = false), "no_go"],
      [(i) => void (i.facts.work.tainted = true), "work_tainted"],
      [(i) => void (i.facts.killSwitch = true), "switch_on"],
    ];
    for (const [change, cause] of changes) expectFalse(gate(changed("send", change)), ["authority"], [cause]);
  });

  it("at send, unnamed work reads neither go, open nor tainted", () => {
    const input = changed("send", (i) => void (i.facts.work = { named: false, go: false, open: false, tainted: true }));
    expectCleared(gate(input));
  });

  it("at send, the author's being current is not read", () => {
    expectCleared(gate(changed("send", (i) => void (i.facts.draft.authorCurrent = false))));
  });

  it("at draft, neither the draft's status nor the work is read", () => {
    const input = changed("draft", (i) => {
      i.facts.draft.status = "sent";
      i.facts.work = { named: true, go: false, open: false, tainted: true };
    });
    expectCleared(gate(input));
  });

  it("at draft, released above 0 is false with cannot_answer", () => {
    expectFalse(gate(changed("draft", (i) => void (i.released = 1))), ["authority"], ["cannot_answer"]);
  });
});

describe("send-proxy", () => {
  it("at phase send, a draft that is disclosureOnly with released above 0 passes authority, and with released 0 fails it with held_at_draft", () => {
    const held = (released: number) =>
      changed("send", (i) => {
        i.facts.draft.status = "held";
        i.facts.draft.disclosureOnly = true;
        i.released = released;
      });
    expectCleared(gate(held(1)));
    expectCleared(gate(held(3)));
    expectFalse(gate(held(0)), ["authority"], ["held_at_draft"]);
  });

  it("a draft held by any other check fails authority whatever released says", () => {
    for (const released of [0, 1, 5]) {
      const input = changed("send", (i) => {
        i.facts.draft.status = "held";
        i.facts.draft.disclosureOnly = false;
        i.released = released;
      });
      expectFalse(gate(input), ["authority"], ["held_at_draft"]);
    }
  });

  it("disclosureOnly with a release does not lift a status other than held", () => {
    for (const status of ["new", "sent", "rejected", "expired"] as const) {
      const input = changed("send", (i) => {
        i.facts.draft.status = status;
        i.facts.draft.disclosureOnly = true;
        i.released = 2;
      });
      expectFalse(gate(input), ["authority"], ["not_made"]);
    }
  });

  it("a made draft with released above 0 passes authority", () => {
    expectCleared(gate(changed("send", (i) => void (i.released = 2))));
  });

  it("GateInput refuses released above 0 at phase draft", () => {
    expect(GateInput.safeParse(changed("draft", (i) => void (i.released = 1))).success).toBe(false);
    expect(GateInput.safeParse(changed("send", (i) => void (i.released = 1))).success).toBe(true);
  });
});

describe("edges of the clauses", () => {
  it("at phase send, a sync age of 1 801 seconds fails freshness with sync_stale, one of 1 800 does not, and a null one fails it", () => {
    expectFalse(
      gate(changed("send", (i) => void (i.facts.account.syncAgeSeconds = 1_801))),
      ["freshness"],
      ["sync_stale"],
    );
    expectCleared(gate(changed("send", (i) => void (i.facts.account.syncAgeSeconds = 1_800))));
    expectFalse(
      gate(changed("send", (i) => void (i.facts.account.syncAgeSeconds = null))),
      ["freshness"],
      ["sync_stale"],
    );
  });

  it("a draft of exactly seven days passes freshness, and one second more fails it", () => {
    for (const phase of BOTH) {
      expectCleared(gate(changed(phase, (i) => void (i.facts.draft.ageSeconds = 604_800))));
      expectFalse(gate(changed(phase, (i) => void (i.facts.draft.ageSeconds = 604_801))), ["freshness"], ["too_old"]);
    }
  });

  it("a new thread reads neither found nor newer", () => {
    for (const phase of BOTH)
      expectCleared(gate(changed(phase, (i) => void (i.facts.thread = { isNew: true, found: false, newer: 4 }))));
  });

  it("one recipient and ten recipients pass contact_policy", () => {
    for (const count of [1, 10]) expectCleared(gate(changed("send", (i) => void (i.facts.recipients.count = count))));
  });

  it("no gate check reads basis.flagged, basis.unscreened or recipients.firstContact", () => {
    for (const phase of BOTH) {
      const input = changed(phase, (i) => {
        i.facts.basis.flagged = 3;
        i.facts.basis.unscreened = 2;
        i.facts.recipients.firstContact = 2;
      });
      expectCleared(gate(input));
    }
  });

  it("withinCap false fails channel_cap with label_over_cap", () => {
    for (const phase of BOTH)
      expectFalse(
        gate(changed(phase, (i) => void (i.facts.draft.withinCap = false))),
        ["channel_cap"],
        ["label_over_cap"],
      );
  });

  it("an account that is not own fails it with its own cause at both phases", () => {
    for (const phase of BOTH)
      expectFalse(
        gate(changed(phase, (i) => void (i.facts.account.own = false))),
        ["channel_cap"],
        ["account_not_own"],
      );
  });

  it("at phase send, an account that is not connected, or with a missing copy, each fails it with its own cause", () => {
    expectFalse(
      gate(changed("send", (i) => void (i.facts.account.connected = false))),
      ["channel_cap"],
      ["not_connected"],
    );
    expectFalse(
      gate(changed("send", (i) => void (i.facts.account.copyMissing = true))),
      ["channel_cap"],
      ["copy_missing"],
    );
  });
});

describe("the phases", () => {
  it("at phase draft a null sync age, no send secret and a missing copy fail nothing; at phase send each fails its check", () => {
    const changes: [(i: GateInput) => void, Check, GateCause][] = [
      [(i) => void (i.facts.account.syncAgeSeconds = null), "freshness", "sync_stale"],
      [(i) => void (i.facts.account.connected = false), "channel_cap", "not_connected"],
      [(i) => void (i.facts.account.copyMissing = true), "channel_cap", "copy_missing"],
    ];
    for (const [change, check, cause] of changes) {
      expectCleared(gate(changed("draft", change)));
      expectFalse(gate(changed("send", change)), [check], [cause]);
    }
    const all = (i: GateInput) => {
      for (const [change] of changes) change(i);
    };
    expectCleared(gate(changed("draft", all)));
  });

  it("the gate at phase draft does not read the kill switch, the work's go, the account's send secret, its missing copy or its sync age, and reads every other fact as phase send does", () => {
    const unread = changed("draft", (i) => {
      i.facts.killSwitch = true;
      i.facts.work.go = false;
      i.facts.account.connected = false;
      i.facts.account.copyMissing = true;
      i.facts.account.syncAgeSeconds = null;
    });
    expectCleared(gate(unread));

    // Not read means not even present: the same facts deleted leave the draft phase cleared.
    const deleted = clearing("draft");
    const facts = loose(deleted).facts as Loose;
    delete facts.killSwitch;
    delete (facts.work as Loose).go;
    delete (facts.account as Loose).connected;
    delete (facts.account as Loose).copyMissing;
    delete (facts.account as Loose).syncAgeSeconds;
    expectCleared(gate(deleted));

    for (const one of CASES.filter((c) => c.phases.length === 2 && c.check !== "authority")) {
      const atDraft = shaped(gate(changed("draft", one.change)));
      const atSend = shaped(gate(changed("send", one.change)));
      expect(atDraft, one.name).toEqual(atSend);
    }
  });
});

describe("send-proxy", () => {
  it("every check runs on every call: with all nine failing, nine are false", () => {
    const input = changed("send", (i) => {
      i.facts.killSwitch = true;
      i.facts.recipients.vetoed = 1;
      i.facts.recipients.suppressed = 1;
      i.facts.recipients.count = 11;
      i.revealed = 1;
      i.facts.draft.tainted = true;
      i.facts.draft.consentFree = false;
      i.facts.draft.withinCap = false;
      i.computedFp = "c".repeat(64);
    });
    const outcome = shaped(gate(input));
    expect(outcome.cleared).toBe(false);
    for (const check of CHECKS) expect(outcome.checks[check], check).toBe(false);
    expect(outcome.causes).toEqual([
      "switch_on",
      "recipient_vetoed",
      "recipient_suppressed",
      "recipient_count",
      "use_only_revealed",
      "draft_tainted",
      "consent_needed",
      "label_over_cap",
      "payload_changed",
    ]);
  });

  it("a cleared outcome has no cause, and causes are in the order of the checks", () => {
    expect(gate(clearing("send"))).toEqual({
      cleared: true,
      checks: Object.fromEntries(CHECKS.map((check) => [check, true])),
      causes: [],
    });

    const input = changed("send", (i) => {
      i.facts.draft = {
        found: false,
        tainted: true,
        status: "sent",
        ageSeconds: 700_000,
        withinCap: false,
        consentFree: false,
        authorCurrent: true,
        disclosureOnly: false,
      };
      i.facts.account = { connected: false, own: false, copyMissing: true, syncAgeSeconds: null };
      i.facts.recipients = { count: 0, vetoed: 2, suppressed: 1, firstContact: 0 };
      i.facts.about.vetoed = true;
      i.facts.basis = { missing: 1, tainted: 1, flagged: 0, unscreened: 0 };
      i.facts.beliefs.changed = 2;
      i.facts.thread = { isNew: false, found: false, newer: 3 };
      i.facts.sent.already = true;
      i.facts.work = { named: true, go: false, open: true, tainted: true };
      i.facts.killSwitch = true;
      i.revealed = 2;
      i.computedFp = "d".repeat(64);
    });
    const outcome = shaped(gate(input));
    for (const check of CHECKS) expect(outcome.checks[check], check).toBe(false);
    expect(outcome.causes).toEqual([
      "draft_missing",
      "not_made",
      "switch_on",
      "no_go",
      "work_tainted",
      "recipient_vetoed",
      "about_vetoed",
      "recipient_suppressed",
      "recipient_count",
      "use_only_revealed",
      "draft_tainted",
      "too_old",
      "ref_missing",
      "ref_tainted",
      "belief_moved",
      "thread_missing",
      "later_message",
      "already_sent",
      "sync_stale",
      "consent_needed",
      "label_over_cap",
      "account_not_own",
      "not_connected",
      "copy_missing",
      "payload_changed",
    ]);
  });

  it("a facts object with one field missing fails the checks that read it and no other, with the cause cannot_answer", () => {
    const missing = (phase: GatePhase, path: readonly string[]): GateInput => {
      const input = clearing(phase);
      let at = loose(input).facts as Loose;
      for (const key of path.slice(0, -1)) at = at[key] as Loose;
      delete at[path[path.length - 1] as string];
      return input;
    };
    expectFalse(gate(missing("send", ["recipients", "suppressed"])), ["conflict_lists"], ["cannot_answer"]);
    expectFalse(gate(missing("send", ["killSwitch"])), ["authority"], ["cannot_answer"]);
    expectCleared(gate(missing("draft", ["killSwitch"])));
    expectFalse(gate(missing("send", ["about"])), ["vetoes"], ["cannot_answer"]);
    expectFalse(gate(missing("send", ["draft", "consentFree"])), ["consent"], ["cannot_answer"]);
    expectFalse(gate(missing("send", ["recipients", "count"])), ["contact_policy"], ["cannot_answer"]);
    expectFalse(gate(missing("send", ["beliefs"])), ["freshness"], ["cannot_answer"]);
    expectFalse(gate(missing("draft", ["draft", "authorCurrent"])), ["authority"], ["cannot_answer"]);
    expectFalse(gate(missing("send", ["account", "connected"])), ["channel_cap"], ["cannot_answer"]);
    expectFalse(gate(missing("send", ["account", "syncAgeSeconds"])), ["freshness"], ["cannot_answer"]);
    expectFalse(gate(missing("send", ["work", "open"])), ["authority"], ["cannot_answer"]);

    const noRevealed = clearing("send");
    delete loose(noRevealed).revealed;
    expectFalse(gate(noRevealed), ["disclosure"], ["cannot_answer"]);
    const noStoredFp = clearing("send");
    delete loose(noStoredFp).storedFp;
    expectFalse(gate(noStoredFp), ["payload_hash"], ["cannot_answer"]);
  });

  it("a check whose facts are missing drops its other causes and keeps only cannot_answer", () => {
    const input = changed("send", (i) => void (i.facts.recipients.vetoed = 2));
    delete (loose(input).facts as Loose).about;
    expectFalse(gate(input), ["vetoes"], ["cannot_answer"]);
  });

  it("a fact of the wrong type fails its check with cannot_answer", () => {
    const vetoed = clearing("send");
    ((loose(vetoed).facts as Loose).recipients as Loose).vetoed = "0" as unknown as Loose;
    expectFalse(gate(vetoed), ["vetoes"], ["cannot_answer"]);

    const age = clearing("send");
    ((loose(age).facts as Loose).draft as Loose).ageSeconds = "60" as unknown as Loose;
    expectFalse(gate(age), ["freshness"], ["cannot_answer"]);

    const own = clearing("send");
    ((loose(own).facts as Loose).account as Loose).own = "true" as unknown as Loose;
    expectFalse(gate(own), ["channel_cap"], ["cannot_answer"]);

    const revealed = clearing("send");
    loose(revealed).revealed = "0" as unknown as Loose;
    expectFalse(gate(revealed), ["disclosure"], ["cannot_answer"]);
  });

  it("a check that throws is false, and the others still run", () => {
    const input = clearing("send");
    Object.defineProperty(input.facts.recipients, "vetoed", {
      enumerable: true,
      get() {
        throw new Error("a fact that cannot be read");
      },
    });
    expectFalse(gate(input), ["vetoes"], ["cannot_answer"]);

    const failing = changed("send", (i) => {
      i.facts.recipients.suppressed = 1;
      i.revealed = 1;
    });
    Object.defineProperty(failing.facts.recipients, "vetoed", {
      enumerable: true,
      get() {
        throw new Error("a fact that cannot be read");
      },
    });
    expectFalse(
      gate(failing),
      ["vetoes", "conflict_lists", "disclosure"],
      ["cannot_answer", "recipient_suppressed", "use_only_revealed"],
    );
  });

  it("a phase that is neither word fails the checks that read the phase with cannot_answer", () => {
    const input = clearing("send");
    loose(input).phase = "later" as unknown as Loose;
    expectFalse(
      gate(input),
      ["authority", "freshness", "channel_cap"],
      ["cannot_answer", "cannot_answer", "cannot_answer"],
    );
  });
});

describe("send-proxy", () => {
  it("facts that do not parse as GateFacts make every check that reads facts false, with cannot_answer", () => {
    for (const facts of [null, "facts", 7, undefined]) {
      const input = clearing("send");
      loose(input).facts = facts as unknown as Loose;
      expectFalse(
        gate(input),
        ["authority", "vetoes", "conflict_lists", "contact_policy", "freshness", "consent", "channel_cap"],
        Array(7).fill("cannot_answer") as GateCause[],
      );
    }
  });

  it("sendGate never throws, whatever it is given", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile");
        },
        has() {
          throw new Error("hostile");
        },
        ownKeys() {
          throw new Error("hostile");
        },
        getPrototypeOf() {
          throw new Error("hostile");
        },
      },
    );
    const withHostileFacts = clearing("send");
    loose(withHostileFacts).facts = hostile as Loose;
    for (const input of [undefined, null, 0, "send", [], {}, hostile, withHostileFacts, { phase: "send" }]) {
      let outcome: GateOutcome | undefined;
      expect(() => (outcome = gate(input))).not.toThrow();
      expect(outcome && shaped(outcome).cleared).toBe(false);
    }
  });
});
