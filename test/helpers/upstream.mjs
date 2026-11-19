/**
 * Test helpers for the process-wide pacer and lock in src/checkbook.ts.
 *
 * virtualClock(): a clock whose sleep() moves time forward at once, so pacing tests are exact
 * (no timer slack) and fast. freshUpstream(): unlock and reset the pacer, on a virtual clock
 * unless told otherwise. Each test file runs in its own process, so state never crosses files.
 */
import { resetUpstreamForTests } from "../../dist/checkbook.js";

export function virtualClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += Math.max(0, ms);
    },
  };
}

/** Reset the pacer and the lock. Returns the clock in use. */
export function freshUpstream(clock = virtualClock()) {
  resetUpstreamForTests(clock);
  return clock;
}

/** Run fn with globalThis.fetch replaced by fake, then put the guard back. */
export async function withFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}
