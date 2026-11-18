import type { CompiledFacts, EntityId, Who } from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { ownerAudience } from "../../core/audience.ts";
import { compiledFactsOf } from "../../read/read-compiled.ts";
import { loadGroups } from "../../read/read-groups.ts";
import { whoOf } from "../../read/read-who.ts";
import { ownerCtx } from "../owner-ctx.ts";

// The owner's page of a person or an organization in pi web: rendered by code at each read, never
// stored. As pi_admin, over the owner's audience's beliefs alone, so each fact shows once whatever
// clients are registered, with none, and compiled as get_entity compiles them: each belief with its
// citing claims, then the claims about the entity in none. It writes nothing.
type EntityPage = { entity: Who; facts: CompiledFacts };

export async function entityPage(admin: AdminContext, id: EntityId): Promise<EntityPage | null> {
  return admin.transaction(async (query) => {
    const ctx = ownerCtx(query, admin.keys, admin.log);
    const [entity] = await query<{ id: string; kind: "person" | "organization" }>(
      "select id, kind from knowledge.entities where id = $1 and kind in ('person', 'organization')",
      [id],
    );
    if (entity === undefined) return null;
    // A person's page is their group's, as the owner's rulings make it, its beliefs one list.
    const groups = await loadGroups(ctx, { owner: true });
    const members = entity.kind === "person" ? groups.membersOf(entity.id) : [entity.id];
    const who = (await whoOf(ctx, [entity.id])).get(entity.id) ?? { id, kind: entity.kind, name: null, address: null };
    const { facts } = await compiledFactsOf(ctx, entity, members, {
      claims: true,
      audience: await ownerAudience(query),
      groups,
      now: admin.now(),
    });
    return { entity: who, facts };
  });
}
