import type { CoverageRow, CoverageState, SourceAccountView } from "@intelligence/contracts/personal";
import { agentName, compartmentWords } from "../agent-words.ts";
import { coverageId, coverageWords } from "../box-words.ts";
import { useKept } from "../kept.ts";
import { OpenBody, OpenRow } from "../parts.tsx";
import { whenWords } from "../time-words.ts";
import { wordsOf } from "../words.ts";
import { blk, Pairs, plural, ReadState, SubList, TermFold, when } from "./system-parts.tsx";

// Settings' Sources: each account opening to its address, whose it is, what it skipped and its
// commands, then the coverage list. Connecting and disconnecting stay in the terminal.

const COVERAGE_KIND: Record<CoverageRow["kind"], string> = {
  account: "An account",
  device: "A device",
  capture_class: "A kind of capture",
  lane: "A lane",
  job: "A job",
  client: "An agent",
};
const COVERAGE_STATE: Record<CoverageState, string> = {
  covered: "Covered",
  silent: "Silent",
  inactive: "Not active",
  not_read: "Not read",
};
const CONNECTOR: Record<string, string> = {
  gmail: "Gmail",
  google_mail: "Gmail",
  google_calendar: "Calendar",
  imessage: "Messages",
  lens: "Lens",
  drive: "Drive",
  google_drive: "Drive",
};
const connectorWords = (code: string): string => CONNECTOR[code] ?? wordsOf(code);
export const isFailing = (outcome: string | null): boolean => outcome !== null && outcome !== "ok";
const GOOGLE = new Set(["gmail", "google_mail", "google_calendar", "google_drive", "drive"]);
// The outcomes a new Google grant fixes; any other failure has no reconnect to offer, so none is shown.
const NEEDS_GRANT = new Set([
  "token_expired",
  "token_failed",
  "token_refresh",
  "invalid_grant",
  "revoked",
  "unauthorized",
  "reconnect_google",
  "reconnect_drive",
]);
const shellQuoted = (label: string): string => `'${label.replaceAll("'", "'\\''")}'`;
type Account = Pick<SourceAccountView, "connector" | "label" | "lastOutcome">;
// The reconnect keeps Drive's own flag, so reconnecting a Drive account never drops its Drive grant.
export const reconnect = (account: Account): string | null =>
  GOOGLE.has(account.connector) && account.lastOutcome !== null && NEEDS_GRANT.has(account.lastOutcome)
    ? `pia google connect --account ${shellQuoted(account.label)}${account.connector.includes("drive") || account.lastOutcome === "reconnect_drive" ? " --drive" : ""}`
    : null;
// The terminal refuses to disconnect a mail account while its contacts are connected, so that step
// comes first.
export const disconnect = (account: Account): string[] =>
  !GOOGLE.has(account.connector)
    ? []
    : account.connector.includes("drive")
      ? [`pia google disconnect ${shellQuoted(account.label)} --drive`]
      : [
          `pia google disconnect ${shellQuoted(account.label)} --contacts`,
          `pia google disconnect ${shellQuoted(account.label)}`,
        ];
const outcomeWords = (outcome: string | null): string =>
  outcome === null ? "Not yet" : outcome === "ok" ? "Last sync went through" : wordsOf(outcome);

function AccountRow({ account, skipped }: { account: SourceAccountView; skipped: number }) {
  const failing = isFailing(account.lastOutcome);
  const again = reconnect(account);
  const off = disconnect(account);
  return (
    <OpenRow
      id={`source-${account.id}`}
      row={{
        what: account.label,
        sub: [account.address, connectorWords(account.connector)].filter((part) => part !== null).join(" · "),
        meta: failing
          ? `Stopped: ${outcomeWords(account.lastOutcome).toLowerCase()}`
          : account.lastSyncAt === null
            ? "Never synced"
            : `Synced ${whenWords(account.lastSyncAt)}`,
        metaWarn: failing,
      }}
    >
      <OpenBody
        blocks={[
          blk(
            null,
            <Pairs
              rows={[
                ["Service", connectorWords(account.connector)],
                ["Address", account.address ?? "None"],
                ["Whose it is", compartmentWords(account.compartment)],
                ["Last sync", account.lastSyncAt === null ? "Never" : when(account.lastSyncAt)],
                ["How it went", outcomeWords(account.lastOutcome), failing],
                ["Skipped", skipped === 0 ? "Nothing" : plural(skipped, "item"), skipped > 0],
              ]}
            />,
          ),
          blk(
            null,
            again === null && off.length === 0 ? null : (
              <TermFold
                note={off.length > 1 ? "To disconnect it, its contacts first, then the account." : undefined}
                lines={[...(again === null ? [] : [again]), ...off]}
              />
            ),
          ),
        ]}
      />
    </OpenRow>
  );
}

export function Sources() {
  const [accounts] = useKept("listSourceAccounts");
  const [coverage] = useKept("coverage");
  const [status] = useKept("status");
  const [clients] = useKept("listClients");
  const list = accounts.state === "ready" ? accounts.value : [];
  const skipped = new Map(
    (status.state === "ready" ? status.value.accounts : []).map((one) => [one.id as string, one.skippedItems]),
  );
  const labels = new Map(list.map((one) => [one.id as string, one.label]));
  const agents = new Map((clients.state === "ready" ? clients.value : []).map((one) => [one.id as string, one.name]));
  // A coverage row by what it covers: an account by its label, an agent or device by its name, a
  // lane, a job or a kind of capture by its words, never by an id.
  const coverageTitle = (row: CoverageRow): string => {
    const { own, part } = coverageId(row.id);
    if (row.kind === "account") return labels.get(own) ?? "An account no longer connected";
    if (row.kind === "client" || row.kind === "device")
      return agents.has(own)
        ? agentName(agents.get(own) ?? "")
        : row.kind === "client"
          ? "An agent no longer registered"
          : "A device no longer registered";
    const code = part ?? row.id;
    return (
      coverageWords(code) ??
      (/^[a-z][a-z0-9_]*$/.test(code) && !/^[a-z]{3}_[0-9A-Z]{10,}/.test(code)
        ? wordsOf(code)
        : COVERAGE_KIND[row.kind])
    );
  };
  const rows = coverage.state === "ready" ? coverage.value : [];
  return (
    <OpenBody
      blocks={[
        blk(null, <ReadState loaded={accounts} what="Sources" />),
        blk(
          null,
          list.length === 0 ? null : (
            <SubList items={list}>
              {(one) => <AccountRow key={one.id} account={one} skipped={skipped.get(one.id) ?? 0} />}
            </SubList>
          ),
        ),
        blk(
          "Coverage",
          coverage.state !== "ready" ? (
            <ReadState loaded={coverage} what="Coverage" />
          ) : rows.length === 0 ? (
            "Nothing connected to cover."
          ) : (
            <Pairs
              rows={rows.map((row) => [
                coverageTitle(row),
                [
                  COVERAGE_STATE[row.state],
                  row.code === undefined ? null : wordsOf(row.code),
                  ...Object.entries(row.counts).map(([what, n]) => `${n} ${what.replaceAll("_", " ")}`),
                ]
                  .filter((part) => part !== null)
                  .join(" · "),
                row.state === "silent",
              ])}
              limit={6}
            />
          ),
        ),
        blk(
          null,
          <TermFold
            lines={[
              "pia google connect --account LABEL",
              "pia status --coverage --days 30",
              "pia extract status",
              "pia lens list",
            ]}
          />,
        ),
      ]}
    />
  );
}
