/**
 * Loaded before every test file (`node --import ./test/helpers/no-network.mjs --test ...` in
 * package.json). Replaces the real fetch with one that throws, so no test can reach Checkbook
 * NYC or any other site: its publisher blocks a whole network for going over its limits.
 *
 * A test that needs replies installs its own stub (globalThis.fetch = fake) and puts this one
 * back when done. A test that reaches fetch without a stub fails, even if the code under test
 * swallows the error (a tool turns it into an isError answer): afterEach throws, and if fetch
 * is called outside any test, the file's process exits with code 1.
 *
 * test/network-guard.test.mjs checks this file.
 */
import { afterEach } from "node:test";

const KEY = Symbol.for("nyc-checkbook-mcp.network-guard");
const calls = [];
const realFetch = globalThis.fetch;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The real fetch, for a test's own server on this machine only. Any other host throws. */
function loopbackFetch(input, init) {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (!LOOPBACK.has(url.hostname)) throw new Error(`loopbackFetch refuses ${url.hostname}: loopback only`);
  return realFetch(input, init);
}

function blockedFetch(input) {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  calls.push(url);
  throw new Error(
    `NETWORK BLOCKED: a test called the real fetch (${url}). Tests never touch the network; ` +
      "install a fake fetch for this test."
  );
}

globalThis.fetch = blockedFetch;
globalThis[KEY] = {
  blockedFetch,
  loopbackFetch,
  /** The URLs the real fetch was asked for since the last take(), and forget them. */
  take: () => calls.splice(0),
};

afterEach(() => {
  const urls = calls.splice(0);
  if (urls.length) throw new Error(`This test called the real fetch without a stub: ${urls.join(", ")}`);
});

process.on("exit", () => {
  if (calls.length) {
    process.stderr.write(`NETWORK BLOCKED: the real fetch was called outside a test: ${calls.join(", ")}\n`);
    process.exitCode = 1;
  }
});
