import {
  type BlockCut,
  type BlockItem,
  type CaptureMention,
  CUT_NO_APP,
  type CutReasons,
  excludeSuffixes,
  type MeetingItem,
  type MomentItem,
  RESTRICTED_PREFIX,
  type RestrictedCategory,
  type TaskEvent,
  type TaskItem,
  taskEventsInOrder,
} from "@intelligence/contracts/personal";
import { recoveryHold, restrictedCategories } from "@intelligence/personal-core/items";
import { fingerprint, scopeNormal } from "../core/fingerprint.ts";
import type { Tx } from "../core/tx.ts";
import { defaultAdmits, isBrowserBundle, isMultiAccount } from "./capture-push.ts";

// What the drain admits, by code alone: the scope rule or default a surface falls under, the
// exclude list, and the system-id, recovery and restricted screening of an item's own text.

export type Item = MeetingItem | MomentItem | BlockItem | TaskItem;

export type Rule = {
  id: string;
  match: "bundle" | "host";
  value_fp: string;
  account_fp: string | null;
  compartment: string;
  kinds: string[];
  agent_app: boolean;
  source: string | null;
};

// What a run reads once, beside the rules: the exclude list's
// fingerprints, the account map by fingerprint, the capture clients of the devices in `deny` mode,
// and the box's own host.
export type Scope = {
  rules: Rule[];
  excludes: ReadonlySet<string>;
  accounts: ReadonlyMap<string, string>;
  deny: ReadonlySet<string>;
  boxHost: string | undefined;
};

function windows(text: string): string[] {
  const points = [...text];
  if (points.length <= 2000) return [text];
  const out: string[] = [];
  for (let at = 0; ; at += 1800) {
    out.push(points.slice(at, at + 2000).join(""));
    if (at + 2000 >= points.length) break;
  }
  return out;
}

export const recovery = (texts: (string | null | undefined)[]): boolean =>
  texts.some(
    (text) => typeof text === "string" && windows(text).some((one) => recoveryHold({ subject: null, text: one })),
  );

export const screened = (texts: (string | null | undefined)[], on: readonly RestrictedCategory[]): string[] =>
  on.length === 0
    ? []
    : [
        ...new Set(
          texts.flatMap((text) =>
            typeof text === "string"
              ? windows(text).flatMap((one) => restrictedCategories({ subject: null, text: one }, on))
              : [],
          ),
        ),
      ].map((category) => `${RESTRICTED_PREFIX}${category}`);

// A URL's path, as written and decoded.
export function pathOf(url: string | undefined): string[] {
  if (url === undefined) return [];
  const path = URL.parse(url)?.pathname ?? "";
  try {
    return [path, decodeURIComponent(path)];
  } catch {
    return [path];
  }
}

export const hostOf = (item: MomentItem): string | undefined =>
  item.url === undefined ? undefined : (URL.parse(item.url)?.hostname ?? undefined);

const mentionTexts = (mentions: (CaptureMention | undefined)[]): string[] =>
  mentions.flatMap((mention) =>
    mention === undefined
      ? []
      : [mention.name, mention.address, mention.handle].filter((one): one is string => one !== undefined),
  );

// A block day's are each block's own, since a block is dropped alone.
export const blockSystemTexts = (block: BlockItem["blocks"][number]): string[] =>
  [block.title, block.repository?.value, block.document?.value, block.folder?.value].filter(
    (one): one is string => one !== undefined,
  );
export function systemTexts(item: Exclude<Item, BlockItem>): string[] {
  switch (item.kind) {
    case "moment":
      return [
        item.text,
        item.window,
        item.thread,
        item.document,
        item.repository,
        ...pathOf(item.url),
        ...mentionTexts(item.participants),
      ].filter((one): one is string => one !== undefined);
    case "meeting":
      return [
        ...item.segments.map((segment) => segment.text),
        item.notes,
        item.title,
        item.calendar?.title,
        item.calendar?.uid,
        ...mentionTexts([
          ...item.speakers.map((speaker) => speaker.mention),
          item.calendar?.organizer,
          ...(item.calendar?.attendees ?? []),
        ]),
        // The owner-typed attendees.
        ...(item.attendees ?? []).flatMap((one) =>
          [one.name, one.email].filter((text): text is string => text !== undefined),
        ),
      ].filter((one): one is string => one !== undefined);
    case "task":
      return [item.title, item.project].filter((one): one is string => one !== undefined);
  }
}

