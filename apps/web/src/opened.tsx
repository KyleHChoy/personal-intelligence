import type { FactDetail, MessageView, OwnerDraft, OwnerMeeting, WebWriteName } from "@intelligence/contracts/personal";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import type { Loaded } from "./api.ts";
import type { RulingWords } from "./card-words.ts";
import { BELIEF_STATUS_WORDS } from "./enum-words.ts";
import { changeWords, editable, type FactChange, FactEdit, retirable, rulable } from "./fact-edit.tsx";
import { factSaidBy, factSentence } from "./facts.ts";
import { useFresh } from "./kept.ts";
import { Names, type OpenItem, RESPONSE_WORDS } from "./opens.tsx";
import { type Action, type Block, Command, Empty, OpenBody, Status, TaskBox } from "./parts.tsx";
import { rulingOf, useWrite } from "./rooms/people-parts.tsx";
import { dateWords, whenWords } from "./time-words.ts";
import { capital, NEVER_USE, UNNAMED } from "./words.ts";

const NEXT_RUN = "applies at the next run";

// What a row opens to: a message, as read_message serves it to an agent; a fact, by `factShow`, with
// the owner's rulings on it; a timeline's meeting; and a draft an agent made. Each is read only when
// the owner opens it, and drawn in place as one open body: its title, labelled blocks, one action
// bar. Everything a source or an agent wrote is shown as text. Sending a draft stays at a terminal.

// `pi web` answers a null read as 404 `not_found`.
const gone = (loaded: Loaded<unknown>): boolean =>
  (loaded.state === "failed" && loaded.code === "not_found") || (loaded.state === "ready" && loaded.value === null);

const Title = ({ children }: { children: ReactNode }) => <h3 className="subject">{children}</h3>;
const State = ({ children }: { children: ReactNode }) => <p className="state">{children}</p>;

// The one reader: what was read drawn by `body`, or why nothing is, with Close. Escape closes it
// without closing what it sits in (the search palette).
function Reader<T>({
  label,
  what,
  loaded,
  onClose,
  body,
}: {
  label: string;
  what: string;
  loaded: Loaded<T | null>;
  onClose: () => void;
  body: (value: T, close: Action) => ReactNode;
}) {
  const box = useRef<HTMLElement>(null);
  useEffect(() => box.current?.scrollIntoView?.({ block: "nearest" }), []);
  const close: Action = { label: "Close", kind: "quiet", onClick: onClose };
  const value = loaded.state === "ready" ? loaded.value : null;
  return (
    <section
      ref={box}
      className="reader"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      {value !== null ? (
        body(value, close)
      ) : (
        <OpenBody actions={[close]}>
          {gone(loaded) ? (
            <Empty>{`This ${what} is no longer held.`}</Empty>
          ) : (
            <Status loaded={loaded} what={`The ${what}`} />
          )}
        </OpenBody>
      )}
    </section>
  );
}

