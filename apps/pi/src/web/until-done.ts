// A write the server needs once, tried until it lands: at once, then after `first` milliseconds,
// the wait doubling up to `most`, each failure told to `failed`, until it succeeds or `stopped`
// says the server has closed. A failure `lasting` says cannot heal (a value the database refuses)
// is told once and ends the tries. True once it landed. `sleep` is the timer, a parameter for tests.
// It never rejects.
export async function untilDone(
  attempt: () => Promise<void>,
  failed: (error: unknown) => void,
  sleep: (ms: number) => Promise<void>,
  stopped: () => boolean,
  {
    first = 5_000,
    most = 300_000,
    lasting = () => false,
  }: {
    first?: number;
    most?: number;
    lasting?: (error: unknown) => boolean;
  } = {},
): Promise<boolean> {
  let wait = first;
  for (;;) {
    try {
      await attempt();
      return true;
    } catch (error) {
      try {
        failed(error);
      } catch {
        // A failure to tell of a failure is not the write's: the tries go on.
      }
      if (lasting(error)) return false;
    }
    if (stopped()) return false;
    try {
      await sleep(wait);
    } catch {
      return false;
    }
    if (stopped()) return false;
    wait = Math.min(wait * 2, most);
  }
}
