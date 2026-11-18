import type { AskedLane } from "@intelligence/contracts/personal";
import { asksNewVersion } from "@intelligence/personal-core/views";
import { replayedVersions } from "./asked-version.ts";
import { FACT_KIND_VERSIONS } from "./lane-versions.ts";
import { PROMPT_IDS } from "./message-prompts.ts";
import { projectOfWords } from "./project-named.ts";

type Lane = AskedLane;
type RetryMessage = {
  subject: string | null;
  body: string | null;
  outbound: boolean;
  projects: Parameters<typeof projectOfWords>[0];
};

// What a retry that keeps its answers chooses to buy. Correspondence: a message in a project, which is how a project's old
// mail gets its facts, since an anchor only replays, and mail that offers a person. Transaction: a notice that says
// something is due or was done. The agent lane chooses nothing.
const choose =
  (lane: Lane) =>
  ({ subject, body, outbound, projects }: RetryMessage): "words" | "project" | null => {
    if (lane === "correspondence" && projectOfWords(projects, outbound, subject, body) !== null) return "project";
    return lane !== "agent" && asksNewVersion(lane, subject, body) ? "words" : null;
  };

// A lane's versions for that retry, as `<prompt id>@<version>`, whether or not the lane is switched on: off, it buys
// nothing new, and only an item with no call the run would replay pays.
export function keptVersions(lane: Lane, on: boolean) {
  const name = (version: string): string => `${PROMPT_IDS[lane]}@${version}`;
  return {
    replays: replayedVersions(lane, on).map(name),
    ask:
      on && lane !== "agent"
        ? { version: FACT_KIND_VERSIONS[lane], name: name(FACT_KIND_VERSIONS[lane]), choose: choose(lane) }
        : null,
  };
}
