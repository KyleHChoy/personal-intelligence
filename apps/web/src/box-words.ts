// A box health card in words: its title, note and command.

// What a health card is about, as the store writes it: `kind/id` for what went quiet.
const healthAbout = (about: string): { kind: string; id: string } => {
  const [kind = "", id = ""] = about.split("/");
  return { kind, id };
};
// A coverage row's id: what it covers, and after a colon the part of it (a device's kind of capture).
export const coverageId = (id: string): { own: string; part?: string } => {
  const [own = id, part] = id.split(":");
  return part === undefined ? { own } : { own, part };
};

// Each job of the box, as the owner would name it.
const JOB_WORDS: Readonly<Record<string, string>> = {
  sync: "Syncing your accounts",
  erase_settle: "Applying what you forgot on your Mac",
  work_tick: "Checking for work",
  extract: "Reading new items",
  dream: "The nightly pass over what is known",
  reasoner: "The planner",
  canary: "The daily end-to-end check",
  executor: "Running your agents' steps",
  outcome_test: "Testing whether agents have what they need",
  improvement_filing: "The daily check of the system's own measures",
  backup: "Taking a backup",
  restore_drill: "Testing that a backup restores",
  time_pass: "Working out where your time went",
  sweep: "The nightly sweep",
};
// A coverage row's kind, said as what went quiet.
const QUIET_WORDS: Readonly<Record<string, string>> = {
  account: "A connected account has gone quiet",
  device: "A Mac has stopped sending",
  capture_class: "One kind of capture from a Mac has stopped arriving",
  lane: "Reading one kind of item for facts has stopped",
  client: "An agent let work lapse without reporting",
  job: "A job of the box has stopped running",
};
// Each kind of item read for facts, as what stopped being read.
const LANE_WORDS: Readonly<Record<string, string>> = {
  correspondence: "your mail",
  transaction: "receipts and notices",
  agent: "your agents' records",
  document: "your documents",
  page: "saved pages",
  meeting: "your meetings",
  moment: "what was on your screen",
  email: "your mail",
  mail: "your mail",
};
// A lane or job of the box by what it does, the same words coverage and its health cards use.
export const coverageWords = (code: string): string | undefined =>
  JOB_WORDS[code] ??
  (LANE_WORDS[code] === undefined ? undefined : `Reading ${LANE_WORDS[code]} for facts`) ??
  (code === "extraction" ? "Reading for facts" : undefined);
