import type { HttpPort, HttpResponse, SourceAccountId } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import { createTiesReader } from "./gmail-ties.ts";
import { GoogleError } from "./http.ts";

const ACCOUNT = "sa-test" as SourceAccountId;
const answer = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body }) as unknown as HttpResponse;
const DEPS = { sleep: async () => {}, now: () => Date.UTC(2026, 10, 4), random: () => 0.5 };

function port(respond: (url: URL) => unknown): { http: HttpPort; urls: URL[] } {
  const urls: URL[] = [];
  const http = {
    send: async ({ url: at }: { url: string }) => {
      const url = new URL(at);
      urls.push(url);
      const body = respond(url);
      if (body instanceof Error) throw body;
      return answer(body);
    },
  } as unknown as HttpPort;
  return { http, urls };
}

const metadata = (id: string) => ({
  id,
  threadId: `t-${id}`,
  internalDate: String(Date.UTC(2023, 0, 1)),
  labelIds: ["INBOX"],
  snippet: "sentinel snippet",
  payload: {
    headers: [
      { name: "From", value: "Ada Example <ada@example.com>" },
      { name: "To", value: "owner@example.org" },
      { name: "Subject", value: "sentinel subject" },
    ],
  },
});

describe("the ties reader", () => {
  it("lists a pass's window with no spam, trash, promotions or updates", async () => {
    const { http, urls } = port(() => ({ messages: [{ id: "a" }, { id: "b" }], nextPageToken: "more" }));
    const reader = createTiesReader(http, ACCOUNT, DEPS);
    const page = await reader.list("rest", { after: 100, before: 200 }, "from");
    expect(page).toEqual({ ids: ["a", "b"], next: "more" });
    const params = (urls[0] as URL).searchParams;
    expect(params.get("q")).toBe("after:100 before:200 -in:sent -in:drafts -category:promotions -category:updates");
    expect(params.get("includeSpamTrash")).toBeNull();
    expect(params.get("pageToken")).toBe("from");

    await reader.list("sent", { after: 100 });
    const sent = (urls[1] as URL).searchParams;
    expect(sent.get("labelIds")).toBe("SENT");
    expect(sent.get("q")).toBe("after:100 -in:drafts");
  });

  it("asks for listed headers and fields alone, and keeps no subject or snippet in the item", async () => {
    const { http, urls } = port((url) => metadata(url.pathname.split("/").pop() as string));
    const { items, gone, skipped } = await createTiesReader(http, ACCOUNT, DEPS).fetch(["m1"]);
    expect({ gone, skipped }).toEqual({ gone: 0, skipped: [] });
    const params = (urls[0] as URL).searchParams;
    expect(params.get("format")).toBe("metadata");
    expect(params.get("fields")).toBe("id,threadId,internalDate,labelIds,payload/headers");
    expect(params.getAll("metadataHeaders")).not.toContain("Subject");
    expect(urls[0]?.pathname).not.toContain("attachments");

    const [item] = items;
    expect(item).toMatchObject({
      depth: "headers",
      sourceItemId: "gmail-id:m1",
      threadId: "t-m1",
      revisionTag: "h:m1:",
    });
    const block = Buffer.from(item?.payload ?? "", "base64").toString("utf8");
    expect(block).toContain("ada@example.com");
    expect(block).not.toContain("sentinel");
  });

  it("counts a message gone, skips a forbidden or malformed one, and fails on anything else", async () => {
    const { http } = port((url) => {
      const id = url.pathname.split("/").pop();
      if (id === "gone") return new GoogleError("not_found", 404);
      if (id === "shut") return new GoogleError("forbidden", 403);
      if (id === "odd") return { id: "other" };
      return metadata(id as string);
    });
    const reader = createTiesReader(http, ACCOUNT, DEPS);
    const page = await reader.fetch(["ok", "gone", "shut", "odd", "ok2"]);
    expect(page.items.map((one) => one.sourceItemId)).toEqual(["gmail-id:ok", "gmail-id:ok2"]);
    expect(page.gone).toBe(1);
    expect(page.skipped.map((one) => one.reason)).toEqual(["forbidden", "unsupported"]);

    const { http: down } = port(() => new GoogleError("unavailable", 503));
    await expect(createTiesReader(down, ACCOUNT, DEPS).fetch(["x"])).rejects.toMatchObject({ code: "unavailable" });
  });
});
