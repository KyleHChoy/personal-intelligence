import type { ParsedItem, Timestamp } from "@intelligence/contracts";

// What an email's headers say, read with no model: who sent it, who it went to, when, and the
// earlier messages it answers.
export interface HeaderReading {
  sender?: string;
  recipients: string[];
  sentAt?: Timestamp;
  messageId?: string;
  // The Message-IDs of the replies this message answers, nearest first, uncut.
  replyChain: string[];
}

export function readHeaders(parsed: ParsedItem): HeaderReading {
  const header = (key: string): string[] => parsed.headers[key] ?? [];
  const [sender, sentAt, messageId] = [header("from")[0], header("date")[0], header("message-id")[0]];
  // References lists the chain oldest first. In-Reply-To names the nearest, and comes first
  // even when References leaves it out.
  const chain = [...header("in-reply-to").slice(0, 1), ...header("references").toReversed()];
  return {
    ...(sender !== undefined && { sender }),
    recipients: [...header("to"), ...header("cc"), ...header("bcc")],
    ...(sentAt !== undefined && { sentAt }),
    ...(messageId !== undefined && { messageId }),
    replyChain: [...new Set(chain)].filter((id) => id !== messageId),
  };
}