const sizeWords = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} bytes`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

// One message: who sent it and when, its subject, its text and its attachments by name.
function MessageSheet({ message, onClose }: { message: string; onClose: () => void }) {
  const loaded = useFresh("message", { message });
  return (
    <Reader
      label="A message"
      what="message"
      loaded={loaded}
      onClose={onClose}
      body={(shown, close) => <MessageBody message={shown} close={close} />}
    />
  );
}

function MessageBody({ message, close }: { message: MessageView; close: Action }) {
  const { sender, masked } = message;
  const from =
    sender === null
      ? null
      : sender.name === null
        ? sender.address.untrusted
        : `${sender.name.untrusted} (${sender.address.untrusted})`;
  const out = message.direction === "outbound";
  return (
    <OpenBody
      lead={[<Title key="t">{message.subject?.untrusted ?? "No subject"}</Title>]}
      blocks={[
        [
          out ? "You wrote" : "From",
          out ? capital(whenWords(message.at)) : `${from ?? capital(UNNAMED)}, ${whenWords(message.at)}`,
        ],
        ["Attached", message.attachmentList.map((one) => `${one.name.untrusted} (${sizeWords(one.size)})`).join(", ")],
        [
          null,
          message.text === null ? (
            <State key="s">{message.unreadable ? "Its text could not be read." : "It has no text."}</State>
          ) : (
            <MessageText key="s" text={message.text.untrusted} />
          ),
        ],
        [null, message.more ? <State key="s">The text goes on; this is its first part.</State> : null],
        [
          null,
          masked === undefined ? null : (
            <State key="s">{`${masked === 1 ? "One value that looked like a password or code is" : `${masked} values that looked like passwords or codes are`} hidden.`}</State>
          ),
        ],
      ]}
      actions={[close]}
    />
  );
}

// One fact: its sentence, where it came from, and the message it came from, which opens in its place.
export function FactSheet({ fact, onClose }: { fact: string; onClose: () => void }) {
  const loaded = useFresh("factShow", { fact });
  const [message, setMessage] = useState<string | null>(null);
  if (message !== null) return <MessageSheet message={message} onClose={onClose} />;
  return (
    <Reader
      label="A fact"
      what="fact"
      loaded={loaded}
      onClose={onClose}
      body={(detail, close) => <FactBody detail={detail} close={close} onMessage={setMessage} />}
    />
  );
}

// What a belief resting on it stands at, in words: each audience's status once.
const factStatusWords = (detail: FactDetail): string =>
  [...new Set(detail.beliefs.status)].map((status) => BELIEF_STATUS_WORDS[status]).join(" · ") || "Kept as said";

// A fact the store may rule on carries its status and the rulings the Self and People rooms give a
// fact: Edit (its words or its type), No longer true, Not true, Never use it, each told in the toast
// with Undo; Lift for a ruling of the owner's in force; and "Ask an agent to check it", a read-only
// investigate task. What Lens saw the owner do is shown, never ruled on.
function FactBody({
  detail,
  close,
  onMessage,
}: {
  detail: FactDetail;
  close: Action;
  onMessage: (message: string) => void;
}) {
  const { fact } = detail;
  const rules = rulable(fact.type);
  const { busy, note, run } = useWrite();
  const [ruled, setRuled] = useState<{ words: string; ruling: string | null } | null>(null);
  const [lifted, setLifted] = useState<ReadonlySet<string>>(new Set());
  const [mode, setMode] = useState<"edit" | "ask" | null>(null);
  const title = factSentence(fact);
  const decide = async (name: WebWriteName, body: Record<string, unknown>, words: string, done: string) => {
    let ruling: string | null = null;
    const ok = await run(name, body, done, (result) => {
      ruling = rulingOf(result);
      return ruling === null
        ? null
        : {
            name: "liftRuling",
            body: { ruling },
            done: `${title}: your ruling is lifted.`,
            after: () => setRuled(null),
          };
    });
    if (ok) setRuled({ words, ruling });
    return ok;
  };
  const rule = (name: WebWriteName, words: RulingWords) => () =>
    void decide(name, { fact: fact.id }, words, `${title}: ${words.toLowerCase()}. It ${NEXT_RUN}.`);
  const save = async (change: FactChange): Promise<boolean> => {
    const corrected =
      change.corrected === null ? `Changed to ${change.changedTo}` : `Corrected to "${change.corrected}"`;
    const ok = await decide(change.name, change.body, corrected, changeWords(change, title, NEXT_RUN));
    if (ok) setMode(null);
    return ok;
  };
  const lift = async (ruling: string): Promise<void> => {
    if (!(await run("liftRuling", { ruling }, `${title}: your ruling is lifted. It ${NEXT_RUN}.`))) return;
    if (ruling === ruled?.ruling) setRuled(null);
    else setLifted((was) => new Set([...was, ruling]));
  };
  const held = rules ? detail.rulings.filter((one) => !lifted.has(one)) : [];
  const lifts: Action[] = held.map((ruling, n) => ({
    label: held.length === 1 ? "Lift" : `Lift ruling ${n + 1}`,
    disabled: busy,
    onClick: () => void lift(ruling),
  }));
  const actions: Action[] =
    !rules || mode !== null
      ? rules
        ? []
        : [close]
      : ruled !== null
        ? [
            ...(ruled.ruling === null
              ? []
              : [{ label: "Lift", disabled: busy, onClick: () => void lift(ruled.ruling as string) }]),
            // The rulings already in force keep their Lift beside the new one.
            ...lifts,
            close,
          ]
        : [
            ...(editable(fact.type, fact.subject)
              ? [{ label: "Edit", kind: "go" as const, disabled: busy, onClick: () => setMode("edit") }]
              : []),
            ...(retirable(fact.type)
              ? [{ label: "No longer true", disabled: busy, onClick: rule("retireFact", "No longer true") }]
              : []),
            { label: "Not true", disabled: busy, onClick: rule("rejectClaim", "Not true") },
            { label: "Ask an agent to check it", onClick: () => setMode("ask") },
            ...lifts,
            { label: NEVER_USE.words, kind: "danger", disabled: busy, onClick: rule("vetoFact", NEVER_USE.done) },
            close,
          ];
  const blocks: Block[] = [
    [rules ? "Said by" : "Seen", factSaidBy(fact)],
    [
      "From",
      fact.message === null ? null : (
        <button key="s" type="button" className="linkish" onClick={() => onMessage(fact.message as string)}>
          Read the message it came from
        </button>
      ),
    ],
    ["Status", rules ? (ruled === null ? factStatusWords(detail) : `${ruled.words}. It ${NEXT_RUN}.`) : null],
    ...held.map((): Block => ["Your ruling", "A ruling of yours is in force on it."]),
    [
      null,
      note === null ? null : (
        <p key="s" className="refused" role="alert">
          {note}
        </p>
      ),
    ],
  ];
  return (
    <OpenBody lead={[<Title key="t">{title}</Title>]} blocks={blocks} actions={actions}>
      {mode === "edit" ? (
        <FactEdit
          fact={fact.id}
          kind={fact.type}
          fields={fact.fields as Record<string, unknown>}
          words={title}
          busy={busy}
          onSave={save}
          onCancel={() => setMode(null)}
        />
      ) : mode === "ask" ? (
        <TaskBox refs={[{ kind: "fact", id: fact.id }]} kind="investigate" onDone={() => setMode(null)} />
      ) : null}
    </OpenBody>
  );
}

const timeWords = (at: string): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
// When a meeting was: its day and its hours, or its days when it took whole days.
const whenOf = (
  startsAt: string | null,
  endsAt: string | null,
  days?: { date?: string | undefined; lastDate?: string | undefined },
): string => {
  if (days?.date !== undefined) {
    const first = dateWords(new Date(`${days.date}T12:00:00`));
    return days.lastDate === undefined || days.lastDate === days.date
      ? `${first}, all day`
      : `${first} to ${dateWords(new Date(`${days.lastDate}T12:00:00`))}, all day`;
  }
  if (startsAt === null) return "No time given";
  return `${dateWords(new Date(startsAt))}, ${timeWords(startsAt)}${endsAt === null ? "" : ` to ${timeWords(endsAt)}`}`;
};

// One meeting from a timeline: a calendar event, its title, when, who and the owner's answer; or a
// meeting Lens recorded, its title, when, who and what was said in it, each fact opening in its place
// and closing back to the meeting.
export function MeetingSheet({ meeting, onClose }: { meeting: string; onClose: () => void }) {
  const loaded = useFresh("meeting", { meeting });
  const [fact, setFact] = useState<string | null>(null);
  if (fact !== null) return <FactSheet fact={fact} onClose={() => setFact(null)} />;
  const blocks = (shown: OwnerMeeting): Block[] => {
    if (shown.kind === "meeting") {
      const event = shown.meeting;
      return [
        ["When", whenOf(event.startsAt, event.endsAt, event)],
        ["With", <Names key="s" people={event.participants} />],
        ["Your answer", event.response === undefined ? null : RESPONSE_WORDS[event.response]],
        [null, event.cancelled ? <State key="s">It was cancelled.</State> : null],
      ];
    }
    return [
      ["When", whenOf(shown.startsAt, shown.endsAt)],
      ["With", <Names key="s" people={shown.participants} />],
      [
        "What was said",
        shown.facts.length === 0 ? (
          "Nothing from it has been written down yet."
        ) : (
          <ul key="s" className="said">
            {shown.facts.map((one) => (
              <li key={one.id}>
                <button type="button" className="linkish" onClick={() => setFact(one.id)}>
                  {one.words.untrusted}
                </button>
              </li>
            ))}
          </ul>
        ),
      ],
    ];
  };
  return (
    <Reader
      label="A meeting"
      what="meeting"
      loaded={loaded}
      onClose={onClose}
      body={(shown, close) => (
        <OpenBody
          lead={[
            <Title key="t">
              {shown.kind === "meeting"
                ? (shown.meeting.title?.untrusted ?? "A meeting with no title")
                : (shown.title?.untrusted ?? "A meeting you recorded")}
            </Title>,
          ]}
          blocks={blocks(shown)}
          actions={[close]}
        />
      )}
    />
  );
}

// The reader for an item, by its kind.
export type { OpenItem };
export function ItemSheet({ item, onClose }: { item: OpenItem; onClose: () => void }) {
  return item.kind === "message" ? (
    <MessageSheet message={item.id} onClose={onClose} />
  ) : item.kind === "meeting" ? (
    <MeetingSheet meeting={item.id} onClose={onClose} />
  ) : (
    <FactSheet fact={item.id} onClose={onClose} />
  );
}

// The commands that send a draft, at a box shell: `show` prints it with its code, and `draft` sends
// it with that code and the flags `show` names: `--first-contact` when it goes to someone its
// account never wrote to, `--new-thread` when it starts a conversation.
const sendCommands = (draft: string, flags: { firstContact: boolean; newThread: boolean } | null): string[] => [
  `pi-send send show ${draft}`,
  `pi-send send draft ${draft} --code CODE${flags?.firstContact === true ? " --first-contact" : ""}${flags?.newThread === true ? " --new-thread" : ""}`,
];
const SEND_STEPS = [
  "1. Show it. This prints a code.",
  "2. Send it, with that code in place of CODE. If step 1 also printed a reveal code, add --reveal and that code.",
];
// A recipient by name with the address, where the owner knows them: "Dana Example <dana@example.com>".
const recipients = (draft: OwnerDraft, addresses: readonly { untrusted: string }[]): string =>
  addresses
    .map(({ untrusted: address }) => {
      const name = draft.names.find((one) => one.address.untrusted === address)?.name.untrusted;
      return name === undefined ? address : `${name} <${address}>`;
    })
    .join(", ");

const DRAFT_STATUS_WORDS: Record<OwnerDraft["status"], string> = {
  made: "Waiting for you to send it or reject it",
  held: "Held: a check failed when it was made",
  sent: "Sent",
  rejected: "Rejected",
  expired: "Expired",
};

// A draft in full, in its card: to whom, its subject and its text, as the agent wrote them, and the
// commands that send it. Rejecting it is the card's own answer.
export function DraftShown({ draft }: { draft: string }) {
  const loaded = useFresh("draft", { draft });
  const shown = loaded.state === "ready" ? loaded.value : null;
  return (
    <div className="draft">
      {gone(loaded) ? (
        <State>This draft is no longer held.</State>
      ) : shown === null ? (
        <Status loaded={loaded} what="The draft" />
      ) : (
        <OpenBody
          blocks={[
            ["To", recipients(shown, shown.to) || "No one yet"],
            ["Copy to", recipients(shown, shown.cc)],
            ["Subject", shown.subject?.untrusted ?? "None"],
            [
              "From",
              shown.account === null
                ? null
                : `Your ${shown.account} account, ${shown.newThread ? "a new conversation" : "as a reply"}`,
            ],
            ["Status", DRAFT_STATUS_WORDS[shown.status]],
            [
              null,
              shown.text === null ? (
                <State key="s">Its text was cleared, so it cannot be sent.</State>
              ) : (
                <div key="s" className="text">
                  {shown.text.untrusted}
                </div>
              ),
            ],
          ]}
        />
      )}
      <State>
        {`An agent wrote this. You send it from the terminal on the box, never from this page; rejecting it is here.${shown?.firstContact === true ? " It goes to someone you have never written to from this account." : ""}`}
      </State>
      {sendCommands(draft, shown).map((line, index) => (
        <Fragment key={line}>
          <State>{SEND_STEPS[index]}</State>
          <Command lines={[line]} />
        </Fragment>
      ))}
    </div>
  );
}

// A message's own words first: up to where it quotes an earlier message, at most a few lines; the
// rest, quoted replies and signatures included, one tap away. A page for reading, not a text dump.
const QUOTED = /^(>|On .+wrote:$|-{2,} ?(Original|Forwarded) [Mm]essage)/;
const FIRST_LINES = 8;
export function MessageText({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const lines = text.split("\n");
  // Quoting starts after the message's own first line; a forwarded mail that opens with its header or
  // a quote shows its first lines instead, never an empty box.
  const quoted = lines.findIndex((line, n) => n > 0 && QUOTED.test(line.trim()));
  const own = lines.slice(0, quoted === -1 ? lines.length : quoted);
  while (own.length > 0 && (own.at(-1) ?? "").trim() === "") own.pop();
  if (own.join("").trim() === "") own.splice(0, own.length, ...lines.slice(0, FIRST_LINES));
  const head = own.slice(0, FIRST_LINES).join("\n");
  const cut = head.length < text.trim().length;
  return (
    <>
      <div className="text">{all || !cut ? text : head}</div>
      {cut ? (
        <button type="button" className="more" onClick={() => setAll(!all)}>
          {all ? "Show less" : "Show the whole message"}
        </button>
      ) : null}
    </>
  );
}
