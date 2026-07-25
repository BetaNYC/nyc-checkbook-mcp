/**
 * HTTP client hardening — issues #23 (no redirect follow), #24 (backoff),
 * #21 (errors never report a zero count), #22 (single-source version).
 *
 * ALL OFFLINE. No request ever reaches checkbooknyc.com — the API is blocked and
 * under investigation by the data owner (a redirect-following request multiplies
 * load ~40x, which is the whole point of #23). Redirect/backoff/error behavior is
 * exercised against injected fakes and a LOCAL http server; the one real network
 * call in this file is to 127.0.0.1 (a loopback server we start and stop), which
 * empirically proves undici's redirect:"manual" behavior on this runtime.
 *
 * Mocks encode the DOCUMENTED contracts (engineering standards §0):
 *   - Retry-After: delay-seconds | HTTP-date (RFC 9110 §10.2.3 / MDN).
 *   - redirect:"manual" returns the actual 3xx response server-side, NOT an
 *     opaqueredirect (nodejs/undici#1193).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  fetchWithRetry,
  callCheckbookApi,
  CheckbookApiError,
  computeBackoffMs,
  parseRetryAfterMs,
  isRedirectResponse,
  DEFAULT_RETRY_POLICY,
} from "../dist/checkbook.js";
import { VERSION } from "../dist/version.js";

const here = dirname(fileURLToPath(import.meta.url));
const readPkg = () => JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));

// A minimal well-formed "success, zero records" API body (parseResponse → success).
const EMPTY_OK_XML =
  "<response><status><result>success</result></status>" +
  "<result_records><record_count>0</record_count></result_records></response>";

/** Deterministic fake deps for fetchWithRetry — no real fetch, clock, or timers. */
function fakeDeps(overrides = {}) {
  return {
    sleepImpl: async () => {},
    nowImpl: () => 0,
    randomImpl: () => 1, // full expo (no jitter shrink) for deterministic delays
    makeSignal: () => undefined, // no AbortSignal timer in unit tests
    ...overrides,
  };
}

// ─── Retry-After parsing (RFC 9110 §10.2.3 / MDN) ────────────────────────────

test("#24 parseRetryAfterMs: delay-seconds → milliseconds", () => {
  assert.equal(parseRetryAfterMs("120", () => 0), 120_000);
  assert.equal(parseRetryAfterMs("  5  ", () => 0), 5_000);
  assert.equal(parseRetryAfterMs("0", () => 0), 0);
});

test("#24 parseRetryAfterMs: HTTP-date relative to now, never negative", () => {
  const when = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
  assert.equal(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT", () => when - 30_000), 30_000);
  // A date already in the past clamps to 0, never negative.
  assert.equal(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT", () => when + 60_000), 0);
});

test("#24 parseRetryAfterMs: absent/garbage → undefined", () => {
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs(undefined), undefined);
  assert.equal(parseRetryAfterMs(""), undefined);
  assert.equal(parseRetryAfterMs("soon"), undefined);
});

// ─── Backoff shape ───────────────────────────────────────────────────────────

test("#24 computeBackoffMs: equal-jitter — always positive, exponential, bounded", () => {
  const policy = { maxAttempts: 9, baseDelayMs: 500, maxDelayMs: 8_000, deadlineMs: 1e9, timeoutMs: 1_000 };
  // random=0 → the guaranteed floor expo/2 (this is what makes "no immediate retry" structural)
  assert.equal(computeBackoffMs(1, policy, () => 0), 250);
  assert.equal(computeBackoffMs(2, policy, () => 0), 500);
  assert.equal(computeBackoffMs(3, policy, () => 0), 1_000);
  assert.ok(computeBackoffMs(1, policy, () => 0) > 0, "floor is strictly positive");
  // random=1 → full expo, doubling each attempt
  assert.equal(computeBackoffMs(1, policy, () => 1), 500);
  assert.equal(computeBackoffMs(2, policy, () => 1), 1_000);
  assert.equal(computeBackoffMs(3, policy, () => 1), 2_000);
  // capped at maxDelayMs
  assert.equal(computeBackoffMs(20, policy, () => 1), 8_000);
});

// ─── Redirect detection ──────────────────────────────────────────────────────

test("#23 isRedirectResponse: 3xx and opaqueredirect are redirects; 2xx/4xx/5xx are not", () => {
  for (const s of [300, 301, 302, 303, 307, 308, 399]) {
    assert.equal(isRedirectResponse({ status: s }), true, `status ${s} is a redirect`);
  }
  for (const s of [200, 204, 400, 403, 404, 500, 503]) {
    assert.equal(isRedirectResponse({ status: s }), false, `status ${s} is not a redirect`);
  }
  // Defensive: a spec-compliant opaqueredirect (browser-style) is caught too.
  assert.equal(isRedirectResponse({ status: 0, type: "opaqueredirect" }), true);
  assert.equal(isRedirectResponse({ status: 0 }), false);
});

// ─── #23: never follow a redirect ────────────────────────────────────────────

test("#23 fetchWithRetry passes redirect:'manual' and does NOT follow or retry a 3xx", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, redirect: init.redirect });
    return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/redirected" } });
  };
  const res = await fetchWithRetry(
    "https://x.example/api",
    { method: "POST" },
    DEFAULT_RETRY_POLICY,
    fakeDeps({ fetchImpl })
  );
  assert.equal(calls.length, 1, "exactly one request — the redirect was NOT chased");
  assert.equal(calls[0].redirect, "manual", "requests manual redirect handling");
  assert.equal(res.status, 302, "returns the 3xx as-is for the caller to surface");
});

