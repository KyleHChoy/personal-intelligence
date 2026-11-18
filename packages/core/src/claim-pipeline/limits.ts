import type { PipelineConfig } from "@intelligence/contracts";

// What the parser accepts. Anything over a limit is parse_failed, with no content. The limits
// are configuration: PipelineConfig carries them, and processItem reads them from there. The
// line ends are counted first, because the MIME parser's work grows with them. The HTML
// parser's work grows with the square of the depth, so depth and tags are read off in one pass
// before the HTML is parsed.
export type Limits = PipelineConfig["limits"];

// The values this package's tests run under, and a place for a deployment to start from. No
// app falls back to them: a pipeline whose configuration names no limits does not start.
export const LIMITS: Limits = {
  payloadBytes: 32 * 1024 * 1024,
  payloadLines: 1_000_000,
  bodyChars: 1_000_000,
  htmlChars: 4_000_000,
  htmlDepth: 256,
  htmlTags: 50_000,
  lineChars: 20_000,
  attachments: 50,
  attachmentBytes: 10 * 1024 * 1024,
  segments: 2_000,
  promptChars: 400_000,
};

// Quotes nested deeper than this are read as text at this depth.
export const MAX_QUOTE_DEPTH = 8;
// How many of a message's people a quote may be credited to by name.
export const MAX_PARTIES = 50;
// A line longer than this introduces nothing: no name is looked for in it.
export const MAX_INTRO_CHARS = 300;
