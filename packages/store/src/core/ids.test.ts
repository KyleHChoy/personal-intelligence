import {
  AgentRecordId,
  ClientId,
  DraftId,
  EntityId,
  EventId,
  GateDecisionId,
  MessageId,
  RetentionRuleId,
  SealId,
  SentId,
  SessionId,
  SourceAccountId,
} from "@intelligence/contracts/personal";
import { SERVED_ID_PREFIXES, systemIdIn } from "@intelligence/personal-core/lens";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type IdPrefix, newId } from "./ids.ts";

// Among them drafts, gate decisions and sends, and Lens's four: a capture item, a mirror cursor, an
// inbox row and a scope rule.
const PREFIXES: IdPrefix[] = [
  "cli",
  "acc",
  "blb",
  "ent",
  "adr",
  "dom",
  "als",
  "msg",
  "evt",
  "drf",
  "gdc",
  "snt",
  "ses",
  "rec",
  "cap",
  "mcr",
  "cin",
  "csr",
];

afterEach(() => {
  vi.useRealTimers();
});

describe("newId", () => {
  it("an id is its table's prefix and a ULID", () => {
    for (const prefix of PREFIXES) {
      // 26 characters of Crockford base32, upper case: no I, L, O or U.
      expect(newId(prefix)).toMatch(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));
    }
    expect(ClientId.safeParse(newId("cli")).success).toBe(true);
    expect(SourceAccountId.safeParse(newId("acc")).success).toBe(true);
    expect(EntityId.safeParse(newId("ent")).success).toBe(true);
    expect(MessageId.safeParse(newId("msg")).success).toBe(true);
    expect(EventId.safeParse(newId("evt")).success).toBe(true);
    expect(DraftId.safeParse(newId("drf")).success).toBe(true);
    expect(GateDecisionId.safeParse(newId("gdc")).success).toBe(true);
    expect(SentId.safeParse(newId("snt")).success).toBe(true);
    // The positive control of those checks: another table's id is not an entity id.
    expect(EntityId.safeParse(newId("adr")).success).toBe(false);
  });

  it("newId takes rec", () => {
    expect(AgentRecordId.safeParse(newId("rec")).success).toBe(true);
    expect(AgentRecordId.safeParse(newId("ses")).success).toBe(false);
  });

  it("newId takes sel and rtr", () => {
    expect(SealId.safeParse(newId("sel")).success).toBe(true);
    expect(RetentionRuleId.safeParse(newId("rtr")).success).toBe(true);
    // The control: each refuses the other's.
    expect(SealId.safeParse(newId("rtr")).success).toBe(false);
  });

  it("newId takes ses", () => {
    expect(SessionId.safeParse(newId("ses")).success).toBe(true);
    // The control: a message id is not a session id.
    expect(SessionId.safeParse(newId("msg")).success).toBe(false);
  });

  it("two ids in one millisecond differ", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.006Z"));
    for (const prefix of PREFIXES) {
      const ids = Array.from({ length: 1000 }, () => newId(prefix));
      expect(new Set(ids).size).toBe(ids.length);
    }
    // One millisecond: the time part, the first ten characters, is the same in all.
    const ids = Array.from({ length: 1000 }, () => newId("msg"));
    expect(new Set(ids.map((id) => id.slice(0, "msg_".length + 10))).size).toBe(1);
  });

  it("ids sort by time", () => {
    vi.useFakeTimers();
    const times = [
      "1970-01-01T00:00:00.000Z",
      "2026-01-02T03:04:05.006Z",
      "2026-01-02T03:04:05.007Z",
      "2026-01-02T03:04:06.000Z",
      "2100-01-01T00:00:00.000Z",
    ];
    for (const prefix of PREFIXES.filter((one) => one !== "ent")) {
      const ids = times.map((time) => {
        vi.setSystemTime(new Date(time));
        return newId(prefix);
      });
      expect([...ids].sort()).toEqual(ids);
      expect([...ids].reverse().sort()).toEqual(ids);
      // The time part is the milliseconds since the epoch, in base 32, most significant first.
      expect(ids[0]?.slice(0, prefix.length + 11)).toBe(`${prefix}_0000000000`);
    }
  });

  // A reader sees entity ids, and must learn nothing from one about when its entity was made.
  it("an entity id has no time part", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.006Z"));
    const ids = Array.from({ length: 1000 }, () => newId("ent"));
    const heads = ids.map((id) => id.slice("ent_".length, "ent_".length + 10));
    // Made at one frozen time, they differ where a ULID holds its time.
    expect(new Set(heads).size).toBe(ids.length);
    // And that part is not the time: the positive control is another prefix at the same instant.
    const timePart = newId("msg").slice("msg_".length, "msg_".length + 10);
    expect(heads).not.toContain(timePart);
    // 128 random bits in 26 characters of five bits: the first holds three, so it is 0 to 7.
    expect(new Set(ids.map((id) => id.charAt("ent_".length))).size).toBeGreaterThan(1);
    for (const id of ids) {
      expect(id).toMatch(/^ent_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
      expect(EntityId.safeParse(id).success).toBe(true);
    }
    // An id made later does not sort later: over many pairs, about half sort before.
    vi.setSystemTime(new Date("2026-01-02T03:04:06.000Z"));
    const earlier = ids.filter((id) => newId("ent") < id).length;
    expect(earlier).toBeGreaterThan(300);
    expect(earlier).toBeLessThan(700);
  });
});