test("#23 REAL loopback server: a 302 is returned, not followed (one hop, real undici)", async () => {
  const hits = [];
  const server = createServer((req, resp) => {
    hits.push(req.url);
    if (req.url === "/start") {
      resp.writeHead(302, { location: "/final" });
      resp.end();
    } else {
      resp.writeHead(200, { "content-type": "text/plain" });
      resp.end("THIS PATH MUST NOT BE REACHED");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    // REAL global fetch (no fetchImpl) — proves undici's redirect:"manual" on this runtime.
    const res = await fetchWithRetry(
      `http://127.0.0.1:${port}/start`,
      {},
      DEFAULT_RETRY_POLICY,
      { makeSignal: () => undefined }
    );
    assert.equal(res.status, 302, "undici returns the real 3xx status for redirect:'manual' (nodejs/undici#1193)");
    assert.equal(res.headers.get("location"), "/final", "Location is inspectable, not opaque");
    assert.deepEqual(hits, ["/start"], "server saw exactly one request — the redirect was NOT followed");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("#23 callCheckbookApi surfaces an unfollowed redirect as an ERROR, not an empty set", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "/x" } });
  try {
    await assert.rejects(
      () => callCheckbookApi({ type_of_data: "Budget" }),
      (err) => err instanceof CheckbookApiError && err.kind === "redirect"
    );
  } finally {
    globalThis.fetch = original;
  }
});

// ─── #24: backoff, no immediate retry, 4xx never retried ─────────────────────

test("#24 5xx retries back off: no immediate retry, delay elapses, order preserved", async () => {
  const events = [];
  const delays = [];
  let clock = 0;
  const responses = [
    () => new Response("", { status: 503 }),
    () => new Response("", { status: 503 }),
    () => new Response(EMPTY_OK_XML, { status: 200 }),
  ];
  let i = 0;
  const fetchImpl = async () => {
    events.push("fetch");
    return responses[i++]();
  };
  const sleepImpl = async (ms) => {
    events.push(`sleep:${ms}`);
    delays.push(ms);
    clock += ms; // fake clock only advances when we actually await a sleep
  };
  const policy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000, deadlineMs: 1e9, timeoutMs: 1_000 };
  const res = await fetchWithRetry(
    "http://x/api",
    {},
    policy,
    fakeDeps({ fetchImpl, sleepImpl, nowImpl: () => clock })
  );

  assert.equal(res.status, 200, "eventually returns the success response");
  assert.deepEqual(
    events,
    ["fetch", "sleep:500", "fetch", "sleep:1000", "fetch"],
    "every retry is preceded by a sleep — never an immediate retry"
  );
  assert.deepEqual(delays, [500, 1_000], "exponential spacing (random=1 → full expo: 500 then 1000)");
  assert.ok(delays.every((d) => d > 0), "each backoff is strictly positive");
  assert.equal(clock, 1_500, "the fake clock advanced by the summed backoff — each sleep was awaited");
});

test("#24 honors Retry-After (seconds) over the computed backoff on a 5xx", async () => {
  const sleeps = [];
  const responses = [
    () => new Response("", { status: 503, headers: { "retry-after": "2" } }),
    () => new Response(EMPTY_OK_XML, { status: 200 }),
  ];
  let i = 0;
  const policy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000, deadlineMs: 1e9, timeoutMs: 1_000 };
  const res = await fetchWithRetry(
    "http://x/api",
    {},
    policy,
    fakeDeps({ fetchImpl: async () => responses[i++](), sleepImpl: async (ms) => sleeps.push(ms) })
  );
  assert.equal(res.status, 200);
  assert.deepEqual(sleeps, [2_000], "waited the server-instructed 2s, not the 500ms computed backoff");
});

