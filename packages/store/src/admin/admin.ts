import { CodedError, type PersonalLogger } from "@intelligence/contracts/personal";
import { systemNow } from "@intelligence/personal-core";
import type pg from "pg";
import type { AdminContext } from "../core/admin-context.ts";
import { pinClock } from "../core/answer-time.ts";
import { driverError, endOwnPool, inTransaction, ownPool, type Query, TRANSACTION, tlsUnverified } from "../core/db.ts";
import type { Keys } from "../core/keys.ts";
import { calibrationAdmin, cardsAdmin, learningAdmin } from "./cards/cards-group.ts";
import { accountsAdmin, clientsAdmin, driveAdmin, secretsAdmin } from "./clients/clients-group.ts";
import { erasureAdmin, heldAdmin, restrictedAdmin, retentionAdmin } from "./erasure/erasure-group.ts";
import { extractionAdmin, mentionsAdmin } from "./extraction/extraction-group.ts";
import { selfAdmin } from "./history/history-group.ts";
import { lensAdmin } from "./lens/lens-group.ts";
import { boxAdmin } from "./outcomes/outcomes-group.ts";
import { listsAdmin, namesAdmin, notesAdmin, peopleAdmin, tiersAdmin } from "./people/people-group.ts";
import { areasAdmin, projectsAdmin } from "./projects/projects-group.ts";
import { factsAdmin, identityAdmin, ignoresAdmin, promotionsAdmin, releasesAdmin } from "./rulings/rulings-group.ts";
import { dropNameIndex, type NameIndexHolder } from "./search/admin-search.ts";
import { dropItemIndexes, type ItemsHolder } from "./search/admin-search-items.ts";
import { itemsAdmin, searchAdmin } from "./search/search-group.ts";
import { ledgerAdmin, timeAdmin } from "./time/time-group.ts";
import { agentsAdmin, commitmentsAdmin, openItemsAdmin, researchAdmin, workAdmin } from "./work/work-group.ts";

// The admin, run as pi_admin, for the owner CLI. It uses only pool.connect(), client.query(text,
// values) and client.release(), and every value goes to the database as a bind parameter.

export class Admin {
  readonly #pool: pg.Pool;
  readonly #keys: Keys;
  readonly #log: PersonalLogger;
  readonly #now: () => Date;
  // The clock a test pinned, which its reads are computed as of (answer-time.ts); none live.
  readonly #pinned: (() => Date) | undefined;
  readonly #recordEnabled: boolean;
  readonly #journal: string | undefined;
  readonly #tlsUnverified: boolean;
  readonly #names: NameIndexHolder = { index: null };
  readonly #items: ItemsHolder = { facts: null, mail: null, generation: 0 };

