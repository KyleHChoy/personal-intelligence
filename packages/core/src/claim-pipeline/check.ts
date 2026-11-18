import {
  type BasisType,
  type ChangeKind,
  type Claim,
  type ClaimCandidate,
  ClaimId,
  DateOnly,
  type FieldSpec,
  type Fingerprint,
  type Label,
  type LocalEntityId,
  Mention,
  type NarrowingValue,
  type OntologyType,
  type OntologyView,
  type ParsedItem,
  type ParsedSegment,
  RequestId,
  type ReviewId,
  type Sha256,
  type Store,
  type SubjectAlias,
  Timestamp,
} from "@intelligence/contracts";
import { aliasFingerprint, aliasKeyNormal } from "@intelligence/contracts/alias-key";
import { PipelineError } from "./errors.ts";
import { canonical, sha256 } from "./hash.ts";
import { narrow } from "./labels.ts";
import { segmentFinder } from "./parse.ts";
import type { PipelineDeps, Unmapped, UnmappedReason } from "./ports.ts";
import { addressesIn } from "./quotes.ts";
import { combinedLabel, type ReadItem } from "./read-set.ts";
import { PIPELINE_VERSION } from "./version.ts";

// The checker is code. It turns what the interpreter proposed into claims, and takes nothing
// from the proposal but its content: the store, the label, the author, the basis, the id and
// every stamp are worked out here.

// What the checker knows of the item beside its candidates.
export interface ItemContext {
  // With the parties of its headers when the parser read an email (parse.ts, `Parsed`).
  parsed: ParsedItem & { parties?: { name: string; address: string }[] };
  // The replies the message answers that were read, nearest first.
  chain: ParsedItem[];
  narrowing: NarrowingValue;
  changeKind: ChangeKind;
  // The hash of the prompt the interpreter was shown, as `interpret` returns it.
  inputHash: Sha256;
  // Set for an enforced policy of the document lane. A document's text has no author, so a claim
  // that cites it is credited to nobody and is never first-hand. For any other item, a claim that
  // cites text with no author is stored unmapped.
  document?: true;
}

export interface Checked {
  claims: Claim[];
  unmapped: Unmapped[];
  reviews: ReviewId[];
}

export type GroundingHook = (mention: Mention, segment: ParsedSegment) => boolean;
type CheckDeps = Pick<
  PipelineDeps,
  "config" | "extractorGeneration" | "ontology" | "identity" | "rerun" | "fingerprintKey"
> & { grounded?: GroundingHook };

// One field's value as its declared kind, or undefined when it is not of that kind. An entity
// field holds a mention until it is resolved.
function typedValue(spec: FieldSpec, value: unknown, ontology: OntologyView): unknown {
  switch (spec.kind) {
    case "text":
      return typeof value === "string" ? value : undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "date":
      return Timestamp.safeParse(value).success || DateOnly.safeParse(value).success ? value : undefined;
    case "enum":
      return typeof value === "string" && spec.values?.includes(value) === true ? value : undefined;
    case "type": {
      if (typeof value !== "string") return undefined;
      if (ontology.get(value) !== null) return value;
      const [only, ...rest] = ontology.resolvePhrase(value);
      return rest.length === 0 ? only : undefined;
    }
    case "entity": {
      const mention = Mention.safeParse(value);
      return mention.success ? mention.data : undefined;
    }
  }
}

// Null when they do not fit.
function typedFields(
  type: OntologyType,
  fields: Record<string, unknown>,
  ontology: OntologyView,
): Record<string, unknown> | null {
  if (Object.keys(fields).some((name) => !type.fields.some((spec) => spec.name === name))) return null;
  const typed: Record<string, unknown> = {};
  for (const spec of type.fields) {
    if (!Object.hasOwn(fields, spec.name)) {
      if (spec.required) return null;
      continue;
    }
    const value = typedValue(spec, fields[spec.name], ontology);
    if (value === undefined) return null;
    typed[spec.name] = value;
  }
  return typed;
}

