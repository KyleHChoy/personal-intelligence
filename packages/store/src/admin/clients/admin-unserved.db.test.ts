import type { ClientRegistration } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { openStore } from "../../test-support/store.ts";
import { refusedWith, registration } from "../../test-support/values.ts";
import { Admin } from "../admin.ts";

// The contracts name tools before anything serves them. The admin refuses a registration that
// lists a tool nothing serves yet, so no client is ever registered half-way. Among the served ones:
// record (admin-agent.db.test.ts), build_context_pack, and the work and run tools and the kind
// reasoner (apps/pi/src/work/work-owner.db.test.ts).

describe("the admin: tools nothing serves yet", { timeout: 180_000 }, () => {
  it("a registration that lists a propose tool is refused", async () => {
    const store = await openStore({ writer: false });
    try {
      const refused = (made: ClientRegistration) => refusedWith(() => store.admin.clients.addClient(made));
      const invalid = { name: "AdminError", code: "invalid_registration" };
      const withTools = (name: string, tools: string[], more: Partial<ClientRegistration> = {}) =>
        registration(name, ["own"], { tools: tools as ClientRegistration["tools"], ...more });

      expect(await refused(withTools("drafts", ["get_self", "draft_message"]))).toEqual(invalid);
      expect(await store.admin.clients.listClients()).toEqual([]);

      // The positive control: the same registration without them, with the kind agent named
      // and left out, is taken.
      await store.admin.clients.addClient(withTools("records", ["get_self"]));
      await store.admin.clients.addClient(withTools("works", ["get_self", "search"], { kind: "agent" }));
      expect((await store.admin.clients.listClients()).map((row) => row.name)).toEqual(["records", "works"]);
    } finally {
      await store.close();
    }
  });

  it("a registration that lists build_context_pack is taken, by addClient and by setTools", async () => {
    const store = await openStore({ writer: false });
    try {
      await store.admin.clients.addClient(
        registration("packs", ["own"], { tools: ["get_self", "build_context_pack"] }),
      );
      await store.admin.clients.addClient(registration("later", ["own"], { tools: ["get_self"] }));
      await store.admin.clients.setTools("later", ["get_self", "find_messages", "read_message", "build_context_pack"]);
      expect((await store.admin.clients.listClients()).map((row) => [row.name, row.tools])).toEqual([
        ["later", ["get_self", "find_messages", "read_message", "build_context_pack"]],
        ["packs", ["get_self", "build_context_pack"]],
      ]);
    } finally {
      await store.close();
    }
  });

  it("a registration that lists sync_memory is taken, by addClient and by setTools, and the memory reads answer", async () => {
    const store = await openStore({ writer: false });
    try {
      await store.admin.clients.addClient(registration("memory", ["own"], { tools: ["get_self", "sync_memory"] }));
      await store.admin.clients.addClient(registration("later", ["own"], { tools: ["get_self"] }));
      await store.admin.clients.setTools("later", ["get_self", "sync_memory"]);
      expect((await store.admin.clients.listClients()).map((row) => [row.name, row.tools])).toEqual([
        ["later", ["get_self", "sync_memory"]],
        ["memory", ["get_self", "sync_memory"]],
      ]);
      expect((await store.admin.agents.memoryStatus()).clients.map((row) => row.name)).toEqual(["later", "memory"]);
      expect(await store.admin.agents.memoryExposures()).toEqual({ exposures: [], more: false });
    } finally {
      await store.close();
    }
  });

  it("a registration that lists get_evidence_span and read_item is taken", async () => {
    const store = await openStore({ writer: false });
    try {
      await store.admin.clients.addClient(
        registration("evidence", ["own"], { tools: ["get_self", "get_evidence_span", "read_item"] }),
      );
      await store.admin.clients.addClient(registration("later", ["own"], { tools: ["get_self"] }));
      await store.admin.clients.setTools("later", ["get_self", "read_item"]);
      expect((await store.admin.clients.listClients()).map((row) => [row.name, row.tools])).toEqual([
        ["evidence", ["get_self", "get_evidence_span", "read_item"]],
        ["later", ["get_self", "read_item"]],
      ]);
    } finally {
      await store.close();
    }
  });

  it("a registration that lists fetch_template is taken, by addClient and by setTools", async () => {
    const store = await openStore({ writer: false });
    try {
      await store.admin.clients.addClient(
        registration("templates", ["own"], { tools: ["get_self", "fetch_template"] }),
      );
      await store.admin.clients.addClient(registration("later", ["own"], { tools: ["get_self"] }));
      await store.admin.clients.setTools("later", ["get_self", "fetch_template"]);
      expect((await store.admin.clients.listClients()).map((row) => [row.name, row.tools])).toEqual([
        ["later", ["get_self", "fetch_template"]],
        ["templates", ["get_self", "fetch_template"]],
      ]);
    } finally {
      await store.close();
    }
  });

  it("a registration that lists a read tool of read-quotas-and-tools is refused until its step", async () => {
    const store = await openStore({ writer: false });
    try {
      const notBuilt = { name: "AdminError", code: "not_built" };
      await store.admin.clients.addClient(registration("later", ["own"], { tools: ["get_self"] }));
      const tool = "get_decision_history";
      expect(
        await refusedWith(() =>
          store.admin.clients.addClient(registration("helper", ["own"], { tools: ["get_self", tool] })),
        ),
        tool,
      ).toEqual(notBuilt);
      expect(await refusedWith(() => store.admin.clients.setTools("later", ["get_self", tool])), tool).toEqual(
        notBuilt,
      );
      // The positive control: the same registration and the same change without it are taken, and
      // get_suggestions, which is served, is taken too.
      await store.admin.clients.addClient(registration("helper", ["own"], { tools: ["get_self"] }));
      await store.admin.clients.addClient(
        registration("suggested", ["own"], { tools: ["get_self", "get_suggestions"] }),
      );
      await store.admin.clients.setTools("later", ["get_self", "search"]);
      expect((await store.admin.clients.listClients()).map((row) => [row.name, row.tools])).toEqual([
        ["helper", ["get_self"]],
        ["later", ["get_self", "search"]],
        ["suggested", ["get_self", "get_suggestions"]],
      ]);
    } finally {
      await store.close();
    }
  });

  it("propose_about_you and import_memory are taken beside record and refused without it", async () => {
    const store = await openStore({
      writer: false,
      compartments: ["own", "agent:proposer", "agent:later", "agent:alone"],
    });
    try {
      // An admin with record enabled, as PI_RECORD_ENABLED makes one, and the agent compartments
      // in the key file: the refusal is invalid_registration, not record_disabled or unknown_compartment.
      const admin = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, recordEnabled: true });
      const invalid = { name: "AdminError", code: "invalid_registration" };
      // Both write on record's agent lane, so each is refused without record.
      for (const tool of ["propose_about_you", "import_memory"] as const) {
        expect(
          await refusedWith(() =>
            admin.clients.addClient(registration("alone", ["own"], { tools: ["get_self", tool] })),
          ),
          tool,
        ).toEqual(invalid);
      }
      expect(await admin.clients.listClients()).toEqual([]);
      await admin.clients.addClient(registration("later", ["own"], { tools: ["get_self", "record"] }));
      for (const tool of ["propose_about_you", "import_memory"] as const) {
        expect(await refusedWith(() => admin.clients.setTools("later", ["get_self", tool])), tool).toEqual(invalid);
      }
      // The positive controls.
      await admin.clients.addClient(
        registration("proposer", ["own"], { tools: ["get_self", "record", "propose_about_you", "import_memory"] }),
      );
      await admin.clients.setTools("later", ["get_self", "record", "propose_about_you", "import_memory"]);
      expect((await admin.clients.listClients()).map((row) => [row.name, row.tools])).toEqual([
        ["later", ["get_self", "record", "propose_about_you", "import_memory"]],
        ["proposer", ["get_self", "record", "propose_about_you", "import_memory"]],
      ]);
    } finally {
      await store.close();
    }
  });
});
