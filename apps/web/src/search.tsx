import type { OwnerSearchItems, OwnerSearchResult } from "@intelligence/contracts/personal";
import { Fragment, type KeyboardEvent, useContext, useEffect, useRef, useState } from "react";
import { type Loaded, search } from "./api.ts";
import { factTypeWords, SUBJECT_WORDS, TIER_WORDS } from "./enum-words.ts";
import { ItemSheet, type OpenItem } from "./opens.tsx";
import { Empty, initials, Label, OpenRowContext, Status, TextField, TypedRow } from "./parts.tsx";
import { dateWords } from "./time-words.ts";
import { SEARCH_WAIT_MS, useAfterTyping } from "./typing.ts";
import { UNNAMED } from "./words.ts";

// Search, the page's one overlay: a palette in the middle of the screen, opened from the bar or with
// ⌘K or Ctrl-K. The term goes in a POST body only, never in a URL, each keystroke the owner's
// action, an answer to an older term dropped; 100 code units at most, the reads' SEARCH_TERM_MOST.
// People and organizations by name, address or mail domain; facts by their words; mail by subject
// and sender, grouped, each group best first. The arrow keys choose a match and Enter takes it: a
// person or an organization goes where it lives (`onPick`) and the palette closes; a fact or a
// message opens in place in the palette's own list.
export type Hit = OwnerSearchResult["hits"][number];
type FactHit = OwnerSearchItems["facts"][number];
type MailHit = OwnerSearchItems["mail"][number];
type Choice = {
  group: "People" | "Facts" | "Mail";
  key: string;
  title: string;
  sub: string;
  avatar: string | null;
  item: OpenItem | null;
  pick: () => void;
};

const MATCH_WORDS: Record<Hit["match"], string> = {
  name: "Their name matches",
  address: "Their address matches",
  domain: "Their mail domain matches",
};
// A hit's name; one with neither name nor address is never listed.
const nameOf = (hit: Hit): string => hit.who.name?.untrusted ?? hit.who.address?.untrusted ?? "";
const listable = (hit: Hit): boolean => nameOf(hit) !== "";
const join = (parts: readonly (string | null)[]): string => parts.filter((part) => part !== null).join(" · ");
const aboutOf = (fact: FactHit): string | null =>
  fact.self
    ? "About you"
    : fact.subject === null
      ? null
      : `About ${fact.subject.name?.untrusted ?? fact.subject.address?.untrusted ?? UNNAMED}`;
const itemKey = (item: OpenItem): string => `item-${item.kind}-${item.id}`;

const Glass = () => (
  <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export function Search({ onPick, onClose }: { onPick: (hit: Hit) => void; onClose: () => void }) {
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<Loaded<OwnerSearchResult> | null>(null);
  const [items, setItems] = useState<Loaded<OwnerSearchItems> | null>(null);
  // The match the arrow keys chose; the first, until the owner moves.
  const [active, setActive] = useState(0);
  const opened = useContext(OpenRowContext);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useAfterTyping(
    term,
    SEARCH_WAIT_MS,
    (trimmed, latest) => {
      setItems({ state: "loading" });
      void search("search", trimmed).then((answer) => {
        if (!latest()) return;
        setHits(answer);
        setActive(0);
      });
      void search("searchItems", trimmed).then((answer) => latest() && setItems(answer));
    },
    () => {
      setHits(null);
      setItems(null);
    },
  );

  // It opens ready for the term; focus stays inside it while it is open, and goes back to what
  // opened it when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => before?.focus?.();
  }, []);

  const people = hits?.state === "ready" ? hits.value.hits.filter(listable) : [];
  const facts = items?.state === "ready" ? items.value.facts : [];
  const mail = items?.state === "ready" ? items.value.mail : [];
  const openItem = (item: OpenItem): void => opened?.setOpen(opened.open === itemKey(item) ? null : itemKey(item));
  const choices: Choice[] = [
    ...people.map(
      (hit): Choice => ({
        group: "People",
        key: hit.who.id,
        title: nameOf(hit),
        sub: join([
          SUBJECT_WORDS[hit.who.kind],
          hit.tier === null ? null : TIER_WORDS[hit.tier],
          MATCH_WORDS[hit.match],
        ]),
        avatar: initials(nameOf(hit)),
        item: null,
        pick: () => onPick(hit),
      }),
    ),
    ...facts.map((fact): Choice => {
      const item: OpenItem = { kind: "fact", id: fact.fact };
      return {
        group: "Facts",
        key: fact.fact,
        title: fact.words.untrusted,
        sub: join([factTypeWords(fact.type), aboutOf(fact), dateWords(new Date(fact.at))]),
        avatar: null,
        item,
        pick: () => openItem(item),
      };
    }),
    ...mail.map((one: MailHit): Choice => {
      const item: OpenItem = { kind: "message", id: one.message };
      return {
        group: "Mail",
        key: one.message,
        title: one.subject?.untrusted ?? "No subject",
        sub: join([one.from === null ? null : `From ${one.from.untrusted}`, dateWords(new Date(one.at))]),
        avatar: null,
        item,
        pick: () => openItem(item),
      };
    }),
  ];
  // Still waiting on one of the two reads; a refused one says so on its own line.
  const loading = hits === null || hits.state === "loading" || items === null || items.state === "loading";
  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      // Focus stays in the palette: the page under it is not reachable while it is open.
      const all = [...(box.current?.querySelectorAll<HTMLElement>("input, button") ?? [])];
      const [first, last] = [all[0], all.at(-1)];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }
    if (event.target !== input.current || choices.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((was) => (was + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
    }
    const chosen = choices[active];
    if (event.key === "Enter" && chosen !== undefined) {
      event.preventDefault();
      chosen.pick();
    }
  };
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the shade behind the palette; a click on it is a mouse shortcut for Escape */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes the palette from the keyboard */}
      <div className="palette-scrim" onClick={onClose} />
      <div ref={box} className="palette" role="dialog" aria-modal="true" aria-label="Search" onKeyDown={keys}>
        <TextField
          label="Search people, facts, mail"
          hideLabel
          value={term}
          onChange={setTerm}
          maxLength={100}
          placeholder="People, facts, mail"
          inputRef={input}
          icon={<Glass />}
        />
        <div className="results" id="search-matches">
          {hits !== null && hits.state !== "ready" && hits.state !== "loading" ? (
            <Status loaded={hits} what="People" />
          ) : null}
          {items !== null && items.state !== "ready" && items.state !== "loading" ? (
            <Status loaded={items} what="Facts and mail" />
          ) : null}
          {hits === null && items === null ? (
            <Empty>People by name or mail address, facts by their words, mail by subject or sender.</Empty>
          ) : choices.length === 0 ? (
            <Empty>{loading ? "Looking." : "Nothing matches."}</Empty>
          ) : null}
          {choices.map((choice, index) => {
            const open = choice.item !== null && opened?.open === itemKey(choice.item);
            return (
              <Fragment key={`${choice.group}:${choice.key}`}>
                {choice.group === choices[index - 1]?.group ? null : <Label>{choice.group}</Label>}
                <TypedRow
                  lead={choice.avatar === null ? null : { av: choice.avatar }}
                  what={choice.title}
                  sub={choice.sub}
                  className={index === active ? "sel" : undefined}
                  onOpen={choice.pick}
                  expanded={choice.item === null ? undefined : open}
                />
                {open && choice.item !== null ? <ItemSheet item={choice.item} onClose={choice.pick} /> : null}
              </Fragment>
            );
          })}
        </div>
      </div>
    </>
  );
}
