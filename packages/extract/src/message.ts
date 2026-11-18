import type { ParsedItem, Timestamp } from "@intelligence/contracts";

// The `message` slot's JSON: `people`, `author` and `message`, where `date` is the message's sent time as a
// Timestamp, never the raw Date header and never null, so a mention's `observedAt` copied from it parses.

const people = (parsed: ParsedItem, sentAt: Timestamp) => ({
  from: parsed.headers.from?.[0] ?? null,
  to: [...(parsed.headers.to ?? []), ...(parsed.headers.cc ?? [])],
  date: sentAt,
});

const author = (segment: ParsedItem["segments"][number]) => ({
  author: segment.author?.key.value ?? null,
  quoted: segment.quoted,
});

export const messageSlot = (parsed: ParsedItem, sentAt: Timestamp) => ({
  citable: true,
  ...people(parsed, sentAt),
  segments: parsed.segments.map((segment) => ({ span: segment.span, ...author(segment), text: segment.text })),
});

// A message's or an agent record's one slot.
export const messageData = (parsed: Parameters<typeof messageSlot>[0], sentAt: Timestamp): Record<string, string> => ({
  message: JSON.stringify(messageSlot(parsed, sentAt)),
});
