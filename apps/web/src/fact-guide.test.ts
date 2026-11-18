import { KIND_REGISTRY } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { factTypeWords } from "./enum-words.ts";

// The dashboard's word for each kind is the kind registry's, so the two cannot
// drift. A client preference is no fact type: the dashboard names it in its own place.
const guide = KIND_REGISTRY;

describe("the kind registry and the dashboard's words", () => {
  it("each kind's dashboard word is the registry's", () => {
    for (const [kind, entry] of Object.entries(guide.kinds)) {
      if (kind === "client_preference") continue;
      // A project's kinds are stored under the dotted type the page's words go by.
      expect(factTypeWords(kind.replace(/^project_/, "project.")), kind).toBe(entry.words);
    }
  });
});