// `narrow` can only add a compartment it is allowed, and remove or keep readers; it cannot add a
// reader.
function narrowed(base: Label, context: ItemContext, own: ReadItem, deps: CheckDeps): Label {
  switch (context.narrowing) {
    case "participants_only":
      // The members on the message itself, as ingest recorded them on the item when it wrote
      // it. Nothing else says who they are, and no directory is asked: with no record of them,
      // nobody reads the claim.
      return narrow(base, { keepReaders: own.item.participantMembers ?? [] }, []);
    case "special_category": {
      const special = deps.config.specialCategoryCompartment;
      return narrow(base, { addCompartments: [special] }, [special]);
    }
    default:
      return base;
  }
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

// What a message's sender wrote themselves, as one run of text with single spaces, and the
// places in it where a line or a sentence starts and ends.
interface OwnWords {
  text: string;
  starts: Set<number>;
  ends: Set<number>;
}

function ownWordsOf(reply: ParsedItem): OwnWords {
  const starts = new Set<number>();
  const ends = new Set<number>();
  const lines: string[] = [];
  let length = 0;
  for (const segment of reply.segments) {
    if (segment.quoted || !segment.span.startsWith("chars:")) continue;
    for (const raw of segment.text.split("\n")) {
      const line = squash(raw);
      if (line === "") continue;
      const offset = length === 0 ? 0 : length + 1;
      starts.add(offset);
      for (let at = 0; at < line.length; at += 1) {
        const stop = line[at] === "." || line[at] === "!" || line[at] === "?";
        if (!stop || (at + 1 < line.length && line[at + 1] !== " ")) continue;
        ends.add(offset + at + 1);
        starts.add(offset + at + 2);
      }
      lines.push(line);
      length = offset + line.length;
      ends.add(length);
    }
  }
  return { text: lines.join(" "), starts, ends };
}

// Whether the quote stands in the words as whole lines or whole sentences: it starts where
// one starts and ends where one ends. A fragment cut from inside a sentence does not, so a
// quote cannot drop a "not" or part of a word and still be the author's. The search reads
// each text once, however repetitive they are.
function holdsWhole(words: OwnWords, quote: string): boolean {
  const { text } = words;
  if (quote === "" || quote.length > text.length) return false;
  const fallback = new Int32Array(quote.length);
  for (let at = 1, matched = 0; at < quote.length; at += 1) {
    while (matched > 0 && quote[at] !== quote[matched]) matched = fallback[matched - 1] as number;
    if (quote[at] === quote[matched]) matched += 1;
    fallback[at] = matched;
  }
  for (let at = 0, matched = 0; at < text.length; at += 1) {
    while (matched > 0 && text[at] !== quote[matched]) matched = fallback[matched - 1] as number;
    if (text[at] === quote[matched]) matched += 1;
    if (matched < quote.length) continue;
    if (words.starts.has(at + 1 - matched) && words.ends.has(at + 1)) return true;
    matched = fallback[matched - 1] as number;
  }
  return false;
}

function quoteVerifier(chain: ParsedItem[]): (segment: ParsedSegment) => boolean {
  const written = new Map<ParsedItem, OwnWords>();
  const ownWords = (reply: ParsedItem): OwnWords => {
    let words = written.get(reply);
    if (words === undefined) {
      words = ownWordsOf(reply);
      written.set(reply, words);
    }
    return words;
  };
  const checked = new Map<ParsedSegment, boolean>();
  return (segment) => {
    let found = checked.get(segment);
    if (found === undefined) {
      const quote = squash(segment.text);
      found = chain.some(
        (reply) =>
          !reply.automated &&
          reply.headers.from?.[0] === segment.author?.key.value &&
          holdsWhole(ownWords(reply), quote),
      );
      checked.set(segment, found);
    }
    return found;
  };
}

type Resolved = { entity: LocalEntityId; epoch: number } | { review: ReviewId } | null;

// The keys the subject was resolved by, for the store's alias and search rows. An address or
// a source id goes as its fingerprint under the deployment's key, never itself. A name goes as
// the evidence wrote it: the subject's own name-only mention, or the display name the item's
// headers give the subject's address. Nothing here comes from the model but the mention
// the identity service already resolved. A key with an empty normal form is left out.
function aliasesOf(
  subject: Mention,
  parsed: ItemContext["parsed"],
  fingerprintKey: Uint8Array | undefined,
): SubjectAlias[] {
  const name = (value: string): SubjectAlias[] => {
    const written = value.normalize("NFKC").trim().replaceAll(/\s+/gu, " ").slice(0, 200);
    return written === "" ? [] : [{ kind: "name", value: written }];
  };
  const { kind, value } = subject.key;
  if (kind === "name") return name(value);
  let fingerprint: Fingerprint;
  try {
    fingerprint = aliasFingerprint(kind, value, fingerprintKey);
  } catch {
    return [];
  }
  const party =
    kind === "address"
      ? parsed.parties?.find(
          (one) =>
            aliasKeyNormal("address", one.address) === aliasKeyNormal("address", value) && one.name.trim() !== "",
        )
      : undefined;
  return [{ kind, fingerprint }, ...(party === undefined ? [] : name(party.name))];
}

export async function check(
  candidates: ClaimCandidate[],
  readSet: ReadItem[],
  context: ItemContext,
  deps: CheckDeps,
): Promise<Checked> {
  const { parsed } = context;
  const own = readSet.find((read) => read.item.id === parsed.evidenceId);
  if (own === undefined) throw new PipelineError("check_failed");
  if (own.item.sourceKind === "workbench_correction") throw new PipelineError("check_failed");
  const label = narrowed(combinedLabel(readSet), context, own, deps);

  const result: Checked = { claims: [], unmapped: [], reviews: [] };
  if (context.narrowing === "quarantine") return result;

  const observedAt = own.item.observedAt;
  const sender = parsed.headers.from?.[0];
  const senderMention: Mention | undefined =
    sender === undefined ? undefined : { key: { kind: "address", value: sender }, observedAt };
  const segmentOf = segmentFinder(parsed);
  const verifiedQuote = quoteVerifier(context.chain);
  const grounded = new Set(["from", "to", "cc", "bcc"].flatMap((header) => parsed.headers[header] ?? []));
  for (const segment of parsed.segments) for (const address of addressesIn(segment.text)) grounded.add(address);

  // Its time is the item's, never the model's.
  const stamped = (mention: Mention): Mention => ({
    key: {
      kind: mention.key.kind,
      value: mention.key.kind === "address" ? mention.key.value.toLowerCase() : mention.key.value,
    },
    observedAt,
  });
  const isGrounded = (mention: Mention, segment: ParsedSegment): boolean =>
    mention.key.kind === "name" ||
    (mention.key.kind === "address" && grounded.has(mention.key.value)) ||
    deps.grounded?.(mention, segment) === true;

  // The request id says where the mention stood, in the output for which revision, generation and
  // prompt, not what it was. So a retry repeats it, an extraction that was shown anything else
  // never gets another one's answer, and a log of ids gives nothing away. A failed call fails the
  // item: no claim gets a guessed identity.
  const resolutions = new Map<string, Promise<Resolved>>();
  const resolve = (mention: Mention, store: Store, position: number, role: string, span: string): Promise<Resolved> => {
    const key = JSON.stringify([store, mention.key.kind, mention.key.value]);
    let resolved = resolutions.get(key);
    if (resolved === undefined) {
      const place = [parsed.evidenceId, parsed.revision, deps.extractorGeneration, context.inputHash, position, role];
      // Where the mention came from: the passage its claim cites, in this vault, under the
      // label the claim carries. The identity service binds the mention to that passage and
      // labels a review it files with it.
      const from = { passage: { evidenceId: parsed.evidenceId, span }, vault: deps.config.vault, label };
      const ask = async (): Promise<Resolved> => {
        let resolution = await deps.identity.resolve(mention, store, RequestId.parse(sha256(place)), from);
        // The item is run again because a review held a claim of it back. The first answer is
        // on record under the id above, so the mention is asked about once more under an id
        // that names its review and this run: the identity service answers by the review's
        // decision once there is one, and with the same review until then.
        if (resolution.outcome === "candidate" && deps.rerun !== undefined) {
          resolution = await deps.identity.resolve(
            mention,
            store,
            RequestId.parse(sha256([...place, "review", resolution.reviewId, deps.rerun])),
            from,
          );
        }
        if (resolution.outcome === "linked") return { entity: resolution.entity, epoch: resolution.epoch };
        // A name alone never creates anybody.
        if (resolution.outcome === "created")
          return mention.key.kind === "name" ? null : { entity: resolution.entity, epoch: resolution.epoch };
        return resolution.outcome === "candidate" ? { review: resolution.reviewId } : null;
      };
      resolved = ask().catch(() => {
        throw new PipelineError("control_unavailable");
      });
      resolutions.set(key, resolved);
    }
    return resolved;
  };

  const seen = new Set<ClaimId>();
  for (const [position, candidate] of candidates.entries()) {
    const type = deps.ontology.get(candidate.type);
    const store = type === null ? null : deps.ontology.ownerOf(type.id);
    const fields = type === null ? null : typedFields(type, candidate.fields, deps.ontology);
    const segment = segmentOf(candidate.span);
    const subject = stamped(candidate.subject);
    const within = candidate.context?.mention === undefined ? undefined : stamped(candidate.context.mention);
    // A claim must say when it was true from. With no start given, that is when the item was
    // observed, or the end the candidate gave when that is earlier: a statement about the past.
    const ended = candidate.validTo !== undefined && Date.parse(candidate.validTo) < Date.parse(observedAt);
    const validFrom = candidate.validFrom ?? (ended ? (candidate.validTo as string) : observedAt);

    // The sender for their own words, and the original author for a quote found in a message of
    // theirs that was read. Any other quote is a report by the sender who passed it on. An
    // automated sender is never a person.
    let speaker: Mention | undefined;
    if (segment?.author !== undefined) {
      if (segment.quoted && verifiedQuote(segment)) speaker = segment.author;
      else if (!parsed.automated) speaker = segment.quoted ? senderMention : segment.author;
    }
    // The basis follows from that, and from nothing the model said: first-hand only when the
    // subject wrote the words themselves, and a quote is never first-hand.
    const ownWords =
      segment?.quoted === false && speaker?.key.kind === subject.key.kind && speaker.key.value === subject.key.value;
    const basis: BasisType = ownWords ? "explicit_self" : "third_party";

    // The mentions in entity fields, by field name.
    const linked = new Map<string, Mention>();
    for (const spec of type?.fields ?? []) {
      if (spec.kind === "entity" && fields !== null && Object.hasOwn(fields, spec.name))
        linked.set(spec.name, stamped(fields[spec.name] as Mention));
    }
    const mentions = [subject, ...(within === undefined ? [] : [within]), ...linked.values()];

    // The content is taken before identity resolution, so a later merge does not move the id, and a
    // mention counts by its key alone, so the time a model put on it does not either.
    const named = Object.fromEntries([...linked].map(([name, mention]) => [name, mention.key]));
    const content = canonical({
      type: candidate.type,
      subject: subject.key,
      fields: fields === null ? candidate.fields : { ...fields, ...named },
      statementKind: candidate.statementKind,
      context: candidate.context === undefined ? null : { kind: candidate.context.kind, mention: within?.key ?? null },
      validFrom: candidate.validFrom ?? null,
      validTo: candidate.validTo ?? null,
      basis,
    });
    const id = ClaimId.parse(
      sha256([parsed.evidenceId, parsed.revision, candidate.span, content, deps.extractorGeneration]),
    );
    if (seen.has(id)) continue;
    seen.add(id);

    // The proposed type is an ontology id or "other", never the model's text.
    const reason: UnmappedReason | undefined =
      type === null || store === null
        ? "unknown_type"
        : fields === null
          ? "bad_fields"
          : segment === undefined
            ? "bad_span"
            : candidate.validFrom !== undefined &&
                candidate.validTo !== undefined &&
                Date.parse(candidate.validTo) < Date.parse(candidate.validFrom)
              ? "bad_times"
              : !mentions.every((mention) => isGrounded(mention, segment))
                ? "ungrounded_mention"
                : segment.author === undefined && context.document !== true
                  ? "author_unknown"
                  : undefined;
    if (type === null || store === null || fields === null || segment === undefined || reason !== undefined) {
      result.unmapped.push({
        id,
        evidenceId: parsed.evidenceId,
        proposedType: type?.id ?? "other",
        pipelineVersion: PIPELINE_VERSION,
        label,
        reason: reason ?? "unknown_type",
      });
      continue;
    }

    // The subject, the context and every entity field must be a known entity. One that is only
    // a candidate holds the claim back until a person rules.
    const reviews: ReviewId[] = [];
    let settled = true;
    const entityOf = async (
      mention: Mention,
      role: string,
    ): Promise<{ entity: LocalEntityId; epoch: number } | null> => {
      const resolved = await resolve(mention, store, position, role, candidate.span);
      if (resolved !== null && "entity" in resolved) return resolved;
      if (resolved !== null) reviews.push(resolved.review);
      settled = false;
      return null;
    };
    const about = await entityOf(subject, "subject");
    const inside = within === undefined ? null : await entityOf(within, "context");
    for (const [index, [name, mention]] of [...linked].entries())
      fields[name] = (await entityOf(mention, `field:${index}`))?.entity;
    if (about === null || !settled) {
      result.reviews.push(...reviews);
      continue;
    }
    const by = speaker === undefined ? null : await resolve(speaker, store, position, "speaker", candidate.span);
    const subjectAliases = aliasesOf(subject, parsed, deps.fingerprintKey);

    result.claims.push({
      id,
      content: {
        type: type.id,
        subject: about.entity,
        fields,
        ...(candidate.context !== undefined && {
          context: { kind: candidate.context.kind, ...(inside !== null && { id: inside.entity }) },
        }),
      },
      statementKind: candidate.statementKind,
      basis,
      ...(by !== null && "entity" in by && { assertedBy: by.entity }),
      validFrom,
      ...(candidate.validTo !== undefined && { validTo: candidate.validTo }),
      evidence: [{ evidenceId: parsed.evidenceId, span: candidate.span }],
      primaryEvidenceId: parsed.evidenceId,
      label,
      destination: store,
      pipelineVersion: PIPELINE_VERSION,
      extractorGeneration: deps.extractorGeneration,
      changeKind: context.changeKind,
      systemOriginated: own.item.systemOriginated,
      origin: "source",
      identityEpoch: about.epoch,
      ...(subjectAliases.length > 0 && { subjectAliases }),
    });
  }
  return result;
}
