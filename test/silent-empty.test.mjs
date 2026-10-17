// Offline tests for the silent-empty guard and the contract_class drop (#42).
// No network: fetch is stubbed, and the probe-script test puts a fake `curl`
// first on PATH.
//
// Fixtures are real API replies captured 2026-10-16 (provenance in each file):
//   contracts-revenue-silent-empty.xml    record_count 12293, no rows
//   contracts-revenue-contract-id-only.xml record_count 12293, one row, and the
//                                          SAME code-1 "no results found" message
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  parseResponse,
  assertNotSilentEmpty,
  callCheckbookApi,
  CheckbookApiError,
  DEFAULT_COLUMNS,
} from "../dist/checkbook.js";
import { registerTools, contractsColumns, contractsCriteria } from "../dist/tools.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const SILENT = fixture("contracts-revenue-silent-empty.xml");
const WITH_ROW = fixture("contracts-revenue-contract-id-only.xml");

async function withFetch(body, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { status: 200 });
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("#42 Contracts_revenue does not request contract_class (it suppresses every row)", () => {
  assert.ok(!DEFAULT_COLUMNS.Contracts_revenue.includes("contract_class"));
  for (const fy of [false, true]) {
    const criteria = contractsCriteria({ status: "registered", category: "revenue", ...(fy ? { fiscal_year: "2025" } : {}) });
    assert.ok(!contractsColumns(criteria, true).includes("contract_class"), `fy=${fy}`);
  }
});

test("the real silent-empty reply parses as a success with a count and no rows", () => {
  const r = parseResponse(SILENT);
  assert.equal(r.success, true);
  assert.equal(r.total_records, 12293);
  assert.equal(r.records.length, 0);
  // The control reply carries the same message but does return a row, so the
  // message cannot be the signal.
  const c = parseResponse(WITH_ROW);
  assert.equal(c.total_records, 12293);
  assert.equal(c.records.length, 1);
  assert.match(SILENT, /no results found/);
  assert.match(WITH_ROW, /no results found/);
});

test("assertNotSilentEmpty throws only when rows were due and none came", () => {
  const req = { type_of_data: "Contracts", records_from: 1 };
  assert.throws(
    () => assertNotSilentEmpty(req, 12293, 0),
    (e) => e instanceof CheckbookApiError && e.kind === "silent-empty" && /matched 12293/.test(e.message)
  );
  assert.throws(() => assertNotSilentEmpty({ type_of_data: "Contracts" }, 1, 0), CheckbookApiError);
  assert.throws(() => assertNotSilentEmpty({ type_of_data: "Contracts", records_from: 12293 }, 12293, 0), CheckbookApiError);
  // Normal empties pass.
  assertNotSilentEmpty(req, 0, 0); // true zero
  assertNotSilentEmpty({ type_of_data: "Contracts", records_from: 12294 }, 12293, 0); // past the end
  assertNotSilentEmpty(req, 12293, 1); // rows returned
});

test("callCheckbookApi rejects the real silent-empty reply instead of returning records: []", async () => {
  await withFetch(SILENT, async () => {
    await assert.rejects(
      () => callCheckbookApi({ type_of_data: "Contracts", records_from: 1, max_records: 1 }),
      (e) => e instanceof CheckbookApiError && e.kind === "silent-empty"
    );
  });
  await withFetch(WITH_ROW, async () => {
    const r = await callCheckbookApi({ type_of_data: "Contracts", records_from: 1, max_records: 1 });
    assert.equal(r.records.length, 1);
  });
});

test("search_contracts and get_contract surface a silent empty as isError, naming the count", async () => {
  const server = new McpServer({ name: "nyc-checkbook-mcp", version: "1.0.0" });
  registerTools(server);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await withFetch(SILENT, async () => {
      for (const [name, args] of [
        ["search_contracts", { category: "revenue", page_size: 1 }],
        ["get_contract", { contract_id: "X1", category: "revenue" }],
      ]) {
        const res = await client.callTool({ name, arguments: args });
        assert.equal(res.isError, true, name);
        assert.match(res.content[0].text, /matched 12293 Contracts record\(s\) but returned none/, name);
        assert.match(res.content[0].text, /do not conclude that no records exist/, name);
      }
    });
    // A page past the end is still a normal empty page.
    const pastEnd =
      "<response><status><result>success</result></status>" +
      "<result_records><record_count>5</record_count></result_records></response>";
    await withFetch(pastEnd, async () => {
      const res = await client.callTool({ name: "search_contracts", arguments: { page: 2, page_size: 50 } });
      assert.notEqual(res.isError, true);
      assert.match(res.content[0].text, /"total_records": 5/);
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("probe-api-spec.sh records a curl transport failure as ABORTED and exits 1 (no network)", () => {
  // A fake curl that fails like the 2026-10-16 HTTP/2 stream error (exit 92).
  const dir = mkdtempSync(join(tmpdir(), "probe-curl-"));
  writeFileSync(join(dir, "curl"), "#!/bin/sh\nexit 92\n");
  chmodSync(join(dir, "curl"), 0o755);
  const out = join(dir, "probe-results.txt");
  const script = new URL("../scripts/probe-api-spec.sh", import.meta.url).pathname;
  const r = spawnSync("bash", [script, out], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CHECKBOOK_PROBE_PACE: "0" },
    encoding: "utf8",
  });
  assert.equal(r.status, 1, r.stderr);
  const text = readFileSync(out, "utf8");
  assert.match(text, /ABORTED: curl exit 92 after 0 successful probe\(s\)\./);
  assert.match(r.stderr, /curl exit 92/);
});
