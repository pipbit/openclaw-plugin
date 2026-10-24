// Every timer the connect client starts goes through one TimerSet, so stop()
// can clear all of them at once and the process (the Gateway, or the
// conformance harness) is never kept alive by a forgotten hold-off, ping or
// wait. A timer removes itself from the set when it fires.

export type TimerHandle = ReturnType<typeof setTimeout>;

export class TimerSet {
  readonly #live = new Set<TimerHandle>();

  /** Run `fn` once after `ms` milliseconds (never negative). */
  set(fn: () => void, ms: number): TimerHandle {
    const handle: TimerHandle = setTimeout(() => {
      this.#live.delete(handle);
      fn();
    }, Math.max(0, ms));
    this.#live.add(handle);
    return handle;
  }

  /** Cancel one timer; a handle that already fired or is null is fine. */
  clear(handle: TimerHandle | null | undefined): void {
    if (handle === null || handle === undefined) {
      return;
    }
    clearTimeout(handle);
    this.#live.delete(handle);
  }

  /** Cancel every timer still pending. */
  clearAll(): void {
    for (const handle of this.#live) {
      clearTimeout(handle);
    }
    this.#live.clear();
  }

  /** How many timers are pending (tests use it to prove stop() cleared them). */
  get size(): number {
    return this.#live.size;
  }
}
