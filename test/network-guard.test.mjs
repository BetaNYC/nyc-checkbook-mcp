/**
 * The suite-wide network guard (test/helpers/no-network.mjs, loaded by `npm test` before every
 * test file). Every URL here ends in .invalid, a name that never resolves (RFC 6761), so even
 * a broken guard sends nothing anywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const KEY = Symbol.for("nyc-checkbook-mcp.network-guard");
const GUARD = fileURLToPath(new URL("./helpers/no-network.mjs", import.meta.url));

/** Run one test file under the guard, as npm test does, in a fresh test runner. */
function runUnderGuard(file) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // otherwise the child reports to this runner instead of exiting
  return spawnSync(process.execPath, ["--import", GUARD, "--test", file], { encoding: "utf8", env });
}

test("the guard is loaded, and the real fetch throws instead of calling out", () => {
  const guard = globalThis[KEY];
  assert.ok(guard, "test/helpers/no-network.mjs is not loaded: run the suite with npm test");
  assert.equal(globalThis.fetch, guard.blockedFetch, "fetch is the guard");
  assert.throws(() => fetch("https://guard-check.invalid/api"), /NETWORK BLOCKED: a test called the real fetch \(https:\/\/guard-check\.invalid\/api\)/);
  assert.deepEqual(guard.take(), ["https://guard-check.invalid/api"], "the call is recorded");
});

test("loopbackFetch, for a test's own local server, refuses any other host", () => {
  const { loopbackFetch } = globalThis[KEY];
  assert.throws(() => loopbackFetch("https://guard-check.invalid/"), /loopback only/);
});

test("a test that reaches fetch without a stub fails, even when the error is swallowed", () => {
  const dir = mkdtempSync(join(tmpdir(), "network-guard-"));
  try {
    const file = join(dir, "no-stub.test.mjs");
    writeFileSync(
      file,
      'import { test } from "node:test";\n' +
        'test("forgets its stub", async () => { try { await fetch("https://guard-check.invalid/api"); } catch {} });\n'
    );
    const r = runUnderGuard(file);
    assert.notEqual(r.status, 0, "the run fails");
    assert.match(r.stdout + r.stderr, /called the real fetch without a stub: https:\/\/guard-check\.invalid\/api/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetch called outside any test still fails the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "network-guard-"));
  try {
    const file = join(dir, "top-level.test.mjs");
    writeFileSync(file, 'try { fetch("https://guard-check.invalid/top"); } catch {}\n');
    const r = runUnderGuard(file);
    assert.notEqual(r.status, 0, "the run fails");
    assert.match(r.stdout + r.stderr, /outside a test: https:\/\/guard-check\.invalid\/top/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
