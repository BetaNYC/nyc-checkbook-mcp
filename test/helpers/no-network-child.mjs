/**
 * Preload for a server process a test starts as a child (test/stdout.test.mjs). The suite's
 * guard (no-network.mjs) uses node:test, which a plain server process must not load: it would
 * write test output to stdout. So this one only replaces the real fetch with one that throws,
 * and says so on stderr, which the test checks.
 */
globalThis.fetch = (input) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  process.stderr.write(`NETWORK BLOCKED: the server called the real fetch (${url})\n`);
  throw new Error(`NETWORK BLOCKED: ${url}`);
};
