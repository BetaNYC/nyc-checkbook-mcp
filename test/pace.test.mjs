/**
 * The Comptroller's office rate-limits this API to 1 request per second.
 * Exceeding it puts us into a persistent blocked state at their Imperva edge
 * that presents as a 403 on every later request, including from a browser
 * (observed 2026-07-28). These tests guard the pacer that prevents it.
 *
 * The rule: one request at a time, process-wide, and each starts at least 1.1 s after the
 * previous one FINISHED (headers received, or the attempt failed), and after it started.
 * Most tests run on a virtual clock (test/helpers/upstream.mjs), so the checks are exact:
 * no timer slack, and a pacer set to 1,050 ms fails them.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pace, fetchWithRetry, resetUpstreamForTests } from "../dist/checkbook.js";
import { freshUpstream } from "./helpers/upstream.mjs";

const MIN_INTERVAL_MS = 1_100;
const OK_XML =
  "<response><status><result>success</result></status>" +
  "<result_records><record_count>0</record_count></result_records></response>";

let clock;
beforeEach(() => {
  clock = freshUpstream();
});

/** Take a turn, hold it for `busyMs` (the request in flight), end it. Returns [start, end]. */
async function request(busyMs) {
  const endTurn = await pace();
  const start = clock.now();
  await clock.sleep(busyMs);
  const end = clock.now();
  endTurn();
  return [start, end];
}

test("each request starts at least 1.1 s after the previous one finished", async () => {
  const spans = [];
  for (const busy of [0, 700, 2_500, 40]) spans.push(await request(busy));
  for (let i = 1; i < spans.length; i++) {
    const sinceEnd = spans[i][0] - spans[i - 1][1];
    const sinceStart = spans[i][0] - spans[i - 1][0];
    assert.ok(sinceEnd >= MIN_INTERVAL_MS, `request ${i} started ${sinceEnd} ms after the previous one finished`);
    assert.ok(sinceStart >= MIN_INTERVAL_MS, `request ${i} started ${sinceStart} ms after the previous one started`);
  }
});

test("concurrent callers go one at a time, each 1.1 s after the previous finished", async () => {
  // The case that actually bit us: several tool calls in flight at once.
  const spans = await Promise.all([500, 500, 500, 500].map((busy) => request(busy)));
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    const gap = spans[i][0] - spans[i - 1][1];
    assert.ok(gap >= MIN_INTERVAL_MS, `concurrent request ${i} started ${gap} ms after the previous one finished`);
  }
});

test("the next turn waits while a request is still in flight, however long it takes", async () => {
  const endFirst = await pace();
  let second = false;
  const next = pace().then((end) => {
    second = true;
    return end;
  });
  for (let i = 0; i < 20; i++) {
    await clock.sleep(5_000); // a slow reply: 100 s pass on the clock
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(second, false, "no second request while the first has not finished");
  endFirst();
  (await next)();
  assert.equal(second, true);
});

test("a failed attempt ends its turn, so later requests are not stuck", async () => {
  const policy = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 60_000, timeoutMs: 1_000 };
  await assert.rejects(() =>
    fetchWithRetry("http://x/api", {}, policy, {
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      makeSignal: () => undefined,
    })
  );
  const res = await fetchWithRetry("http://x/api", {}, policy, {
    fetchImpl: async () => new Response(OK_XML, { status: 200 }),
    makeSignal: () => undefined,
  });
  assert.equal(res.status, 200);
});

test("real clock: 1.1 s or more apart, measured on the monotonic clock, even when the wall clock jumps", async () => {
  resetUpstreamForTests(); // the real clock (performance.now and setTimeout)
  const realDateNow = Date.now;
  try {
    (await pace())();
    const finished = performance.now();
    // The wall clock jumps 10 s ahead. A pacer on Date.now would think the time had passed.
    const jump = realDateNow() + 10_000;
    Date.now = () => jump;
    (await pace())();
    const gap = performance.now() - finished;
    assert.ok(gap >= MIN_INTERVAL_MS, `second request ${gap.toFixed(1)} ms after the first finished`);
  } finally {
    Date.now = realDateNow;
  }
});
