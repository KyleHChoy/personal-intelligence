import type { DecisionPointDefinition, PointThresholds, Sha256 } from "@intelligence/contracts/personal";
import { definitionHash, loadRegistry, thresholdsHash } from "../registry.ts";

// These register nothing: each point's own step registers it in the contracts.

const PROMPTS: Readonly<Record<string, Sha256>> = {
  "jev_project@1": "c".repeat(64),
  "luna_project@1": "d".repeat(64),
  "jev_same_fact@1": "e".repeat(64),
  "luna_same_fact@1": "f".repeat(64),
  "jev_belief_change@1": "1".repeat(64),
  "jev_change_worth@1": "2".repeat(64),
};

const bounds = (value: number, floor: number, ceiling: number) => ({ default: value, floor, ceiling });

export const LINK: DecisionPointDefinition = {
  id: "project_link",
  version: 1,
  rungs: [0, 1, 2, 4],
  outputs: { propose: "propose_binding", none: "record_silence" },
  queue: "project_link",
  onNoAnswer: "decline",
  expiresAfterDays: 14,
  prompts: [
    { id: "jev_project", version: "1" },
    { id: "luna_project", version: "1" },
  ],
  models: [
    {
      rung: 1,
      prompt: { id: "jev_project", version: "1" },
      question: "about_project",
      onAccept: ["propose"],
      onReject: ["none"],
      thresholds: { accept: "accept", reject: "reject" },
    },
    {
      rung: 2,
      prompt: { id: "luna_project", version: "1" },
      question: "about_project",
      onAccept: ["propose"],
      onReject: ["none"],
      unsure: "reject",
    },
  ],
};

export const SAME: DecisionPointDefinition = {
  id: "claims_same_fact",
  version: 1,
  rungs: [0, 1, 2, 4],
  outputs: { same: "propose_grouping", different: "record_silence" },
  queue: "same_fact",
  onNoAnswer: "record_silence",
  expiresAfterDays: 14,
  prompts: [
    { id: "jev_same_fact", version: "1" },
    { id: "luna_same_fact", version: "1" },
  ],
  models: [
    {
      rung: 1,
      prompt: { id: "jev_same_fact", version: "1" },
      question: "same_fact",
      onAccept: ["same"],
      onReject: ["different"],
      thresholds: { accept: "accept", reject: "reject" },
    },
    {
      rung: 2,
      prompt: { id: "luna_same_fact", version: "1" },
      question: "same_fact",
      onAccept: ["same"],
      onReject: ["different"],
    },
  ],
};

export const CHANGE: DecisionPointDefinition = {
  id: "belief_change",
  version: 1,
  rungs: [0, 1, 4],
  outputs: { change: "supersede_earlier", conflict: "hold" },
  queue: "belief_dispute",
  onNoAnswer: "hold",
  expiresAfterDays: 14,
  prompts: [{ id: "jev_belief_change", version: "1" }],
  models: [
    {
      rung: 1,
      prompt: { id: "jev_belief_change", version: "1" },
      question: "changed",
      onAccept: ["change"],
      onReject: [],
      thresholds: { accept: "accept", reject: null },
    },
  ],
  whileWaiting: "conflict",
};

export const WORTH: DecisionPointDefinition = {
  id: "change_worth_run",
  version: 1,
  rungs: [0, 1],
  outputs: { offer: "offer_wake", skip: "record_silence" },
  prompts: [{ id: "jev_change_worth", version: "1" }],
  models: [
    {
      rung: 1,
      prompt: { id: "jev_change_worth", version: "1" },
      question: "worth_attention",
      onAccept: ["offer"],
      onReject: [],
      thresholds: { accept: "accept", reject: null },
    },
  ],
  fallback: "skip",
};

export const CONSTANTS: Readonly<Record<string, PointThresholds>> = {
  "project_link@1": { accept: bounds(0.8, 0.6, 0.95), reject: bounds(0.2, 0.05, 0.5) },
  "claims_same_fact@1": { accept: bounds(0.95, 0.8, 0.99), reject: bounds(0.2, 0.05, 0.5) },
  "belief_change@1": { accept: bounds(0.95, 0.8, 0.99) },
  "change_worth_run@1": { accept: bounds(0.8, 0.5, 0.95) },
};

const pinsFor = (definitions: readonly DecisionPointDefinition[]): Record<string, Sha256> =>
  Object.fromEntries(
    definitions.map((definition) => [`${definition.id}@${definition.version}`, definitionHash(definition)]),
  );

// A full load: every definition under its own pin, and the thresholds with theirs, so only the
// rule under test can refuse.
export const loadFull = (
  definitions: readonly DecisionPointDefinition[],
  constants: Readonly<Record<string, PointThresholds>> = CONSTANTS,
) =>
  loadRegistry(definitions, pinsFor(definitions), PROMPTS, {
    constants,
    pins: Object.fromEntries(Object.entries(constants).map(([key, thresholds]) => [key, thresholdsHash(thresholds)])),
  });
