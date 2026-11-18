import type { Mention, Passage } from "./evidence.ts";
import type { HttpRequest, HttpResponse } from "./http.ts";
import type { Resolution } from "./identity.ts";
import type { RequestId, Store, Vault } from "./ids.ts";
import type { Label } from "./label.ts";
import type { ModelCallKey, ModelCallRecord } from "./models.ts";
import type { OntologyType } from "./ontology.ts";

// Interfaces, not schemas. A port is here when the piece that takes it and the piece that
// builds it would otherwise have to guess its signature.

// Built by the service kit, which attaches the caller's signed service identity, applies the
// deadline and retries a read once.
export interface HttpPort {
  send(req: HttpRequest): Promise<HttpResponse>;
}

export interface OntologyView {
  get(type: string): OntologyType | null;
  ownerOf(type: string): Store | null;
  resolvePhrase(phrase: string): string[];
  descendants(type: string): string[];
}

// Resolving is a write, so it carries a request id. The pipeline derives it from the evidence
// item and the mention, so a lease retry repeats the same id. `from` is where the mention came
// from: its passage, that passage's vault and its label, the three fields the identity_resolve
// row takes, together or not at all.
export interface IdentityResolver {
  resolve(
    mention: Mention,
    store: Store,
    requestId: RequestId,
    from?: { passage: Passage; vault: Vault; label: Label },
  ): Promise<Resolution>;
}

export interface ModelCallStore {
  find(key: ModelCallKey): Promise<ModelCallRecord | null>;
  save(record: ModelCallRecord): Promise<void>;
}
