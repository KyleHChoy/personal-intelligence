import type {
  FactRulingNamedView,
  FactView,
  IgnoredView,
  OwnerSearchResult,
  VetoNamedView,
  Who,
} from "@intelligence/contracts/personal";
import { useState } from "react";
import { type Loaded, post, said, search, write } from "../api.ts";
import { factTypeWords } from "../enum-words.ts";
import { factSentence } from "../facts.ts";
import { useKept } from "../kept.ts";
import { moved } from "../kept-store.ts";
import { ActionBar, Empty, OpenBody, OpenRow, TextField } from "../parts.tsx";
import { useToast } from "../toast.tsx";
import { useAfterTyping } from "../typing.ts";
import { capital, UNNAMED, UNNAMED_ORGANIZATION } from "../words.ts";
import { blk, CtlRow, Pairs, plural, ReadState, SubList, TermFold, useWrite, when } from "./system-parts.tsx";

// Settings' Identity: naming an organization, and the ignore, veto and join or split rulings, each
// opening to what it covers, lifted here where the page may, else by its command with its own id.

export const nameOf = (who: Who): string =>
  who.name?.untrusted ??
  who.address?.untrusted ??
  (who.kind === "organization" ? UNNAMED_ORGANIZATION : capital(UNNAMED));

export function Identity() {
  const [ignored] = useKept("listIgnore");
  const [vetoes] = useKept("listVetoes");
  const [joins] = useKept("listFactRulings");
  const ignores = ignored.state === "ready" ? ignored.value : [];
  // In force first; the lifted after, so a lift made elsewhere still shows.
  const sorted = [...ignores.filter((one) => one.liftedAt === null), ...ignores.filter((one) => one.liftedAt !== null)];
  const shownVetoes = vetoes.state === "ready" ? vetoes.value : [];
  const shownJoins = joins.state === "ready" ? joins.value : [];
  return (
    <OpenBody
      blocks={[
        blk("Name an organization", <RenameOrganization />),
        blk(
          "Ignored",
          ignored.state !== "ready" ? (
            <ReadState loaded={ignored} what="Ignore rulings" />
          ) : sorted.length === 0 ? (
            "Nothing is ignored."
          ) : (
            <SubList items={sorted}>{(one) => <Ignored key={one.id} ruling={one} />}</SubList>
          ),
        ),
        blk(
          "Never to be used",
          shownVetoes.length === 0 ? null : (
            <SubList items={shownVetoes}>{(one) => <Vetoed key={one.id} veto={one} />}</SubList>
          ),
        ),
        blk(
          "Facts joined or split",
          shownJoins.length === 0 ? null : (
            <SubList items={shownJoins}>{(one) => <Joined key={one.id} ruling={one} />}</SubList>
          ),
        ),
        blk(
          null,
          <TermFold
            lines={["pia facts rulings", "pia identity reclassify --dry-run", "pi-sync org refold --dry-run"]}
          />,
        ),
      ]}
    />
  );
}

// Whom a ruling covers, in words: the people by name, a domain by itself, at most three, then how
// many more.
const coveredWords = (ruling: IgnoredView): string => {
  const names = ruling.who.map((who) =>
    ruling.subject === "domain" ? (who.address?.untrusted ?? nameOf(who)) : nameOf(who),
  );
  if (names.length === 0)
    return ruling.target === "domain"
      ? "A domain no one known is at"
      : ruling.target === "entity"
        ? ruling.subject === "domain"
          ? `An organization no longer known, by ${plural(ruling.values, "domain")}`
          : `Someone no longer known, by ${plural(ruling.values, "address", "addresses")}`
        : `${plural(ruling.values, "address", "addresses")} no one known holds`;
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
};

