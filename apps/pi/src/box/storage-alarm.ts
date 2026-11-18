// The capture storage alarm: where the database's size stands against
// PI_CAPTURE_STORAGE_CEILING_BYTES, past which every capture item is refused.
// `pia status` carries it and, past 70 percent, logs `capture_storage` with the code;
// `pia status --storage` prints the code alone, which the box's timer writes to its output when it
// changes. A size and a ceiling, nothing of any row.

export const STORAGE_ALARMS = ["ok", "warn_70", "warn_85", "ceiling"] as const;
export type StorageAlarm = (typeof STORAGE_ALARMS)[number];

export function storageAlarm(databaseBytes: number, ceilingBytes: number): StorageAlarm {
  if (databaseBytes >= ceilingBytes) return "ceiling";
  if (databaseBytes * 100 >= ceilingBytes * 85) return "warn_85";
  if (databaseBytes * 100 >= ceilingBytes * 70) return "warn_70";
  return "ok";
}