  // The caller owns this pool and ends it; close() ends only a pool createAdmin made.
  // `recordEnabled` is the deployment's PI_RECORD_ENABLED: until it is set, no client may be given
  // record, since agent records are rows nothing can rebuild and the owner decides backups first.
  // `journal` is the erasure journal's path, which the erasure methods need.
  constructor(options: {
    pool: pg.Pool;
    keys: Keys;
    log: PersonalLogger;
    now?: () => Date;
    recordEnabled?: boolean;
    journal?: string;
    tlsUnverified?: boolean;
  }) {
    this.#pool = options.pool;
    this.#keys = options.keys;
    this.#log = options.log;
    this.#now = options.now ?? systemNow;
    this.#pinned = options.now;
    this.#recordEnabled = options.recordEnabled ?? false;
    this.#journal = options.journal;
    this.#tlsUnverified = options.tlsUnverified ?? false;
    const context = this.#context;
    this.clients = clientsAdmin(context);
    this.agents = agentsAdmin(context);
    this.accounts = accountsAdmin(context);
    this.secrets = secretsAdmin(context);
    this.tiers = tiersAdmin(context);
    this.people = peopleAdmin(context);
    this.lists = listsAdmin(context);
    this.held = heldAdmin(context);
    this.drive = driveAdmin(context);
    this.identity = identityAdmin(context, this.#pool);
    this.ignores = ignoresAdmin(context);
    this.cards = cardsAdmin(context);
    this.mentions = mentionsAdmin(context);
    this.ledger = ledgerAdmin(context);
    this.erasure = erasureAdmin(context, (erasure) => this.#dropNames(erasure));
    this.notes = notesAdmin(context);
    this.lens = lensAdmin(context, (erasure) => this.#dropNames(erasure));
    this.time = timeAdmin(context);
    this.research = researchAdmin(context);
    this.facts = factsAdmin(context);
    this.releases = releasesAdmin(context);
    this.commitments = commitmentsAdmin(context);
    this.openItems = openItemsAdmin(context);
    this.retention = retentionAdmin(context);
    this.box = boxAdmin(context);
    this.extraction = extractionAdmin(context);
    this.restricted = restrictedAdmin(context);
    this.search = searchAdmin(context, this.#names, this.#items);
    this.items = itemsAdmin(context);
    this.names = namesAdmin(context);
    this.self = selfAdmin(context);
    this.projects = projectsAdmin(context);
    this.areas = areasAdmin(context);
    this.work = workAdmin(context);
    this.calibration = calibrationAdmin(context);
    this.learning = learningAdmin(context);
    this.promotions = promotionsAdmin(context);
  }

  // The owner's commands and reads by domain, each in its feature folder's `<folder>-group.ts`.
  readonly clients: ReturnType<typeof clientsAdmin>;
  readonly agents: ReturnType<typeof agentsAdmin>;
  readonly accounts: ReturnType<typeof accountsAdmin>;
  readonly secrets: ReturnType<typeof secretsAdmin>;
  readonly tiers: ReturnType<typeof tiersAdmin>;
  readonly people: ReturnType<typeof peopleAdmin>;
  readonly lists: ReturnType<typeof listsAdmin>;
  readonly held: ReturnType<typeof heldAdmin>;
  readonly drive: ReturnType<typeof driveAdmin>;
  readonly identity: ReturnType<typeof identityAdmin>;
  readonly ignores: ReturnType<typeof ignoresAdmin>;
  readonly cards: ReturnType<typeof cardsAdmin>;
  readonly mentions: ReturnType<typeof mentionsAdmin>;
  readonly ledger: ReturnType<typeof ledgerAdmin>;
  readonly erasure: ReturnType<typeof erasureAdmin>;
  readonly notes: ReturnType<typeof notesAdmin>;
  readonly lens: ReturnType<typeof lensAdmin>;
  readonly time: ReturnType<typeof timeAdmin>;
  readonly research: ReturnType<typeof researchAdmin>;
  readonly facts: ReturnType<typeof factsAdmin>;
  readonly releases: ReturnType<typeof releasesAdmin>;
  readonly commitments: ReturnType<typeof commitmentsAdmin>;
  readonly openItems: ReturnType<typeof openItemsAdmin>;
  readonly retention: ReturnType<typeof retentionAdmin>;
  readonly box: ReturnType<typeof boxAdmin>;
  readonly extraction: ReturnType<typeof extractionAdmin>;
  readonly restricted: ReturnType<typeof restrictedAdmin>;
  readonly search: ReturnType<typeof searchAdmin>;
  readonly items: ReturnType<typeof itemsAdmin>;
  readonly names: ReturnType<typeof namesAdmin>;
  readonly self: ReturnType<typeof selfAdmin>;

  // The owner's project commands, in admin-projects.ts. Each refusal is an AdminError;
  // anchor and unanchor throw "extract_running" while a run holds the extract lock.
  readonly projects: ReturnType<typeof projectsAdmin>;
  // The owner's area commands, in admin-areas.ts.
  readonly areas: ReturnType<typeof areasAdmin>;

  // The owner's commands of durable work, in admin-work.ts.
  readonly work: ReturnType<typeof workAdmin>;
  // The decide model's calibration, in admin-calibration.ts.
  readonly calibration: ReturnType<typeof calibrationAdmin>;

  // The owner's commands and reads of learning and evaluation, in admin-learning.ts.
  readonly learning: ReturnType<typeof learningAdmin>;

  // The promotion gate and its intake (promotion/), the only way a fact leaves this instance.
  readonly promotions: ReturnType<typeof promotionsAdmin>;

  // A database error reaches the caller as `unavailable`: an SQLSTATE is not a code. The log
  // line carries the code and nothing of the statement or its values. Nothing of the driver's
  // error is kept but its SQLSTATE and the name of a constraint: its message and its detail can
  // quote a bound value.
  #unavailable(error: unknown): Error {
    this.#log.error({ event: "admin_failed", code: "unavailable" });
    return new CodedError("unavailable", { cause: driverError(error) });
  }

  // One transaction on one connection: it commits whole or not at all.
  #transaction<T>(fn: (query: Query) => Promise<T>): Promise<T> {
    const pinned = this.#pinned;
    return inTransaction(
      this.#pool,
      TRANSACTION,
      (error) => this.#unavailable(error),
      pinned === undefined
        ? fn
        : (query) => {
            pinClock(query, pinned);
            return fn(query);
          },
    );
  }

  // The owner surface: the queue and vetoes and the erasure, each in one transaction, each in its
  // own file.
  get #context(): AdminContext {
    return {
      transaction: (fn) => this.#transaction(fn),
      keys: this.#keys,
      log: this.#log,
      now: this.#now,
      recordEnabled: this.#recordEnabled,
      tlsUnverified: this.#tlsUnverified,
      ...(this.#journal === undefined ? {} : { journal: this.#journal }),
    };
  }

  async #dropNames<T>(erasure: Promise<T>): Promise<T> {
    try {
      return await erasure;
    } finally {
      dropNameIndex(this.#names);
      dropItemIndexes(this.#items);
    }
  }

  // Ends the pool createAdmin made, once. A pool the caller made is the caller's to end.
  close(): Promise<void> {
    return endOwnPool(this.#pool);
  }
}

// Makes its own pool from url; the admin's close() ends it. A URL that does not parse is
// refused with a plain Error, code "bad_url", that holds no part of it.
export function createAdmin({
  url,
  keys,
  log,
  now,
  recordEnabled,
  journal,
  timeoutMs,
  poolSize = 2,
}: {
  url: string;
  keys: Keys;
  log: PersonalLogger;
  now?: () => Date;
  recordEnabled?: boolean;
  journal?: string;
  timeoutMs?: number;
  // Connections: 2 for a command; `pi web serve` takes more, since a room fires its reads at once.
  poolSize?: number;
}): Admin {
  const pool = ownPool(url, poolSize, log, { timeoutMs });
  return new Admin({
    pool,
    keys,
    log,
    tlsUnverified: tlsUnverified(url),
    ...(now === undefined ? {} : { now }),
    ...(recordEnabled === undefined ? {} : { recordEnabled }),
    ...(journal === undefined ? {} : { journal }),
  });
}
