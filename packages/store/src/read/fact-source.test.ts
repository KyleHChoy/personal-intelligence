import { describe, expect, it } from "vitest";
import { factSourceOf, type SourceRow } from "./fact-source.ts";

const none: SourceRow = { message_id: null, document_id: null };

describe("factSourceOf", () => {
  it("names each kind of source by the ids and capture columns its row carries", () => {
    expect(factSourceOf({ ...none, message_id: "msg_1" }, "source")).toBe("mail");
    expect(factSourceOf({ ...none, document_id: "doc_1" }, "source")).toBe("document");
    expect(factSourceOf({ ...none, page_id: "pg_1" }, "agent_research")).toBe("web");
    expect(factSourceOf({ ...none, capture_id: "cap_1", capture_kind: "meeting" }, "source")).toBe("meeting");
    expect(
      factSourceOf({ ...none, capture_id: "cap_1", capture_kind: "moment", capture_source: "imessage" }, "source"),
    ).toBe("messages");
    expect(factSourceOf({ ...none, capture_id: "cap_1", capture_kind: "moment", capture_source: null }, "source")).toBe(
      "screen",
    );
    expect(factSourceOf({ ...none, capture_id: "cap_1", capture_kind: "block" }, "source")).toBe("screen");
    expect(factSourceOf({ ...none, record_id: "rec_1" }, "agent_record")).toBe("agent");
    expect(factSourceOf(none, "agent_close")).toBe("agent");
    expect(factSourceOf({ ...none, contact: true }, "source")).toBe("contacts");
    expect(factSourceOf(none, "owner_command")).toBe("owner");
    // A compiled read's row: its flags, where it serves no document or page id.
    expect(factSourceOf({ ...none, document: true }, "agent_record")).toBe("document");
    expect(factSourceOf({ ...none, from_page: true }, "agent_research")).toBe("web");
  });

  it("never says mail for a row that names no message", () => {
    expect(factSourceOf(none, "source")).toBe("other");
    expect(factSourceOf({ ...none, capture_id: "cap_1" }, "source")).toBe("other");
  });
});
