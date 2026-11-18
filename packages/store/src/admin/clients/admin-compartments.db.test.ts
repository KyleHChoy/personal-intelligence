import type { PersonalTool } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAs } from "../../test-support/connections.ts";
import { queryAs } from "../../test-support/database.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { refusedWith, registration } from "../../test-support/values.ts";
import { Admin } from "../admin.ts";

// `pi clients set-compartments`: the owner widens an active client's clearance in place. A
// registration still never narrows, each compartment is one the key file holds, and the change is
// one combining_grant owner decision in its transaction. Made-up names only.

// The key file holds an agent key for each of these, and none for `agent:keyless`.
const AGENTS = ["lark", "wren", "kite", "gone", "plain", ...Array.from({ length: 29 }, (_, index) => `a${index + 1}`)];
const COMPARTMENTS = ["own", "employer:example", ...AGENTS.map((name) => `agent:${name}`)];
const TOOLS = ["get_self", "search", "record"] as PersonalTool[];

let store: TestStore;
let admin: Admin;

beforeAll(async () => {
  store = await openStore({ compartments: COMPARTMENTS, writer: false });
  admin = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, recordEnabled: true });
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await store.close();
});

type Row = { id: string; compartments: string[]; views: string[]; tools: string[]; token_hash: string };
const clientOf = async (name: string): Promise<Row | undefined> =>
  (
    await queryAs<Row>(
      store.db.urls.admin,
      "select id, compartments, views, tools, token_hash from policy.clients where name = $1",
      [name],
    )
  )[0];
const grants = (id: string | undefined) =>
  queryAs<{ target_kind: string; details: unknown; compartments: string[] }>(
    store.db.urls.admin,
    "select target_kind, details, compartments from knowledge.owner_decisions where kind = 'combining_grant' and target_id = $1 order by decided_at, id",
    [id],
  );
const clearanceOf = async (token: string): Promise<string[]> =>
  (await readAs(store.db, token, (query) => query<{ c: string[] }>("select policy.client_clearance() as c")))[0]?.c ??
  [];

describe("Admin.setCompartments", { timeout: DB_TEST_TIMEOUT }, () => {
  it("widens an active client in place, keeps its token, tools and views, and writes one combining_grant decision", async () => {
    const { token } = await admin.clients.addClient(registration("lark", ["own"], { tools: TOOLS }));
    const before = await clientOf("lark");
    expect(before?.compartments).toEqual(["own", "agent:lark"]);

    await admin.clients.setCompartments("lark", ["own", "agent:lark", "agent:wren"]);
    const after = await clientOf("lark");
    expect([...(after?.compartments ?? [])].sort()).toEqual(["agent:lark", "agent:wren", "own"]);
    expect({ ...after, compartments: [] }).toEqual({ ...before, compartments: [] });
    // The same token reads under the wider clearance.
    expect([...(await clearanceOf(token))].sort()).toEqual(["agent:lark", "agent:wren", "own"]);
    expect(await grants(after?.id)).toEqual([
      { target_kind: "client", details: { compartments: ["agent:lark", "agent:wren", "own"] }, compartments: ["own"] },
    ]);

    // The same set again changes nothing and writes no second decision, in any order.
    await admin.clients.setCompartments("lark", ["agent:wren", "own", "agent:lark"]);
    expect(await grants(after?.id)).toHaveLength(1);
  });

  it("refuses a compartment the key file lacks, or that is no compartment, and changes nothing", async () => {
    await admin.clients.addClient(registration("wren", ["own"], { tools: TOOLS }));
    const before = await clientOf("wren");
    expect(
      await refusedWith(() => admin.clients.setCompartments("wren", ["own", "agent:wren", "agent:keyless"])),
    ).toEqual({
      name: "AdminError",
      code: "unknown_compartment",
    });
    expect(await refusedWith(() => admin.clients.setCompartments("wren", ["own", "agent:wren", "nonsense"]))).toEqual({
      name: "AdminError",
      code: "invalid_registration",
    });
    expect(await refusedWith(() => admin.clients.setCompartments("wren", []))).toEqual({
      name: "AdminError",
      code: "invalid_registration",
    });
    expect(await clientOf("wren")).toEqual(before);
    expect(await grants(before?.id)).toEqual([]);
  });

  it("refuses more than 32 compartments", async () => {
    await admin.clients.addClient(registration("kite", ["own"], { tools: TOOLS }));
    const cap = [
      "own",
      "employer:example",
      "agent:kite",
      ...Array.from({ length: 29 }, (_, index) => `agent:a${index + 1}`),
    ];
    expect(cap).toHaveLength(32);
    expect(await refusedWith(() => admin.clients.setCompartments("kite", [...cap, "agent:lark"]))).toEqual({
      name: "AdminError",
      code: "too_many_compartments",
    });
    // The control: 32.
    await admin.clients.setCompartments("kite", cap);
    expect((await clientOf("kite"))?.compartments).toHaveLength(32);
  });

  it("refuses a revoked or unknown client", async () => {
    await admin.clients.addClient(registration("gone", ["own"], { tools: TOOLS }));
    await admin.clients.revokeClient("gone");
    expect(await refusedWith(() => admin.clients.setCompartments("gone", ["own", "agent:gone", "agent:lark"]))).toEqual(
      {
        name: "AdminError",
        code: "not_found",
      },
    );
    expect(await refusedWith(() => admin.clients.setCompartments("nobody", ["own"]))).toEqual({
      name: "AdminError",
      code: "not_found",
    });
  });

  it("refuses to drop any compartment the client holds, its own agent compartment included", async () => {
    // A record client's writes need its own agent compartment.
    expect(await refusedWith(() => admin.clients.setCompartments("lark", ["own", "agent:wren"]))).toEqual({
      name: "AdminError",
      code: "would_narrow",
    });
    // A client without record narrows no more than one with it.
    await admin.clients.addClient(registration("plain", ["own", "employer:example"], { tools: ["get_self"] }));
    const before = await clientOf("plain");
    expect(await refusedWith(() => admin.clients.setCompartments("plain", ["own", "agent:lark"]))).toEqual({
      name: "AdminError",
      code: "would_narrow",
    });
    expect(await clientOf("plain")).toEqual(before);
    expect(await grants(before?.id)).toEqual([]);
  });
});