// A surface with a host matches host rules only; a browser's with no host none; any other bundle
// rules. On a multi-account surface only a rule naming its account; elsewhere a rule naming its
// account wins over one naming none.
export function ruleOf(
  tx: Tx,
  rules: Rule[],
  kind: string,
  bundle: string,
  host: string | undefined,
  account: string | undefined,
  source: string | null = null,
): Rule | null {
  const bundleFp = fingerprint(tx.keys, "capture_scope", bundle);
  const hostFp = host === undefined ? null : fingerprint(tx.keys, "capture_scope", host);
  const accountFp = account === undefined ? null : fingerprint(tx.keys, "capture_scope", account);
  const multi = isMultiAccount({ bundle, ...(host === undefined ? {} : { host }) });
  const matching = rules.filter(
    (rule) =>
      rule.kinds.includes(kind) &&
      rule.source === source &&
      (hostFp !== null
        ? rule.match === "host" && rule.value_fp === hostFp
        : !isBrowserBundle(bundle) && rule.match === "bundle" && rule.value_fp === bundleFp) &&
      (multi
        ? rule.account_fp !== null && rule.account_fp === accountFp
        : rule.account_fp === null || rule.account_fp === accountFp),
  );
  return matching.find((rule) => rule.account_fp !== null) ?? matching[0] ?? null;
}

export function exclusionOf(tx: Tx, excludes: ReadonlySet<string>): (host: string | undefined) => boolean {
  const seen = new Map<string, boolean>();
  return (host) => {
    if (host === undefined || excludes.size === 0) return false;
    const normal = scopeNormal(host);
    let found = seen.get(normal);
    if (found === undefined) {
      found = excludeSuffixes(normal).some((suffix) => excludes.has(fingerprint(tx.keys, "capture_scope", suffix)));
      seen.set(normal, found);
    }
    return found;
  };
}

type Admitted = { compartment: string; byDefault: boolean } | { code: "excluded" | "out_of_scope" };
export function admitted(
  tx: Tx,
  scope: Scope,
  deny: boolean,
  excluded: (host: string | undefined) => boolean,
  bundle: string,
  host: string | undefined,
  account: string | undefined,
): Admitted {
  if (excluded(host)) return { code: "excluded" };
  const rule = ruleOf(tx, scope.rules, "block", bundle, host, account);
  if (rule !== null) return { compartment: rule.compartment, byDefault: false };
  if (!defaultAdmits({ deny, boxHost: scope.boxHost }, bundle, host)) return { code: "out_of_scope" };
  if (!isMultiAccount({ bundle, ...(host === undefined ? {} : { host }) }))
    return { compartment: "own", byDefault: true };
  const mapped = account === undefined ? undefined : scope.accounts.get(fingerprint(tx.keys, "capture_scope", account));
  return mapped === undefined ? { code: "out_of_scope" } : { compartment: mapped, byDefault: true };
}

// All but `other` are entries no rule could admit, whatever rules the owner holds.
export function cutReason(cut: BlockCut): keyof CutReasons {
  if (cut.app === CUT_NO_APP) return "no_app";
  if (isBrowserBundle(cut.app) && cut.host === undefined) return "no_host";
  if (
    cut.account === undefined &&
    isMultiAccount({ bundle: cut.app, ...(cut.host === undefined ? {} : { host: cut.host }) })
  )
    return "no_account";
  return "other";
}

// A viewer must hold all of them to be told.
export function unfiledCut(
  entries: readonly BlockCut[],
  compartments: readonly string[],
): { among: string[]; reasons: CutReasons } {
  const reasons: CutReasons = {};
  for (const entry of entries) {
    const reason = cutReason(entry);
    const held = reasons[reason] ?? { blocks: 0, minutes: 0 };
    reasons[reason] = {
      blocks: held.blocks + entry.blocks,
      minutes: Math.round((held.minutes + entry.minutes) * 10) / 10,
    };
  }
  return { among: compartments.filter((one) => !one.startsWith(RESTRICTED_PREFIX)).sort(), reasons };
}

export const BLOCK_DROPS = ["excluded", "out_of_scope", "system_ids", "recovery"] as const;

// A revoked client keeps the clearance it had.
export async function agentOf(tx: Tx, rule: Rule): Promise<{ compartments: string[] } | undefined> {
  if (!rule.agent_app) return undefined;
  const [label] = await tx.query<{ compartments: string[] | null }>(
    "select policy.agent_app_label($1) as compartments",
    [rule.id],
  );
  if (label?.compartments === null || label?.compartments === undefined)
    throw new Error("capture: the agent-app rule is gone");
  return { compartments: label.compartments };
}

export function badEvents(raw: unknown): boolean {
  const events =
    typeof raw === "object" && raw !== null && "events" in raw ? (raw as { events: unknown }).events : undefined;
  if (!Array.isArray(events) || events.length === 0) return false;
  const read = events.map((event) =>
    typeof event === "object" && event !== null ? (event as { kind?: unknown; at?: unknown }) : {},
  );
  if (
    read.some(
      (event) => typeof event.kind !== "string" || typeof event.at !== "string" || Number.isNaN(Date.parse(event.at)),
    )
  )
    return false;
  return !taskEventsInOrder(read as TaskEvent[]);
}
