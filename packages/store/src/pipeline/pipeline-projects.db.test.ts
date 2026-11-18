import type { EvidenceId, Mention } from "@intelligence/contracts";
import type { EntityId, MessageId } from "@intelligence/contracts/personal";
import { describe, expect, it, vi } from "vitest";
import { testId } from "../test-support/clients.ts";
import { asTablesOwner } from "../test-support/connections.ts";
import { mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { batchOf, claimRecord, type PipelineStore, rowsOf, stored } from "../test-support/pipeline-fixtures.ts";
import { withRulings as withAdmin } from "../test-support/ruling-fixtures.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Reserved domains only.

const AT = "2026-09-01T09:00:00.000Z";
const THIS: Mention = { key: { kind: "source_id", value: "project:this" }, observedAt: AT } as Mention;
const evidence = (value: string): EvidenceId => value as EvidenceId;
let serial = 0;
const request = (): string => `req-pipeline-projects-${(serial += 1)}-${testId("x").slice(-8)}`;

const messageOf = async (store: PipelineStore, evidenceId: string): Promise<MessageId> =>
  (
    await rowsOf<{ id: MessageId }>(store.db, "select id from knowledge.messages where evidence_id = $1", [evidenceId])
  )[0]?.id as MessageId;

const resolveThis = async (store: PipelineStore, evidenceId: string) => {
  const item = await store.pipeline.open(evidence(evidenceId));
  if (item === null) throw new Error("no item");
  return { answer: await item.context.identity.resolve(THIS, "personal", "r" as never), kindOf: item.kindOf };
};

describe("the project subject", () => {
  it("project:this resolves to nobody in an unanchored thread, and to the project once the owner anchors it", () =>
    withAdmin(async (store) => {
      const { admin, writer, accounts } = store;
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      expect((await resolveThis(store, id)).answer).toEqual({ outcome: "not_a_person" });
      const project = await admin.projects.add("Lighthouse", { requestId: request() });
      await admin.projects.anchor(project, await messageOf(store, id), { requestId: request() });
      const anchored = await resolveThis(store, id);
      expect(anchored.answer).toEqual({ outcome: "linked", entity: project, epoch: 0 });
      expect(anchored.kindOf(project as never)).toBe("project");
      // Another item of the thread resolves the same; one of another thread does not.
      expect((await resolveThis(store, await stored(writer, accounts.personalMail, MAIL.reply))).answer).toEqual({
        outcome: "linked",
        entity: project,
        epoch: 0,
      });
      expect((await resolveThis(store, await stored(writer, accounts.personalMail, MAIL.solo))).answer).toEqual({
        outcome: "not_a_person",
      });
      // A closed project is no subject.
      await admin.projects.close(project, { requestId: request() });
      expect((await resolveThis(store, id)).answer).toEqual({ outcome: "not_a_person" });
    }));

  it("an item is opened with its active projects only when asked, the anchor marked, a lifted anchor as the owner's no", () =>
    withAdmin(async (store) => {
      const { admin, writer, accounts, pipeline } = store;
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      const kiln = await admin.projects.add("Alder Kiln", { requestId: request() });
      const lab = await admin.projects.add("Birch Labs", { requestId: request() });
      const closed = await admin.projects.add("Closed One", { requestId: request() });
      await admin.projects.close(closed, { requestId: request() });
      const hidden = await admin.projects.add("Elsewhere", { compartment: "employer:example", requestId: request() });
      const projects = async (one = id) => (await pipeline.open(evidence(one), { projects: true }))?.projects;
      const row = (project: EntityId, name: string, marks: { anchored?: boolean; vetoed?: boolean } = {}) => ({
        project,
        name,
        anchored: false,
        vetoed: false,
        ...marks,
      });
      const both = (one: ReturnType<typeof row>, two: ReturnType<typeof row>) =>
        [one, two].sort((a, b) => (a.project < b.project ? -1 : 1));
      // With the lane off the run does not ask, so nothing is read.
      expect((await pipeline.open(evidence(id)))?.projects).toBeUndefined();
      expect(await projects()).toEqual(both(row(kiln, "Alder Kiln"), row(lab, "Birch Labs")));
      expect(JSON.stringify(await projects())).not.toContain(hidden);
      const message = await messageOf(store, id);
      const anchor = await admin.projects.anchor(kiln, message, { requestId: request() });
      expect(await projects()).toEqual(both(row(kiln, "Alder Kiln", { anchored: true }), row(lab, "Birch Labs")));
      // A second anchor marks both, so code finds neither.
      const second = await admin.projects.anchor(lab, message, { requestId: request() });
      expect(await projects()).toEqual(
        both(row(kiln, "Alder Kiln", { anchored: true }), row(lab, "Birch Labs", { anchored: true })),
      );
      await admin.projects.unanchor(second, { requestId: request() });
      await admin.projects.unanchor(anchor, { requestId: request() });
      expect(await projects()).toEqual(
        both(row(kiln, "Alder Kiln", { vetoed: true }), row(lab, "Birch Labs", { vetoed: true })),
      );
    }));

  it("a lifted anchor under another label is no veto here", () =>
    withAdmin(async (store) => {
      const { admin, writer, accounts, pipeline, db } = store;
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      const kiln = await admin.projects.add("Alder Kiln", { requestId: request() });
      const anchor = await admin.projects.anchor(kiln, await messageOf(store, id), { requestId: request() });
      await admin.projects.unanchor(anchor, { requestId: request() });
      const marks = async () =>
        (await pipeline.open(evidence(id), { projects: true }))?.projects?.map((one) => one.vetoed);
      expect(await marks()).toEqual([true]);
      await asTablesOwner(db, ["knowledge.project_anchors"], (query) =>
        query("update knowledge.project_anchors set compartments = $2 where id = $1", [anchor, ["employer:example"]]),
      );
      expect(await marks()).toEqual([false]);
    }));

  it("a thread anchored to two projects yields no project subject", () =>
    withAdmin(async (store) => {
      const { admin, writer, accounts } = store;
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      const message = await messageOf(store, id);
      await admin.projects.anchor(await admin.projects.add("One", { requestId: request() }), message, {
        requestId: request(),
      });
      await admin.projects.anchor(await admin.projects.add("Two", { requestId: request() }), message, {
        requestId: request(),
      });
      expect((await resolveThis(store, id)).answer).toEqual({ outcome: "not_a_person" });
    }));

  it("every claim of an anchored item is bound with basis anchor, and a claim of an unanchored item has no binding and no review", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, owner } = store;
      const anchoredId = await stored(writer, accounts.personalMail, MAIL.canary);
      const loose = await stored(writer, accounts.personalMail, MAIL.solo);
      const project: EntityId = await admin.projects.add("Lighthouse", { requestId: request() });
      await admin.projects.anchor(project, await messageOf(store, anchoredId), { requestId: request() });
      const records = [
        claimRecord(anchoredId, "own", owner, { n: 1 }),
        claimRecord(anchoredId, "own", owner, { n: 2, type: "plan" }),
      ];
      expect(await pipeline.commit(batchOf(anchoredId, records))).toBe("committed");
      expect(await pipeline.commit(batchOf(loose, [claimRecord(loose, "own", owner, { n: 3 })]))).toBe("committed");
      const bindings = await rowsOf<{
        project_id: string;
        basis: string;
        anchor_kind: string;
        compartments: string[];
        evidence_id: string;
      }>(
        store.db,
        "select b.project_id, b.basis, b.anchor_kind, b.compartments, c.evidence_id from knowledge.project_bindings b join knowledge.claims c on c.id = b.claim_id order by b.id",
      );
      expect(bindings).toEqual([
        {
          project_id: project,
          basis: "anchor",
          anchor_kind: "email_thread",
          compartments: ["own"],
          evidence_id: anchoredId,
        },
        {
          project_id: project,
          basis: "anchor",
          anchor_kind: "email_thread",
          compartments: ["own"],
          evidence_id: anchoredId,
        },
      ]);
      // The same commit again binds nothing twice.
      expect(await pipeline.commit(batchOf(anchoredId, records))).toBe("committed");
      expect(await rowsOf(store.db, "select id from knowledge.project_bindings")).toHaveLength(2);
      // A commit that leaves a claim out removes its binding with it.
      expect(await pipeline.commit(batchOf(anchoredId, [records[0] as never]))).toBe("committed");
      expect(await rowsOf(store.db, "select id from knowledge.project_bindings")).toHaveLength(1);
    }));

  it("a deleted message leaves no binding, and the project and its anchor stay", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, owner } = store;
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      const project = await admin.projects.add("Lighthouse", { requestId: request() });
      await admin.projects.anchor(project, await messageOf(store, id), { requestId: request() });
      expect(await pipeline.commit(batchOf(id, [claimRecord(id, "own", owner)]))).toBe("committed");
      expect(await rowsOf(store.db, "select id from knowledge.project_bindings")).toHaveLength(1);
      await writer.applyDeletion(accounts.personalMail, {
        sourceAccount: accounts.personalMail.id,
        sourceItemId: mailSourceId(MAIL.canary),
      } as never);
      expect(await rowsOf(store.db, "select id from knowledge.project_bindings")).toEqual([]);
      expect(await rowsOf(store.db, "select id from knowledge.claims")).toEqual([]);
      expect(await rowsOf(store.db, "select id from knowledge.projects")).toEqual([{ id: project }]);
      expect(await rowsOf(store.db, "select id from knowledge.project_anchors where lifted_at is null")).toHaveLength(
        1,
      );
    }));
});
