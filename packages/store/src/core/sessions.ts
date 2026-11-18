import type { ClientId, SessionId } from "@intelligence/contracts/personal";

// The remembered session of each client this process serves: one per client, from the first
// transaction that opened it and committed, until the process ends or the database refuses a write
// of it for a read of removed evidence. Nothing a client sends ends one, `initialize` included. The
// `Reader` builds one and exposes it as `reader.sessions`; a later object in the same process
// reaches the same sessions through it.
//
// A call reads the sessions before its transaction takes its snapshot (`known()`), so a session
// it is given was committed before that snapshot and is visible to it. Over stdio one call runs
// at a time; if two first calls of one client ever ran at once, each would open a session, and
// the first to commit is the one remembered.
export class Sessions {
  readonly #byClient = new Map<ClientId, SessionId>();

  of(client: ClientId): SessionId | undefined {
    return this.#byClient.get(client);
  }

  // A copy of what is remembered now.
  known(): ReadonlyMap<ClientId, SessionId> {
    return new Map(this.#byClient);
  }

  // Only once the transaction that opened it has committed. A client's first session stays.
  remember(client: ClientId, session: SessionId): void {
    if (!this.#byClient.has(client)) this.#byClient.set(client, session);
  }

  // A session the database refused for a read of removed evidence: the client's next call opens a
  // new one. Only that session: another call may have renewed it already.
  forget(client: ClientId, session: SessionId): void {
    if (this.#byClient.get(client) === session) this.#byClient.delete(client);
  }
}
