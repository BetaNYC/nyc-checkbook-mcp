// Docs that must agree with each other or with the code (review of epic #49).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SHARED_MODULE_VERSION } from "../dist/betanyc-tools.js";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("every agency code WHATS-CHANGED.md tells readers to use is in the README's agency table", () => {
  const table = read("README.md").split("## Common agency codes")[1].split("\n## ")[0];
  const listed = new Set([...table.matchAll(/^\| `(\d{3})` \|/gm)].map((m) => m[1]));
  const told = [...read("WHATS-CHANGED.md").matchAll(/ask again with (\d{3})/g)].map((m) => m[1]);
  assert.ok(told.length >= 2);
  for (const code of told) assert.ok(listed.has(code), `WHATS-CHANGED.md says to use ${code}; the README table does not list it`);
});

test("the newest CHANGELOG release names the shared module version the code has", () => {
  const release = read("CHANGELOG.md").split(/^## \[(?!Unreleased)/m)[1].split(/^### /m)[0];
  const named = [...release.matchAll(/shared module (\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  assert.ok(named.length >= 1, "the intro names the shared module");
  for (const v of named) assert.equal(v, SHARED_MODULE_VERSION, `the intro says shared module ${v}`);
});