// One ignore ruling. In force, a person's or organization's is lifted here (`liftIgnore`) with Undo,
// which ignores them again and makes a new ruling the next Lift lifts; a domain's stays in the terminal.
function Ignored({ ruling }: { ruling: IgnoredView }) {
  const [liftedAt, setLiftedAt] = useState(ruling.liftedAt);
  const [current, setCurrent] = useState<string>(ruling.id);
  const { busy, refused, note, run } = useWrite();
  const toast = useToast();
  const words = coveredWords(ruling);
  const only = ruling.who.length === 1 ? ruling.who[0] : undefined;
  const lift = async (): Promise<void> => {
    if (!(await run("liftIgnore", { ruling: current }))) return;
    setLiftedAt(new Date().toISOString());
    moved(["listIgnore"]);
    toast(
      `Back in every read: ${words}.`,
      ruling.target === "entity" && only !== undefined
        ? () =>
            void post<{ result?: unknown }>("ignorePerson", { person: only.id }).then((again) => {
              toast(again.ok ? `Ignored again: ${words}.` : `Not undone: ${said(again.code)}`);
              if (!again.ok || typeof again.value.result !== "string") return;
              setCurrent(again.value.result);
              setLiftedAt(null);
              moved(["listIgnore"]);
            })
        : undefined,
    );
  };
  const covers =
    ruling.who.length === 0
      ? `${plural(ruling.values, ruling.subject, ruling.subject === "address" ? "addresses" : "domains")} no one known holds now`
      : ruling.who
          .map((who) => [nameOf(who), who.address?.untrusted ?? null].filter((part) => part !== null).join(", "))
          .join("; ");
  const inForce = liftedAt === null;
  return (
    <OpenRow
      id={`ignore-${ruling.id}`}
      row={{
        what: words,
        sub: refused ?? undefined,
        meta: inForce ? `Since ${when(ruling.at)}` : `Lifted ${when(liftedAt ?? ruling.at)}`,
      }}
    >
      <OpenBody
        blocks={[
          blk(
            null,
            <Pairs
              rows={[
                ["Covers", covers],
                [
                  "What it does",
                  inForce ? "They leave every read; their mail stays." : "Lifted: they are back in every read.",
                ],
                ["Ignored", when(ruling.at)],
                ...(inForce ? [] : [["Lifted", when(liftedAt ?? ruling.at)] as const]),
              ]}
            />,
          ),
          blk(null, note),
          blk(null, inForce ? <TermFold lines={[`pia ignore lift ${current}`]} /> : null),
        ]}
        actions={
          inForce && ruling.target !== "domain"
            ? [{ label: "Lift", kind: "go", disabled: busy, onClick: () => void lift() }]
            : []
        }
      />
    </OpenRow>
  );
}

// One join or split of two facts, named by the latest claim of each side, with its status.
function Joined({ ruling }: { ruling: FactRulingNamedView }) {
  const sideOf = (claim: string | null, fact: FactView | null): string =>
    fact !== null ? factSentence(fact) : claim === null ? "a fact no longer held" : "a fact this page could not read";
  const [a, b] = [capital(sideOf(ruling.aClaim, ruling.aFact)), sideOf(ruling.bClaim, ruling.bFact)];
  const status = ruling.liftedAt !== null ? "Lifted" : ruling.gone ? "One side's claims are gone" : "In force";
  return (
    <OpenRow
      id={`join-${ruling.id}`}
      row={{
        what: `${a}, and ${b}`,
        sub: ruling.verdict === "join" ? "You said they are one" : "You said they are two",
        meta: status,
        metaWarn: ruling.liftedAt === null && ruling.gone,
      }}
    >
      <OpenBody
        blocks={[
          blk(
            null,
            <Pairs
              rows={[
                ["One", a],
                ["The other", capital(b)],
                ["Status", status],
                ["Since", when(ruling.at)],
                ...(ruling.liftedAt === null ? [] : [["Lifted", when(ruling.liftedAt)] as const]),
              ]}
            />,
          ),
          blk(null, ruling.liftedAt !== null ? null : <TermFold lines={[`pia facts lift ${ruling.id}`]} />),
        ]}
      />
    </OpenRow>
  );
}