test("#24 NEVER retries a 4xx — 403 is an answer, returned on the first hop", async () => {
  const calls = [];
  const sleeps = [];
  const res = await fetchWithRetry(
    "http://x/api",
    {},
    DEFAULT_RETRY_POLICY,
    fakeDeps({
      fetchImpl: async () => {
        calls.push(1);
        return new Response("Forbidden", { status: 403 });
      },
      sleepImpl: async (ms) => sleeps.push(ms),
    })
  );
  assert.equal(res.status, 403);
  assert.equal(calls.length, 1, "a 4xx must not be retried (this is the block-trigger pattern)");
  assert.equal(sleeps.length, 0, "no backoff sleep for a 4xx");
});

test("#24 network errors back off, are capped at maxAttempts, then rethrow the last error", async () => {
  const sleeps = [];
  let calls = 0;
  const policy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, deadlineMs: 1e9, timeoutMs: 1_000 };
  await assert.rejects(
    () =>
      fetchWithRetry(
        "http://x/api",
        {},
        policy,
        fakeDeps({
          fetchImpl: async () => {
            calls++;
            throw new Error(`boom-${calls}`);
          },
          sleepImpl: async (ms) => sleeps.push(ms),
        })
      ),
    /boom-3/
  );
  assert.equal(calls, 3, "tried up to maxAttempts");
  assert.equal(sleeps.length, 2, "backed off before each of the 2 retries");
});

test("#24 the overall deadline prevents starting a retry that would exceed it", async () => {
  const sleeps = [];
  let calls = 0;
  // deadline 100ms; first computed backoff (base 1000, random 1) = 1000 > 100 → give up now.
  const policy = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 8_000, deadlineMs: 100, timeoutMs: 1_000 };
  const res = await fetchWithRetry(
    "http://x/api",
    {},
    policy,
    fakeDeps({
      fetchImpl: async () => {
        calls++;
        return new Response("", { status: 503 });
      },
      sleepImpl: async (ms) => sleeps.push(ms),
    })
  );
  assert.equal(res.status, 503, "surfaces the 5xx rather than sleeping past the deadline");
  assert.equal(calls, 1, "no retry attempted");
  assert.equal(sleeps.length, 0);
});

// ─── #21: an upstream error is NEVER a zero-record success ────────────────────

test("#21 callCheckbookApi throws on a 403 — never total_records:0", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" });
  try {
    await assert.rejects(
      () => callCheckbookApi({ type_of_data: "Spending" }),
      (err) => err instanceof CheckbookApiError && err.kind === "http" && err.status === 403
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("#21 an API-level failure status throws, it does not resolve to an empty set", async () => {
  const original = globalThis.fetch;
  const failXml =
    "<response><status><result>failure</result><messages><message><code>1101</code>" +
    "<description>bad param</description></message></messages></status></response>";
  globalThis.fetch = async () => new Response(failXml, { status: 200 });
  try {
    await assert.rejects(
      () => callCheckbookApi({ type_of_data: "Revenue" }),
      (err) => err instanceof CheckbookApiError && err.kind === "api" && /bad param/.test(err.message)
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("#21 a genuinely empty-but-successful result STILL returns total_records:0 (no false throw)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(EMPTY_OK_XML, { status: 200 });
  try {
    const res = await callCheckbookApi({ type_of_data: "Spending" });
    assert.equal(res.total_records, 0, "'no matching records' is a real, successful zero");
    assert.deepEqual(res.records, []);
  } finally {
    globalThis.fetch = original;
  }
});

// ─── #22: one version, derived from package.json, on the wire ────────────────

test("#22 VERSION equals package.json version", () => {
  assert.equal(VERSION, readPkg().version);
});

test("#22 the outbound User-Agent carries the package.json version", async () => {
  const pkg = readPkg();
  const original = globalThis.fetch;
  let seenUA;
  globalThis.fetch = async (_url, init) => {
    seenUA = new Headers(init.headers).get("user-agent");
    return new Response(EMPTY_OK_XML, { status: 200 });
  };
  try {
    await callCheckbookApi({ type_of_data: "Budget" });
    assert.equal(seenUA, `betanyc-checkbook-mcp/${pkg.version} (github.com/BetaNYC/nyc-checkbook-mcp)`);
    assert.match(seenUA, new RegExp(pkg.version.replace(/\./g, "\\.")));
  } finally {
    globalThis.fetch = original;
  }
});

test("#22 built index.js derives the version from ./version.js (no hardcoded literal)", () => {
  const idx = readFileSync(join(here, "..", "dist", "index.js"), "utf8");
  assert.match(idx, /from ["']\.\/version\.js["']/, "imports the single-source VERSION");
  assert.doesNotMatch(idx, /version:\s*["']\d/, "no hardcoded 'version: \"x.y.z\"' literal remains");
});
