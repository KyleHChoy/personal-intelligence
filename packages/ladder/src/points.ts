import {
  DECISION_POINT_PINS,
  DECISION_POINTS,
  POINT_THRESHOLDS,
  PROMPT_PINS,
  THRESHOLD_PINS,
} from "@intelligence/contracts/personal";
import { loadRegistry } from "./registry.ts";

// Made when the module loads: a bad definition stops every process that imports the ladder.
// Every rung 1 point's thresholds are checked against THRESHOLD_PINS.
export const REGISTRY = loadRegistry(DECISION_POINTS, DECISION_POINT_PINS, PROMPT_PINS, {
  constants: POINT_THRESHOLDS,
  pins: THRESHOLD_PINS,
});
