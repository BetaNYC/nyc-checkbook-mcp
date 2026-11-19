/**
 * The server reaches the network only through the global fetch, which the suite-wide guard
 * (test/helpers/no-network.mjs) replaces. A module that can look up a hostname or open a socket
 * by another route would get past that guard, so src/ must not import one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const SRC = new URL("../src/", import.meta.url);
const NETWORK = ["dns", "dns/promises", "net", "tls", "dgram", "http", "https", "http2", "undici"];
const NAMES = NETWORK.flatMap((m) => (m === "undici" ? [m] : [m, `node:${m}`]))
  .map((m) => m.replace(/[/]/g, "\\/"))
  .join("|");
// import ... from "x", import "x", import("x"), require("x"), and "undici/..." subpaths
const USES = new RegExp(`(?:from\\s*|import\\s*\\(?\\s*|require\\s*\\(\\s*)["'](?:${NAMES})(?:\\/[^"']*)?["']`);

test("src/ imports no module that can resolve a hostname or open a socket", () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 5, "found the source files");
  for (const f of files) {
    const text = readFileSync(new URL(f, SRC), "utf8");
    const hit = USES.exec(text);
    assert.equal(hit, null, `src/${f} uses ${hit?.[0]}: only the global fetch may reach the network`);
  }
});

test("the check itself catches each form", () => {
  for (const line of [
    'import { lookup } from "node:dns";',
    "import net from 'net';",
    'import "node:https";',
    'const h = await import("node:http");',
    'const u = require("undici");',
    'import { Agent } from "undici/lib/agent.js";',
    'import { promises } from "dns/promises";',
  ]) {
    assert.match(line, USES, line);
  }
  assert.doesNotMatch('import { readFileSync } from "node:fs";', USES);
  assert.doesNotMatch('import { z } from "zod";', USES);
});
