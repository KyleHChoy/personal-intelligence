import { ownWords } from "./first-read.ts";
import { saysNoticeDue } from "./open-items.ts";

// Which of a lane's messages the owner's retry that keeps its answers asks the lane's new version: mail
// whose own words an earlier version may have read as nothing. Words decide only which version is asked, at
// a call's cost: the model still proposes and the check still grounds. Pinned English.
const INTRO_WORDS =
  /\b(?:[Ii]ntroduc(?:e|ing) (?:you|the two|them|him|her)\b|[Aa]n? intro(?:duction)?\b|[Yy]ou should (?:meet|talk to)\b|connect you\b|put you in touch\b|[Ww]e['’]ve met\b|I know [A-Z])/;

export function asksNewVersion(lane: string, subject: string | null, body: string | null): boolean {
  const said = [subject ?? "", ownWords(body ?? "")].join("\n");
  if (lane === "transaction") return saysNoticeDue(said);
  return lane === "correspondence" && INTRO_WORDS.test(said);
}