// Each long-running service of the box, as the owner would name it.
const PROCESS_WORDS: Readonly<Record<string, string>> = {
  http: "The service your agents and your Mac connect to",
  wake: "Waking on agents' proposals",
  notify: "Telling your agents about new work",
  web: "This page",
  tailscaled: "The private network link for this page",
};
const HOLD_WORDS: Readonly<Record<string, string>> = {
  sync_hold: "The sync hold has been on for over an hour",
  read_hold: "The read hold has been on for over an hour",
  wake_off: "Waking on agents' proposals has been off for over an hour",
};
// A kind of capture from a Mac (coverage.ts CLASSES), as what stopped arriving, with its verb.
const CAPTURE_CLASS_WORDS: Readonly<Record<string, [string, string]>> = {
  meeting: ["Meetings", "have"],
  moment: ["Screen reading", "has"],
  block: ["Time spent in apps", "has"],
  task: ["Tasks", "have"],
};
// What a box health card names by id, by the names the page knows: an account by the owner's label, a Mac
// by its capture client's name.
export type BoxNames = {
  account?: ((id: string) => string | undefined) | undefined;
  device?: ((id: string) => string | undefined) | undefined;
};
// One box health card, what it is about given as its kind and `about` (box-health.ts): its title,
// a note on what to do, and the terminal command that shows or settles it. An account and a Mac are
// named where the page knows them, the same on a card as in Settings.
export function boxHealthWords(
  kind: string,
  about: string,
  names: BoxNames = {},
): { title: string; note: string; command: string } {
  const see = "pia status";
  switch (kind) {
    case "silent": {
      const { kind: rowKind, id: rowId } = healthAbout(about);
      const { own, part: capture = "" } = coverageId(rowId);
      const account = rowKind === "account" ? names.account?.(rowId) : undefined;
      const mac = rowKind === "capture_class" || rowKind === "device" ? names.device?.(own) : undefined;
      const what = rowKind === "capture_class" ? CAPTURE_CLASS_WORDS[capture] : undefined;
      // Every kind the store raises one about has its words; one this page does not know yet is
      // still said to be part of the box, never "something".
      const title =
        rowKind === "job"
          ? `${JOB_WORDS[rowId] ?? "A job of the box"} has stopped running`
          : account !== undefined
            ? `${account} has gone quiet`
            : what !== undefined
              ? `${what[0]} from ${mac ?? "a Mac"} ${what[1]} stopped arriving`
              : rowKind === "device" && mac !== undefined
                ? `${mac} has stopped sending`
                : rowKind === "lane" && LANE_WORDS[rowId] !== undefined
                  ? `Reading ${LANE_WORDS[rowId]} for facts has stopped`
                  : (QUIET_WORDS[rowKind] ?? "Part of the box has gone quiet");
      return {
        title,
        note: "Something that should flow has not. See what coverage shows in the terminal, and mark this seen once you have looked.",
        command: "pia status --coverage",
      };
    }
    case "hold":
      // The box's own wait, raised as it starts: new code was deployed and its migration has not run.
      if (about === "migrate_wait")
        return {
          title: "The box is waiting for its database migration",
          note: "New code was deployed and the database has not been migrated to match it yet. Until the migration has run, nothing syncs and your agents get no answers. Run the command below on the box. This clears by itself when it succeeds.",
          command: "pi-migrate",
        };
      return {
        title: HOLD_WORDS[about] ?? "A hold has been on for over an hour",
        note: "Nothing it stops will run until it is lifted. Lift it when the work it was set for is done.",
        command: see,
      };
    case "timed_out":
      return {
        title: `${JOB_WORDS[about] ?? "A job of the box"} ran past its time limit`,
        note: "It was stopped so it could not hold up the rest; the next run starts as usual. If it keeps happening, look at its log on the box.",
        command: see,
      };
    case "failure_streak":
      // A failed restore drill is its card at once, not after three;
      if (about === "restore_drill" || about === "backup")
        return {
          title: "A backup did not restore",
          note: "The latest restore test failed: the dump did not come back whole and current. Its code says why. Take a new dump and test it as the runbook says.",
          command: see,
        };
      return {
        title: `${JOB_WORDS[about] ?? "A job of the box"} failed three times in a row`,
        note: "Each of its last three runs failed. See why in the terminal.",
        command: see,
      };
    case "backup_due":
      if (about === "restore")
        return {
          title: "Time to test that a backup restores",
          note: "No restore test has passed for over a month. Run one as the runbook says.",
          command: "pi restore check",
        };
      return {
        title: "Time to take a backup",
        note:
          about === "erasure"
            ? "You forgot something and no backup was taken since. Take one, then record it with the command below."
            : "No backup is recorded for over a week. Take one, then record it with the command below.",
        command: "pia backup taken",
      };
    case "restarting":
      return {
        title: `${PROCESS_WORDS[about] ?? "A service on the box"} keeps stopping right after it starts`,
        note: "It has stopped within a minute of starting three times in a row, so it is being started again less often. Look at its log on the box.",
        command: see,
      };
    case "dashboard_down":
      return {
        title: "This page has been off your private network for 15 minutes",
        note: "The box could not join your tailnet, so the page may not open from your devices. It keeps trying; if it does not come back, look at the box's deploy log for its sign-in link.",
        command: "tailscale status",
      };
    case "stores_nothing":
      return {
        title: `${names.account?.(healthAbout(about).id) ?? "A connected account"} syncs but has stored nothing for three days`,
        note: "Its syncs end well and bring nothing in, though it stored items on most days before. Check what the account still grants and what its rules leave out.",
        command: "pia status --coverage",
      };
    case "budget_stops":
      return about === "dream"
        ? {
            title: `${JOB_WORDS[about] ?? "A job of the box"} has stopped on its budget three times in a row`,
            note: "It keeps running out of budget before it finishes, so some of its work is never reached.",
            command: see,
          }
        : {
            title: `${JOB_WORDS[about] ?? "A job of the box"} stopped on its budget with work left`,
            note: "Its last run reached its spending line before it finished. The command below shows how much is still waiting.",
            command: about === "extract" ? "pia extract status" : see,
          };
    case "extract_backlog":
      return {
        title: "Reading new items has failed on fifty or more in two days",
        note: "Those items gave no facts. See which and why in the terminal.",
        command: "pia extract status",
      };
    case "detector_stopped":
      return {
        title: `${JOB_WORDS[about] ?? "A job of the box"} has not run for three days`,
        note: "It ran daily before and has not started since. A hold or a switch may be keeping it off.",
        command: see,
      };
    case "key_changed":
      return {
        title: "The key file is not the one the box recorded",
        note: "A key differs or is gone. If you changed the file on purpose, accept it; if not, put back your copy.",
        command: "pia keys accept-fingerprint",
      };
    case "token_expiring":
      return {
        title: "A client's token expires within a week",
        note: "Once it expires, that client gets no answers. Find the client by this card's id in the list the command below prints, then run pia clients rotate with its name and put the new token where the client reads it; the old one stops working at once. For a Lens device, run pi lens rotate in a terminal instead.",
        command: "pia clients list",
      };
    case "tls_unverified":
      return {
        title: "The box's connection to the database checks no certificate",
        note: "It is encrypted, but nothing proves the server is yours. Fetch the database's CA and set it as the runbook's Database TLS step says; the card closes at the next record after the box restarts with it.",
        command: see,
      };
    default:
      return { title: "Something on the box needs a look", note: "See it in the terminal.", command: see };
  }
}
