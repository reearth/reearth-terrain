// Sharing one piece of in-flight work between callers, safely across requests.
//
// The obvious way to deduplicate work in a Worker is to park the promise in a
// module-level or instance-level map and let later callers await it. That is
// correct while everything stays inside one invocation, and it is a trap
// across invocations: the runtime cancels the I/O of a request that goes
// away, and a promise that was still pending when that happened **never
// settles**. It stays in the map, and every later request that awaits it
// waits forever — which the runtime eventually reports as
//
//   "The Workers runtime canceled this request because it detected that your
//    Worker's code had hung and would never generate a response."
//
// One poisoned entry is enough to take out an isolate for the rest of its
// life, which is why the rate of these climbs with time since deploy rather
// than with load. Clients time out and disconnect, which cancels more
// requests, which poisons more entries.
//
// `shared` keeps the deduplication and refuses to wait on a stale entry: an
// entry that has not settled within its deadline is dropped and the work is
// started again for this caller. The abandoned promise is left alone — it is
// not ours to cancel, and it will never settle anyway.

export interface SharedOptions {
  /**
   * How long to wait on an entry somebody else put there before deciding its
   * owner is gone. Generous: exceeding it costs a duplicated read, not an
   * error, but being too eager duplicates work under ordinary slowness.
   */
  timeoutMs: number;
  /**
   * Whether a resolved entry stays in the map (a memo) or is removed once it
   * settles (deduplication only). Rejections are always removed.
   */
  keepResolved?: boolean;
}

type Outcome<T> =
  | { state: "value"; value: T }
  | { state: "error"; error: unknown }
  | { state: "pending" };

export async function shared<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  make: () => Promise<T>,
  { timeoutMs, keepResolved = true }: SharedOptions,
): Promise<T> {
  const existing = cache.get(key);
  if (existing) {
    const outcome = await settleWithin(existing, timeoutMs);
    if (outcome.state === "value") return outcome.value;
    if (outcome.state === "error") throw outcome.error;
    // Pending past the deadline: whoever started this is not coming back.
    if (cache.get(key) === existing) cache.delete(key);
  }

  const started = make();
  cache.set(key, started);
  const forget = () => {
    if (cache.get(key) === started) cache.delete(key);
  };
  started.then(keepResolved ? undefined : forget, forget);
  return started;
}

/** Resolve to the promise's outcome, or to `pending` once `ms` has passed. */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<Outcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ state: "pending" }), ms);
  });
  return Promise.race([
    promise.then(
      (value): Outcome<T> => ({ state: "value", value }),
      (error): Outcome<T> => ({ state: "error", error }),
    ),
    deadline,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** A single R2 range read, or one archive pointer. */
export const READ_TIMEOUT_MS = 10_000;

/** Opening a COG: a handful of reads plus parsing. */
export const OPEN_TIMEOUT_MS = 20_000;
