import type { DraftMessageArgs, ReadOutcome } from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { contactItem, deriveItem, whitelistedContact } from "@intelligence/personal-core/items";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWork } from "../agent-work/work.ts";
import { Reader } from "../read/read.ts";
import type { Sender } from "../send/sender.ts";
import { testId } from "../test-support/clients.ts";
import { one } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { NOW } from "../test-support/identity-fixtures.ts";
import { eventLogger } from "../test-support/recording.ts";
import {
  connectSend,
  draftingClient,
  OWNER,
  type SendWorld,
  seedDraft,
  senderOf,
  sendWorld,
  synced,
} from "../test-support/sender-fixtures.ts";
import type { SourceAccountRow } from "../write/writer-types.ts";

// A person's link is a use-only contact field, so the outbound gate's contact check holds a draft
// that carries it to anyone the contact does not exempt, and the owner may release it with the
// reveal code. Made-up values on reserved and example domains only.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const MAREN = "maren@links-gate.test";
const OTHER = "rowan@links-gate-other.test";
const SITE = "https://maren-holt-studio.example/work/";

const open: { world: SendWorld; senders: Sender[] }[] = [];
afterEach(async () => {
  for (const { world, senders } of open.splice(0)) {
    for (const sender of senders) await sender.close();
    await world.close();
  }
});

async function setUp(): Promise<{ world: SendWorld; sender: Sender; contacts: SourceAccountRow }> {
  const world = await sendWorld();
  const sender = senderOf(world);
  open.push({ world, senders: [sender] });
  await connectSend(world);
  await synced(world, world.accounts.personalMail.id);
  const contacts = await world.writer.ensureSourceAccount("personal", "google_contacts", "own", OWNER.personal);
  // Maren's saved contact with Maren's website.
  const saved = { metadata: { source: { type: "CONTACT", id: "maren" } } };
  const read = whitelistedContact({
    resourceName: "people/maren",
    metadata: { sources: [{ type: "CONTACT", id: "maren", updateTime: "2026-09-01T09:00:00Z" }] },
    names: [{ ...saved, displayName: "Maren Holt" }],
    emailAddresses: [{ ...saved, value: MAREN }],
    urls: [{ ...saved, value: SITE }],
  });
  if (read === null) throw new Error("refused");
  const raw = contactItem(read, { sourceAccount: contacts.id, changeKind: "backfill", now: NOW });
  await world.writer.ingestItem(contacts, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS));
  return { world, sender, contacts };
}

async function draft(world: SendWorld, token: string, to: string, body: string): Promise<string> {
  const pool = new pg.Pool({ connectionString: world.db.urls.reader, max: 2, connectionTimeoutMillis: 20_000 });
  try {
    const work = createWork({
      reader: new Reader({ pool, keys: world.db.keys, log: eventLogger() }),
      log: eventLogger(),
    });
    const args: DraftMessageArgs = {
      to: [to],
      subject: "A note",
      body,
      requestId: testId("req"),
      account: "personal",
    } as DraftMessageArgs;
    const outcome = (await work.draftMessage(token, args)) as ReadOutcome<{ draft: string }>;
    if (!outcome.ok) throw new Error(`no draft: ${outcome.code}`);
    return outcome.value.draft;
  } finally {
    await pool.end();
  }
}

const disclosureAtDraft = async (world: SendWorld, id: string): Promise<boolean> =>
  one(
    await queryAs<{ passed: boolean }>(
      world.db.urls.admin,
      "select passed from ledger.gate_checks where draft_id = $1 and phase = 'draft' and kind = 'disclosure'",
      [id],
    ),
  ).passed;

describe("the gate's check of a person's link", () => {
  it("a draft carrying a contact's website to an address the contact does not list is held; to the contact it is not", async () => {
    const { world } = await setUp();
    expect(await queryAs(world.db.urls.admin, "select type from knowledge.claims")).toEqual([{ type: "link" }]);
    const client = await draftingClient(world, "jev");
    expect(
      await disclosureAtDraft(
        world,
        await draft(world, client.token, OTHER, "Her work is at www.maren-holt-studio.example/work, have a look."),
      ),
    ).toBe(false);
    expect(
      await disclosureAtDraft(
        world,
        await draft(world, client.token, MAREN, "I linked maren-holt-studio.example/work on the page."),
      ),
    ).toBe(true);
    expect(await disclosureAtDraft(world, await draft(world, client.token, OTHER, "Nothing of hers here."))).toBe(true);
  });

  it("show names the held link by contact, field and index, never its value; the reveal code releases it and begin_send records it", async () => {
    const { world, sender } = await setUp();
    const id = one(await queryAs<{ id: string }>(world.db.urls.admin, "select id from knowledge.contacts")).id;
    const client = await draftingClient(world, "jev");
    const seeded = await seedDraft(world, client, { to: [OTHER], body: `See ${SITE}`, disclosure: "held" });
    const view = await sender.show(seeded.id);
    expect(view.heldFields).toEqual([{ id, field: "link", index: 0 }]);
    expect(JSON.stringify(view.heldFields)).not.toContain("maren-holt-studio");
    const answer = await sender.gate(seeded.id, seeded.values.payloadFp, {
      reveal: view.revealCode ?? "",
      firstContact: true,
      newThread: true,
    });
    expect(answer).toMatchObject({ cleared: true, released: [`${id}:link:0`] });
    if (!answer.cleared) return;
    const send = await sender.begin({
      draft: seeded.id,
      decision: answer.decision,
      fp: seeded.values.payloadFp,
      firstContact: answer.firstContact,
      newThread: answer.newThread,
      released: answer.released,
    });
    expect(send).not.toBeNull();
    const details = one(
      await queryAs<{ details: unknown }>(
        world.db.urls.admin,
        "select details from knowledge.owner_decisions where kind = 'send'",
      ),
    ).details;
    expect(details).toEqual({
      firstContact: true,
      newThread: true,
      released: [],
      releasedContacts: [{ contact: id, field: "link", index: 0 }],
    });
  });
});
