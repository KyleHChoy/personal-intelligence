import type { LedgerDay } from "@intelligence/contracts/personal";
import { useState } from "react";
import type { Loaded } from "../api.ts";
import { useFresh } from "../kept.ts";
import { Panel, Seg } from "../parts.tsx";
import { spentWords } from "../spend-words.ts";
import { isoDay } from "../time-words.ts";
import { Happened } from "./ledger-happened.tsx";
import { plural, ReadState } from "./system-parts.tsx";

export { stepOf, whoOf } from "./ledger-threads.ts";

// The Ledger, System's view: the day's figures, then what happened, each piece of work once, newest
// first (ledger-happened.tsx). The room writes nothing.

export function Ledger() {
  const [which, setWhich] = useState<"today" | "yesterday">("today");
  const now = new Date();
  const day = isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (which === "today" ? 0 : 1)));
  const tally = useFresh("ledgerDay", { day }, true);
  return (
    <>
      <Panel
        title={which === "today" ? "Today so far" : "Yesterday"}
        className="sys"
        end={
          <Seg
            className="toggle"
            label="Day"
            value={which}
            options={[
              ["today", "Today"],
              ["yesterday", "Yesterday"],
            ]}
            onChange={setWhich}
          />
        }
      >
        <Figures loaded={tally} />
      </Panel>
      <Happened day={day} />
    </>
  );
}

// Spend is every lane's, by spend-words.ts's one definition, as Today and Health show it.
function Figures({ loaded }: { loaded: Loaded<LedgerDay> }) {
  if (loaded.state !== "ready") return <ReadState loaded={loaded} what="The day's counts" />;
  const t = loaded.value;
  const figures: [string, string][] = [
    ["Messages read", plural(t.itemsRead, "item")],
    ["Learned", plural(t.claimsMade, "fact")],
    ["Agent work", plural(t.runs + t.moves, "piece")],
    ["Spent", spentWords({ lanes: t.spend.map((one) => ({ spentUsd: one.usd })) })],
    ["Your decisions", String(t.decisions)],
    ["Sent", t.sends === 0 ? "Nothing" : String(t.sends)],
  ];
  return (
    <div className="figs">
      {figures.map(([k, v]) => (
        <div key={k} className="fig">
          <div className="k">{k}</div>
          <div className="v">
            {/* A count's unit in the small muted size, as the mockup's figures say it. */}
            {/^\d[\d,]* \D/.test(v) ? (
              <>
                {v.slice(0, v.indexOf(" "))} <small>{v.slice(v.indexOf(" ") + 1)}</small>
              </>
            ) : (
              v
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