// Every IdPrefix value, once. The two type lines fail the type check when a prefix is added to
// IdPrefix and not here, or written here and not there.
const ALL_PREFIXES = [
  "cli",
  "doc",
  "drt",
  "acc",
  "con",
  "blb",
  "ent",
  "adr",
  "dom",
  "als",
  "msg",
  "evt",
  "gol",
  "int",
  "hrn",
  "run",
  "cas",
  "hyp",
  "tst",
  "opp",
  "mov",
  "itn",
  "asg",
  "dpc",
  "mcl",
  "mus",
  "rvw",
  "drf",
  "gdc",
  "snt",
  "ses",
  "rec",
  "rul",
  "crd",
  "ers",
  "rme",
  "sup",
  "dcl",
  "dcc",
  "thr",
  "tpr",
  "cal",
  "rsp",
  "pvd",
  "sls",
  "mrl",
  "oas",
  "fct",
  "sel",
  "rtr",
  "umn",
  "mbd",
  "pan",
  "rsq",
  "rft",
  "pag",
  "prd",
  "cap",
  "mcr",
  "cin",
  "csr",
  "cex",
  "cac",
  "onm",
  "lst",
  "amg",
  "imp",
  "ime",
  "lrn",
  "otr",
  "ott",
  "hoq",
  "are",
  "tru",
  "tpr",
  "tex",
  "aan",
  "atr",
  "prm",
] as const satisfies readonly IdPrefix[];
const everyPrefixListed: [Exclude<IdPrefix, (typeof ALL_PREFIXES)[number]>] extends [never] ? true : false = true;

describe("served id forms", () => {
  it("every IdPrefix value is on core's list of served forms", () => {
    const prefixes: readonly IdPrefix[] = ALL_PREFIXES;
    expect(everyPrefixListed).toBe(true);
    expect(prefixes).toEqual(expect.arrayContaining(["cap", "mcr", "cin", "csr"]));
    for (const prefix of prefixes) {
      expect(SERVED_ID_PREFIXES, prefix).toContain(prefix);
      // And systemIdIn finds an id the store makes with it.
      expect(systemIdIn(`a note ${newId(prefix)} here`), prefix).toBe(true);
    }
    // The control: a form the store does not make is not found.
    expect(systemIdIn("a note xyz_01JABCDEFGHJKMNPQRSTVWXYZ0 here")).toBe(false);
  });
});
