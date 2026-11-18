import { EntityView } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { HEADERS_ONLY_COUNT, MAIL_COUNTS } from "../core/statements.ts";
import { ENTITY_MAIL, GROUP_MAIL, mailOf } from "./read-tools.ts";

// get_entity's mail line, pure. Synthetic values only.

const MAIL = EntityView.shape.mail;
const row = (headersOnly: number) => ({
  entity_id: `ent_${"1".repeat(26)}`,
  inbound: 13,
  outbound: 10,
  headers_only: headersOnly,
  first_at: new Date("2024-06-06T14:46:45.000Z"),
  last_at: new Date("2025-12-11T23:02:22.000Z"),
});

describe("mailOf", () => {
  it("store Entity: mail read by its headers alone is told apart, so an empty find_messages is not read as missing mail", () => {
    const mail = mailOf(row(23));
    expect(mail).toEqual({
      inbound: 13,
      outbound: 10,
      headersOnly: 23,
      firstAt: "2024-06-06T14:46:45.000Z",
      lastAt: "2025-12-11T23:02:22.000Z",
    });
    expect(MAIL.safeParse(mail).success).toBe(true);
  });

  it("store Entity: with no mail held by its headers alone, headersOnly is left out", () => {
    const mail = mailOf(row(0));
    expect(mail).not.toHaveProperty("headersOnly");
    expect(MAIL.safeParse(mail).success).toBe(true);
  });

  it("store Entity: no row is no mail", () => {
    expect(mailOf(undefined)).toEqual({ inbound: 0, outbound: 0, firstAt: null, lastAt: null });
  });

  it("the contract refuses a headersOnly of zero, so an empty field is never served", () => {
    expect(MAIL.safeParse({ inbound: 0, outbound: 0, headersOnly: 0, firstAt: null, lastAt: null }).success).toBe(
      false,
    );
  });
});

describe("the mail statements", () => {
  it("counts mail held by headers alone only among the messages the two counts count, so headersOnly never exceeds them", () => {
    const filters = [...MAIL_COUNTS.matchAll(/filter \(where (.+?)\)::int/g)].map((match) => match[1] ?? "");
    expect(filters).toHaveLength(2);
    for (const filter of filters) expect(HEADERS_ONLY_COUNT).toContain(filter);
  });

  it("only get_entity's statement counts mail held by headers alone: search ranks by the two counts", () => {
    expect(ENTITY_MAIL).toContain("as headers_only");
    expect(GROUP_MAIL).not.toContain("headers_only");
  });
});
