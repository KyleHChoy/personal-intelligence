import type { WebWriteName } from "@intelligence/contracts/personal";
import { type ReactNode, useState } from "react";
import { said, write } from "../api.ts";
import { type Block, Command, MoreList, Status as PartsStatus } from "../parts.tsx";
import { whenWords } from "../time-words.ts";
import { capital } from "../words.ts";

// The one place these rooms reach the older parts: the terminal command as it is drawn everywhere.
export { Command };

// What the System room's files and You share: the terminal fold, a read's state line, plain key and
// value rows, a sub-list, a row with one control, a write's busy and refusal, and count and time
// words. Every value is React text (W2).

// A command for the terminal, folded away until asked for (the mockup's `termFold`).
export function TermFold({ lines, note }: { lines: readonly string[]; note?: ReactNode }) {
  return (
    <details className="fold">
      <summary>In the terminal</summary>
      {note === undefined ? null : <p className="fold-note">{note}</p>}
      <Command lines={lines} />
    </details>
  );
}

// Plain rows of a value each, in an open body or a panel: [what, value, amber?].
export type Pair = readonly [string, string, boolean?];
// `bare` drops the sub-list wrapper, for rows straight in a panel's list, which keep its inset.
// With `limit`, what is wrong first and the rest behind "Show all".
export function Pairs({ rows, bare = false, limit }: { rows: readonly Pair[]; bare?: boolean; limit?: number }) {
  const line = ([k, v, warn]: Pair, n: number) => (
    <div key={`${k}-${n}`} className="row">
      <span className="what">
        <span className="t">{k}</span>
      </span>
      <span className={warn === true ? "meta warn" : "meta"}>{v}</span>
    </div>
  );
  const lines =
    limit === undefined ? (
      rows.map(line)
    ) : (
      <MoreList
        items={[...rows.filter((one) => one[2] === true), ...rows.filter((one) => one[2] !== true)]}
        limit={limit}
      >
        {line}
      </MoreList>
    );
  return bare ? lines : <div className="sub-list">{lines}</div>;
}

// Rows inside an open body, the first five shown and the rest behind "Show all".
export function SubList<T>({ items, children }: { items: readonly T[]; children: (item: T) => ReactNode }) {
  return (
    <div className="sub-list">
      <MoreList items={items} limit={5}>
        {children}
      </MoreList>
    </div>
  );
}

// A row holding one control at its end: a switch, a Lift.
export function CtlRow({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="row ctl">
      <span className="what">
        <span className="t">{title}</span>
        {sub === undefined ? null : <span className="s">{sub}</span>}
      </span>
      {children}
    </div>
  );
}

// One write at a time from one row: its busy flag, so a second press sends nothing, and its own
// refusal, so one row's failure never shows on another. `run` answers whether it was kept; the codes
// in `fine` count as kept.
export function useWrite() {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const run = async (name: WebWriteName, body: Record<string, unknown>, fine: string[] = []): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setRefused(null);
    const result = await write(name, body);
    setBusy(false);
    if (!result.ok && !fine.includes(result.code)) {
      setRefused(said(result.code));
      return false;
    }
    return true;
  };
  return { busy, refused, run, note: refused === null ? null : <p className="refused">{refused}</p> };
}

// An open body's labelled block, made by a call so a list of them needs no keys.
export const blk = (label: string | null, body: ReactNode): Block => [label, body];

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
export const when = (at: string): string => capital(whenWords(at));
export const gigabytes = (bytes: number): string => `${(bytes / 1_000_000_000).toFixed(1)} GB`;

// The one read-state part, under the name these rooms use.
export const ReadState = PartsStatus;