// Whom a veto is on: a name, or, when the person or organization it named is gone, that, never
// "Every person", which would claim it covers everyone.
const vetoOn = (veto: VetoNamedView): string =>
  veto.who !== null
    ? nameOf(veto.who)
    : veto.entity !== null
      ? "Someone no longer known"
      : veto.subject === "any"
        ? "Anyone"
        : veto.subject === "person"
          ? "Every person"
          : "Every organization";

function Vetoed({ veto }: { veto: VetoNamedView }) {
  const [lifted, setLifted] = useState(false);
  const { busy, refused, run } = useWrite();
  const toast = useToast();
  const title = `${vetoOn(veto)}: ${veto.kind === null ? "every fact" : `${factTypeWords(veto.kind).toLowerCase()} facts`}`;
  const lift = async (): Promise<void> => {
    if (!(await run("liftVeto", { ruling: veto.id }))) return;
    setLifted(true);
    toast(`Lifted your veto: ${title}.`);
  };
  return (
    <CtlRow title={title} sub={refused ?? (lifted ? "Lifted" : `Since ${when(veto.at)}`)}>
      {lifted ? null : (
        <button type="button" className="btn sm" disabled={busy} onClick={() => void lift()}>
          Lift
        </button>
      )}
    </CtlRow>
  );
}

// Find the organization by name (POST /api/search), then name it: one `nameOrganization` decision,
// with Undo where it had a name; the Undo says when it fails, so a failed undo is never silent.
function RenameOrganization() {
  const toast = useToast();
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<Loaded<OwnerSearchResult> | null>(null);
  const [chosen, setChosen] = useState<Who | null>(null);
  const [name, setName] = useState("");
  const { busy, note, run } = useWrite();
  useAfterTyping(
    term,
    250,
    (trimmed, latest) =>
      void search("search", trimmed.slice(0, 100), false).then((answer) => latest() && setHits(answer)),
    () => setHits(null),
  );
  const newName = name.trim();
  const valid = newName !== "" && !/\p{Cc}/u.test(newName);
  const rename = async (): Promise<void> => {
    if (chosen === null || !valid || !(await run("nameOrganization", { organization: chosen.id, name: newName })))
      return;
    const was = chosen.name?.untrusted ?? null;
    const organization = chosen.id;
    toast(
      `${was ?? "The organization"} is now ${newName}.`,
      was === null
        ? undefined
        : () =>
            void write("nameOrganization", { organization, name: was }).then((back) =>
              toast(back.ok ? `Its name is ${was} again.` : `Not undone: ${said(back.code)}`),
            ),
    );
    setChosen(null);
    setName("");
    setTerm("");
  };
  const found = hits?.state === "ready" ? hits.value.hits.filter((hit) => hit.who.kind === "organization") : [];
  if (chosen !== null)
    return (
      <>
        <TextField
          label={`New name for ${nameOf(chosen)}`}
          value={name}
          onChange={setName}
          maxLength={200}
          onEnter={() => void rename()}
        />
        {note}
        <ActionBar
          actions={[
            { label: "Rename", kind: "go", disabled: busy || !valid, onClick: () => void rename() },
            { label: "Cancel", kind: "quiet", onClick: () => setChosen(null) },
          ]}
        />
      </>
    );
  return (
    <>
      <TextField
        label="Organization"
        hideLabel
        placeholder="Find an organization"
        value={term}
        onChange={setTerm}
        maxLength={100}
      />
      {hits?.state === "ready" && found.length === 0 ? <Empty>No organization among the best matches.</Empty> : null}
      {found.length === 0 ? null : (
        <div className="sub-list">
          {found.map((hit) => (
            <button key={hit.who.id} type="button" className="row" onClick={() => setChosen(hit.who)}>
              <span className="what">
                <span className="t">{nameOf(hit.who)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
