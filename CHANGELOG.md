# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.3] - 2026-10-16

### Fixed

- **`search_nycha_contracts` and `search_nycedc_contracts` failed for one call
  shape each (#40).** Each default response-column list carried a column the
  live API accepts for one call shape and rejects for another, and one rejected
  column fails the whole request. Both columns come from the published API
  config, which lists them unconditionally. The failing shapes:
  - NYCHA requested `year`. The live API lists `year` as valid when `fiscal_year`
    is sent, and rejected it on a `vendor_name`-only search. So a NYCHA search
    without `fiscal_year` failed; one with `fiscal_year` did not.
  - OGE requested `apt_pin`. The live API lists `apt_pin` as valid without
    `fiscal_year`, and rejected it on a `fiscal_year` search. So an NYCEDC search
    with `fiscal_year` failed; one without it did not.

  Both have been in the default lists since the tools were added in 1.2.0 (#7).
- **Response columns now depend on the call shape**, the way `contractsColumns()`
  already does for citywide contracts. The base lists in `DEFAULT_COLUMNS` carry
  neither column. `nychaContractsColumns()` appends `NYCHA_FISCAL_YEAR_COLUMNS`
  (`year`) only when `fiscal_year` is among the criteria sent, and
  `nycedcContractsColumns()` appends `OGE_ALL_YEARS_COLUMNS` (`apt_pin`) only when
  it is not. NYCHA results therefore carry `year` when filtered by `fiscal_year`,
  and no year field otherwise. NYCEDC results carry `apt_pin` only without
  `fiscal_year`.
- **Verified live on 2026-10-16** against this release's code, one request at a
  time at 3 s pacing, no 403s. `bash scripts/probe-api-spec.sh` returned 35/35
  HTTP 200 and `npm run check:columns` passed every list in every probed shape.
  Then one paced tool call per shape, each HTTP 200 with no 1106:
  `search_nycha_contracts` with `vendor_name` only (the shape #40 broke) returned
  a record without `year`; with `fiscal_year` it returned a record with `year`.
  `search_nycedc_contracts` with `fiscal_year` (the shape #40 broke) returned
  records; with `vendor_name` only (sending `apt_pin`) it was accepted and
  matched 0 records. An earlier check on 2026-10-15 sent `fiscal_year` for both
  tools, so it proved the OGE fix only. That verification predates the #42 fix
  below and does not cover it.
- **`search_contracts` and `get_contract` failed for every registered revenue
  contract (#42).** Both sent the registered/expense column list
  (`prime_contract_*`) for every `category`. `status=registered, category=revenue`
  resolves a different domain, `Registered Contracts(revenue)`, whose vocabulary
  uses plain names, and the live API rejected the first column:
  `search_contracts({category:"revenue"})` returned "Provided response column
  'prime_contract_id' value is not allowed for 'Registered Contracts(revenue) All
  Years' domain" (2026-10-16). 18 of the 20 expense columns are absent from that
  domain's list. `contractsColumns()` now takes the criteria a call sends and
  picks the list per `(status, category)`: registered `expense`/`all` keep
  `DEFAULT_COLUMNS.Contracts` (the registered/all domain lists the same names,
  `sub_*` included); registered `revenue` uses the new
  `DEFAULT_COLUMNS.Contracts_revenue`; every `pending` category keeps
  `Contracts_pending` (all pending domains list the same names). `fiscal_year`
  changes nothing: each chosen column is listed both with and without it. The
  revenue list (16 columns) carries the equivalent fields (id, vendor, purpose,
  agency, amounts, dates, award method, type, M/WBE, industry, PIN, WBE/EBE
  flags, version) under that domain's own names. It has no spent-to-date or sub-vendor
  fields, because the domain lists none, so `include_sub_vendors` is ignored
  for revenue, as it already was for pending. `get_contract` uses the same
  selection.
- **`contract_class` is not requested for registered revenue contracts (#42).**
  It is in both live valid lists, so the column checker passed it, but sending
  it makes the API return no rows. The reply is a success with
  `record_count` 12293 (no `fiscal_year`) or 399 (`fiscal_year` 2025) and no
  transactions (live, 2026-10-16). A bisect over the first revenue list, in 9
  paced calls, isolated it: `contract_id` + `contract_class` returned nothing,
  and every half without `contract_class` returned rows. The first revenue list
  shipped on this branch included it, so `search_contracts` for revenue returned
  `records: []` alongside a count of thousands. `contract_class` stays in the
  expense/all list, where the live `category: "all"` call returned rows with it.
- **A silent empty is now an error, not an empty page (#42).** When the API
  reports `record_count` N > 0, the requested `records_from` is at most N, and
  no rows come back, `callCheckbookApi()` throws a `CheckbookApiError` of kind
  `silent-empty`. The tool result is `isError` and says that the API matched N
  records but returned none, names the causes seen so far (a row-suppressing
  response column, and the upstream revenue + `fiscal_year` defect) without
  asserting either, and says this does not mean no records exist. It
  is an error rather than a warning field for the same reason as #21: a result
  that cannot be the true answer must not be readable as one, and a caller
  given `records: []` will report "none". A page past the end and a true zero
  are still normal empty results. The reply's message (code 1, "no results
  found") is not used as the signal, because the API sends the same message
  when it does return rows.
- **Verification status for #42.** Live on 2026-10-16, against the list that
  still had `contract_class`: the full 43-request probe returned HTTP 200 for
  every variant (one transport failure, retried, below) and `npm run
  check:columns` exited 0 for every list. `search_contracts` with
  `category: "all"` and with `status: "pending", category: "revenue"` returned
  records. Registered revenue returned the silent empty above. Then, against
  this release's 16-column list, one paced call per shape (3 s apart, no 403s),
  each returning at least one row: `search_contracts` registered expense (with
  and without `fiscal_year`, and with `include_sub_vendors`), registered revenue
  without `fiscal_year`, `all` (with and without), pending expense, revenue and
  `all`; `get_contract` for a revenue and an expense contract;
  `search_nycha_contracts` by `vendor_name` and by `fiscal_year`;
  `search_nycedc_contracts` by `fiscal_year` and by `contract_id`.
- **Known upstream limitation: registered revenue with `fiscal_year` returns
  no rows.** The Checkbook API reports a match count (399 for FY2025) but sends
  no rows, whatever response columns are requested, including `contract_id`
  alone (live, 2026-10-16, bisected over every column). It is a server-side
  defect this release cannot fix. `search_contracts` **fails fast** on that
  shape: when status is `registered` (the default), category is `revenue`, and
  `fiscal_year` is sent, it returns `isError` with guidance (a known upstream
  limitation; omit `fiscal_year` and filter by date range) and sends no
  request, so no call is spent from the 1 req/sec budget on a reply that cannot
  return rows. Any other path to that reply still hits the silent-empty guard.
  Search registered revenue without `fiscal_year` and filter by dates instead.
- **`scripts/probe-api-spec.sh` no longer dies silently on a transport
  failure.** A curl failure (exit 92, an HTTP/2 stream error, seen on probe 36
  on 2026-10-16) killed the script under `set -e`, leaving an empty section and
  no `ABORTED` line. It now writes `ABORTED: curl exit N after M successful
  probe(s).` and exits 1, like a non-200.
- **Record field names now differ by shape**, because records are returned as
  the API sends them, without normalization: registered expense/all use
  `prime_contract_*` names, while registered revenue and pending use plain names
  (`contract_id`, `purpose`, `agency`, ...). This was already true for pending;
  it is now true for revenue, which returned no records at all before.

### Added

- **`scripts/check-default-columns.mjs` (`npm run check:columns`)**: one checker
  for every default response-column list, per call shape, plus
  `SUB_VENDOR_COLUMNS`. It reads `probe-results.txt` and reports any column absent
  from the live valid-values list of a probe variant mapped to that shape. Each
  shape's list is checked only against that shape's variants, so NYCHA's `year`
  is checked against the `fiscal_year` variant and OGE's `apt_pin` against the
  variants without it. It makes no network requests. Absence is reported as
  `UNVERIFIED` rather than as rejected, since the probe lists are a floor, not a
  ceiling, but it still fails the check. It also fails on a missing or aborted
  probe variant; on a `COLUMNS` section whose text is not the 1106 response-column
  error (for example a 1101 request-parameter error, which lists criteria, not
  columns); and on a `DEFAULT_COLUMNS` key with no mapping. Every run prints the
  call shapes no probe covers. It replaces patching this defect class by hand
  (#16, v1.6.1, #40).
- **`scripts/probe-api-spec.sh` sends nineteen call-shape variants** (24 to 43
  requests, still paced at 1.5 s, ~65 s), because the column vocabulary depends
  on the criteria sent: citywide and pending contracts with `fiscal_year`;
  registered revenue with `fiscal_year` and with `contract_id` (the
  `get_contract` shape); registered and pending `all`, and pending `revenue`,
  each with and without `fiscal_year` (#42); OGE
  with `fiscal_year` and with `contract_id`; NYCHA by `vendor_name` without
  `fiscal_year`, by `contract_id`, and with no criteria; Spending by
  `issue_date`; Budget with its `year` criterion and with no criteria; and
  Payroll by `calendar_year`. A variant with no criteria omits
  `<search_criteria>` entirely, as `buildRequestXml` does.

### Documentation

- The `search_nycha_contracts` description and README say that results carry a
  year field only when filtering by `fiscal_year`, and none otherwise.
- The `search_contracts` `category` and `include_sub_vendors` descriptions, the
  `get_contract` description, and the README say which field names each
  `(status, category)` returns and that `include_sub_vendors` is ignored for
  revenue (#42). `scripts/README.md` adds the revenue vocabulary (item 7) and the
  silent-empty `contract_class` (item 8, a class the checker cannot detect) to
  the defects list, noting that whether the published docs describe them was
  not checked. "What a pass does not cover" now says a pass proves acceptance,
  not rows. README Releases adds a step after `check:columns`: one paced live
  call per contract shape, each returning at least one row.
- README Releases has a pre-release step: run the probe once, then
  `npm run check:columns`, before tagging. `npm run check:columns` is added to the
  Development table, and CONTRIBUTING covers column and call-shape changes.
- `scripts/README.md`: NYCHA `year` and OGE `apt_pin` are added to the
  documentation-defects list (eight entries now, with #42's two below; covering docs and config), each
  naming the call shape that failed. New sections cover the checker and how
  domain resolution depends on criteria.
- `src/checkbook.ts`: the OGE and NYCHA comments say the base lists are derived
  from the config and corrected against the live API, that the shape-specific
  column is appended in `src/tools.ts`, and not to add it to the base list. The
  citywide `Contracts` comment covers citywide only.

### Tests

- `test/check-default-columns.test.mjs` (23 tests, offline) runs against
  `test/fixtures/probe-results-sample.txt`, which is real API output with its
  provenance in its header. Covered: the parser (including an aborted section, and
  a `COLUMNS` section holding a 1101 error, which must be `UNPARSED-PROBE`);
  per-shape mapping, with each shape-specific column checked only in its own
  shape; `UNVERIFIED` wording rather than a rejection claim;
  `LIVE_VERIFIED_ABSENT`; missing-probe, missing shape list, and unmapped-domain
  failures; Budget mapped with and without `year`; each mapped variant must be
  one the probe script sends; the CLI's exit codes and untruncated piped output;
  and regressions for #16, v1.6.1 and #40, each flagged in the variant that omits
  the column. For #42: every column `contractsColumns()` sends for ten
  `(status, category, fiscal_year)` shapes is checked against that shape's real
  list in the fixture; `COLUMN_CHECKS` is pinned to the lists the tool sends; and
  sending the expense list for revenue is flagged as 18 unverified columns. The
  fixture gains the seven real sections from the 2026-10-16 #42 probes.
- `test/tools.test.mjs`: one base-list guard per domain (`!includes("year")` for
  NYCHA, `!includes("apt_pin")` for OGE), unit tests for both call shapes of
  `nychaContractsColumns()` and `nycedcContractsColumns()`, and an offline
  end-to-end test (stubbed `fetch`) that checks which columns each tool puts on
  the wire with and without `fiscal_year`. The tests that treated the published
  config as the authority for NYCHA and OGE response columns are removed.
  `test/silent-empty.test.mjs` (8 tests, offline) uses two real 2026-10-16
  replies as fixtures, `contracts-revenue-silent-empty.xml` (12293 matched, no
  rows) and `contracts-revenue-contract-id-only.xml` (rows, same message). It
  covers: the guard's boundaries (true zero, a page past the end, rows
  returned); `callCheckbookApi` rejecting the real reply; `search_contracts` and
  `get_contract` returning `isError` with the count; `contract_class` absent
  from every revenue shape; and the probe script's transport abort, run with a
  fake `curl` that exits 92. Two more cover the revenue + `fiscal_year`
  fail-fast: the shape predicate, and the tool refusing with guidance while the
  stubbed `fetch` is never called. Mutation-checked: re-adding `contract_class`
  fails 1 test, disabling the guard fails 2, reverting the probe fix fails 1,
  disabling the fail-fast fails 1, and restoring the old error text fails 1.
  For #42: `contractsColumns()` is tested for all 24
  `(status, category, fiscal_year, include_sub_vendors)` combinations, plus a
  guard that registered revenue never sends a `prime_contract_*`, `sub_*` or
  `year` column, and an offline end-to-end test that checks the columns
  `search_contracts` and `get_contract` put on the wire for revenue, all and
  pending. Mutation-checked: making the selection ignore `category` fails 6
  tests; restoring the hardcoded expense list in `get_contract` fails 1.

## [1.6.2] - 2026-10-11

### Fixed

- **The runtime surface no longer recommends `smart_search`, which 1.6.0 disabled
  (#34).** Three caller-visible strings still pointed at it after the gate landed:
  the `search_contracts` vendor-name guidance (`VENDOR_NAME_UNSUPPORTED_MESSAGE`,
  also returned for the `vendor` alias), the `vendor_name` parameter description,
  and the `get_contract` tool description. They now point at
  `search_spending(payee_name=…)`, whose results carry `contract_id`, and at
  `search_contracts` / `get_contract` by contract ID. The `smart_search` tool's own
  description and its disabled message are unchanged, since they must name the gate.
  The `CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS` reference the issue also flagged
  was already only a historical code comment saying the gate is gone; no change.
- New regression tests scan every `tools/list` description and input schema, plus
  the `vendor_name` / `vendor` error text, and fail if any of them names a
  disabled-by-default tool, by name or as prose ("smart search", any case).

## [1.6.1] - 2026-07-31

### Fixed

- **`include_sub_vendors: true` errored on every registered-contracts search.**
  `SUB_VENDOR_COLUMNS` contained `sub_contract_registration_date`, which the live
  API rejects with error 1106 on **both** registered/expense domain variants, the
  fiscal-year-scoped one and "All Years". Because one invalid response column
  fails the entire request, the query errored rather than degrading. Broken from
  **v1.2.0 through v1.6.0** — every release the feature has existed in.

  The token came from <https://www.checkbooknyc.com/contract-api>, which does list
  it. **The published documentation overstates the API.** This is the same
  docs-versus-live trap as `year` in #16, on the sub-vendor side rather than the
  prime side.

- **Added the three valid sub-vendor columns that were missing:**
  `sub_contract_start_date`, `sub_contract_end_date`, `sub_contract_reference_id`.
  `SUB_VENDOR_COLUMNS` is now the complete set of 13 `sub_*` tokens the live
  registered/expense domain accepts.

### Changed

- **The test oracle for `SUB_VENDOR_COLUMNS` is now the live API, not the docs.**
  This is the substantive change. The previous test asserted the column list
  against the published documentation, so **the suite stayed green through two
  releases while the feature was completely broken.** It now asserts against the
  API's own "Valid values are ..." list, with an explicit exclusion test for the
  rejected token mirroring the #16 regression guard.

- Corrected the 1.6.0 heading, which was published reading `UNRELEASED` while the
  tag and npm both said released.

### Verification

Live-verified 2026-07-31 by the reconciliation session, four paced requests, all
HTTP 200: the request as shipped returned 1106; the same request minus that token
succeeded; the All Years variant showed the token absent from its valid list too;
and the fixed request returned the new columns populated. Independently
reproduced here on 2026-07-31 with one further call, whose valid-values list
matched the corrected 13-token set exactly.

Tests: 77 pass, 0 fail.

Refs #8.

## [1.6.0] - 2026-07-29

HTTP client hardening and correctness fixes for the Checkbook API client, plus
compliance with the API's two published limits.

Most changes here were built and verified offline with mocks, fixtures, and a
loopback server. Access was restored on 2026-07-28, and the exceptions verified
against the live API are noted inline.

### Fixed

- **Requests are rate-paced to the published 1 per second.** The Comptroller's
  office confirmed on 2026-07-28 that the API allows **1 request per second** and
  up to **20,000 records per call**. Neither limit is published anywhere on
  checkbooknyc.com. Exceeding the rate limit does not throttle: their Imperva
  edge places the client into a blocked state that persists past the burst and
  returns HTTP 403 to every client on that IP, an ordinary browser included. A
  morning was spent misdiagnosing that block as an outage upstream.

  All outbound requests are now serialized and spaced at least 1.1s apart,
  process-wide, covering concurrent callers, retries, and `/smart_search`. This
  is distinct from the retry backoff below: backoff spaces retries of a single
  call, while the pacer spaces every call, including unrelated ones issued back
  to back by different tools. Guarded by `test/pace.test.mjs`, including the
  concurrent-callers case. **Known limitation:** the pacer is per-process, so two
  clients running at once can still exceed the limit, and no in-process fix
  addresses that (tracked in #28).
- **Redirects are no longer followed (#23).** `fetchWithRetry` now sends
  `redirect: "manual"`, so a 3xx is surfaced as an error instead of being chased.
  A single logical API call had been measured fanning out to roughly 40 requests
  against the Comptroller's edge (39 redirects before a terminal 403), because
  Node's `fetch` follows redirects by default. Node/undici returns the actual 3xx
  response for `redirect: "manual"` (nodejs/undici#1193), which the client
  inspects and rejects.
- **Retries use exponential backoff instead of zero backoff (#24).** The client
  previously retried 5xx and network failures immediately, the exact pattern the
  API operator named as their block trigger. It now uses equal-jitter exponential
  backoff with an attempt cap (default 3), an overall deadline, and honors
  `Retry-After` (RFC 9110 §10.2.3) when present. A 4xx is never retried (a 403 is
  an answer, not a transient failure). The 5xx-plus-network trigger set is
  unchanged.
- **An upstream error is never reported as `total_records: 0` (#21).**
  `callCheckbookApi` now throws `CheckbookApiError` on any failure (network or
  timeout, a non-2xx HTTP status, an unfollowed redirect, or an API-level failure
  status) instead of returning a zero-count "success". Every tool routes through
  the shared `guard()`, so a blocked or unreachable API surfaces as an `isError`
  result rather than being read by a model as "no records exist." A genuinely
  empty but successful result still reports `total_records: 0`. Audited across all
  tools (the `search_*` family, `get_contract`, `get_agency_spending`).
- **One version string, derived from `package.json` (#22).** The McpServer version
  (was `1.0.0`), the outbound `User-Agent` (was `1.0.1`), and `package.json` had
  diverged. The UA is sent on every request and is how the Comptroller's office
  identifies BetaNYC traffic, so the drift was externally visible. All three now
  derive from a single `src/version.ts` that reads `package.json` at runtime,
  chosen over JSON import attributes (which require Node >= 20.6 and would break
  the declared `engines.node >= 18`).

### Changed

- **`smart_search` is hard-gated off by default (#25).** The checkbooknyc.com
  `/smart_search` path is not a supported Checkbook NYC API endpoint; it is a
  WAF-fronted, JavaScript-rendered web page, confirmed with the Comptroller's
  office. The tool stays registered (so `tools/list` does not change) but fails
  fast with opt-in guidance and makes no network call unless
  `CHECKBOOK_ENABLE_SMART_SEARCH=1` is set. It has been removed from the README's
  described tool surface. Gating rather than removing keeps this a minor release,
  not a major one.
- **`max_records` ceiling raised from 1,000 to 20,000.** The old client-side cap
  silently clamped callers who asked for more and burned extra requests against a
  scarce budget, the same failure as New-York-City-Budget#42, where a 500-row cap
  made an FY2026 figure $90.3M low. **Live-verified 2026-07-28:**
  `max_records: 20000` against FY2026 registered expense contracts returned
  14,397 records in one response, matching the reported total. The API's own
  documentation contradicts itself here: the landing page says 20,000 while every
  domain parameter table says "fewer than 1000" and caps the field at four
  characters, which cannot express 20000. The landing page is correct.
- **Default page size stays at 50.** The practical ceiling for an MCP response is
  the caller's context window, not the API.

### Contract filters verified against the live API (2026-07-28)

All five filters added in 1.5.0 (#6/#8/#10) were checked against the live API and
the `CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS` gate has been **removed**. They
are now on by default.

Method: send a deliberately invalid criteria name and read the API's own
"Valid values are ..." list, then confirm each filter actually narrows a known
baseline. The second step matters — an accepted-but-ignored parameter returns the
baseline count unchanged, which is the silent-drop failure the gate existed to
prevent. Baseline: 19,139 registered/expense FY2025 contracts.

| Filter | API parameter | Result |
|---|---|---|
| `purpose` | `purpose` | 168 of 19,139 |
| `pin` | `pin` | exactly 1 |
| `registration_date_from/to` | `registration_date` (range) | 9,599 of 19,139 |
| `contract_includes_sub_vendors` | integer flag | `1` → 3,246; `0` → 0 |
| `received_date_from/to` | `received_date` (range) | open range → full pending set |

The API's valid-parameter lists also confirm the existing status gating, on both
the fiscal-year-scoped and "All Years" domain variants:

- registered: `registration_date`, `purpose`, `pin`, `contract_includes_sub_vendors`
- pending: `received_date`, `purpose`, `pin`

`received_date` had the weakest prior evidence (#17 never exercised the pending
domain) and is valid there.

### Fixed — `contract_includes_sub_vendors` is an integer, not a status code

1.5.0 documented this filter as "a 2-character code" with values passed through
verbatim, because the accepted values were not published. It is an **integer
flag**: `1` selects contracts that include sub-vendors. The parameter is now typed
`z.number().int()` rather than `z.string()`.

This mattered more than a wrong type usually would, because the failure is close
to invisible. A non-numeric value is rejected with `'Y' is not of data type
integer`, and the API delivers that as **HTTP 200 with a plain-text, non-XML
body**, which this client's XML parser reports as the misleading "Empty response".
Anyone following the old schema description would have gotten a blank result with
no indication of why.

Related trap, now documented in the schema: the **response column** of the same
name reports `N/A`, so a value observed in results cannot be fed back in as a
filter value. Column and filter use different value spaces.

### Fixed — defects found in a self-QA pass before merge

Three issues in code written earlier the same day, found by testing it rather
than re-reading it.

- **The rate pacer could be poisoned into permanent failure.** `pace()` chains
  each call off the previous one, and was built with only an `onFulfilled`
  handler. One rejection anywhere in the chain would leave `paceChain` rejected
  forever, so every later request would fail with an unrelated error until the
  process restarted. The chain now passes the scheduler as both arms
  (`.then(schedule, schedule)`) so pacing survives its own predecessor.
- **Out-of-range paging reached the wire.** `page_size` and `page` were unbounded,
  so `page_size: -5` was sent as `max_records=-5` and `page: 0` as
  `records_from=-49` — requests that cannot succeed, each spending one call from a
  1-per-second budget. Both are now `.int()` with a floor, and `page_size` carries
  the 20,000 ceiling. Bounded rather than clamped, consistent with #19: this server
  rejects bad input instead of silently coercing it.
- **`search_contracts` did not use the shared page schema.** It declared `page`
  inline, so the bound above initially missed the most heavily used tool. Caught by
  the regression test asserting the advertised JSON Schema, not by reading the
  diff. All tools now share the bounded schemas.
- **`contract_includes_sub_vendors` was typed but not bounded.** The API caps the
  field at 2 characters, so `12345` was still reachable — and an over-long value is
  rejected as HTTP 200 with a plain-text body, the invisible failure documented
  above. Now `.min(0).max(99)`.

### Documentation

- README documents both limits with the date confirmed, replacing "No official
  limit documented; be reasonable," which is how the block happened. Adds the
  Comptroller's public technical forum at
  [groups.google.com/group/checkbooknyc](https://groups.google.com/group/checkbooknyc),
  with a table routing data and API questions there rather than to this tracker.
  Adds badges, a table of contents, and Development and Testing sections.
- New `CONTRIBUTING.md`: where to ask what, respecting the limits, building
  against documentation rather than guesses, and generative-AI disclosure.
  Structure follows
  [uscensusbureau/us-census-bureau-data-api-mcp](https://github.com/uscensusbureau/us-census-bureau-data-api-mcp).

### Notes

- **Coverage gap found while reading the API documentation end to end:** the API
  exposes ten `type_of_data` domains and this server implements seven.
  `Spending_OGE`, `Spending_NYCHA`, and `Payroll_NYCHA` are missing, so NYCHA
  contracts are exposed but neither NYCHA spending nor NYCHA payroll is. Tracked
  in #28, not fixed here.
- Epics: #27 (stop violating the limits) and #28 (complete the domain map, prove
  margin against both ceilings).

### Tests

- New offline suites `test/http-client.test.mjs` and `test/tool-hardening.test.mjs`
  cover: redirect-not-followed (injected fetch plus a real loopback 302 server),
  backoff timing, ordering, `Retry-After`, 4xx-not-retried, and the overall
  deadline (all via a fake clock, no real sleeps); error-never-a-zero-count at both
  the client and tool layers; the genuine-empty regression; User-Agent tracks the
  `package.json` version; and the `smart_search` gate in both states.
- `test/pace.test.mjs` covers the rate pacer: sequential spacing, and the
  concurrent-callers case that motivated it, where without serialization three
  callers resolve at once. The pacer is injected as a no-op into the HTTP-client
  suite (`paceImpl`, alongside the existing `fetchImpl`/`sleepImpl` seams) so
  those tests still need no real sleeps.
- **78 tests pass** on Node 26; CI runs the Node 20.x / 22.x matrix.
- **Live end-to-end check, 2026-07-28:** FY2026 registered expense contracts
  returned 14,397 records with no error in 1,714ms, the elapsed time confirming
  the pacer is engaged on the real path.

## [1.5.0] - UNRELEASED

> **Release gate cleared 2026-07-28.** This section originally said not to tag
> until the new filters were verified against the live API, because they were
> transcribed from the CheckbookNYC open-source config that #17 (v1.3.1) proved
> does not match the live contracts domain. All five have now been verified live
> and the fail-fast gate has been removed — see *Contract filters verified* under
> 1.6.0. One defect was found and fixed in the process.

### Added

- `search_contracts`: five new **UNVERIFIED**, config-sourced filters for the
  citywide contracts domain, each **disabled by default** and gated behind the
  environment variable `CHECKBOOK_ENABLE_UNVERIFIED_CONTRACT_FILTERS=1`. When
  disabled, supplying any of them returns actionable fail-fast guidance instead of
  firing an unverified token at the live API (mirrors how #17 made `vendor_name`
  fail fast):
  - `registration_date_from` / `registration_date_to` — `registration_date` range,
    registered contracts only (#6). Param name appears in #17's live-corroborated
    accepted-param set, but the range filter itself is not yet live-verified.
  - `purpose` — server-side "contains" keyword match (#10). In #17's param set;
    not yet live-verified.
  - `pin` — contract PIN / tracking number (#10). In #17's param set; not yet
    live-verified.
  - `contract_includes_sub_vendors` — 2-char sub-vendor status code, registered
    only (#8). Param name in #17's set; the accepted code enumeration is **not
    published**, so the value is passed through verbatim.
  - `received_date_from` / `received_date_to` — `received_date` range, pending
    contracts only (#10). **Weakest footing:** not in #17's registered-domain set,
    and the pending domain was never live-tested.
- `node:test` coverage (fixture/structure only, zero network) for the new criteria
  builders, status gating (registration_date registered-only, received_date
  pending-only), the fail-fast gate, and a regression guard that
  `DEFAULT_COLUMNS.Contracts` still excludes `year` and `prime_contract_registration_date`.

### Notes

- **Superseded PR #14.** PR #14 built these fields (plus a
  `prime_contract_registration_date` response column) against the pre-#17
  open-source config and now conflicts with main. This release re-authors only the
  surviving request-side filters onto the post-#17 architecture.
- **Deliberately excluded:** the `prime_contract_registration_date` **response
  column** #14 added to `DEFAULT_COLUMNS.Contracts`. It is absent from #17's frozen,
  live-confirmed column set and is the exact class (`year`) the live API rejects — a
  bad response column fails the whole request, so it is not re-introduced.
- README is intentionally untouched (owned by PR #15).

## [1.4.0] - unreleased

### Fixed

- Every tool now **rejects unknown parameters** instead of silently dropping them (#19). zod strips unknown keys by default, so an undeclared parameter vanished with no error and the tool returned **unfiltered** results — real, correctly formatted, correctly sourced data answering a different question, with nothing in the response for a calling model to detect. `search_contracts(vendor="Community League of the Heights")` returned 5,755,099 unrelated contract records. Each tool's `inputSchema` is now a `.strict()` `ZodObject`, so an unknown key raises `Input validation error` before the handler runs.
- `search_contracts` maps the observed guess `vendor` to the declared parameter `vendor_name` and returns `VENDOR_NAME_UNSUPPORTED_MESSAGE` with its three supported alternatives. Previously `vendor_name` (correct) hit that guard while `vendor` (a one-word typo) bypassed it entirely.
- Note on the advertised schema: `tools/list` already emitted `additionalProperties: false` under `@modelcontextprotocol/sdk` 1.29.0 — the advertised contract was honest and the server contradicted it. `.strict()` preserves that output and adds the missing server-side enforcement; a new test pins `additionalProperties: false` so an SDK change cannot drop it silently.

## [1.3.1] - 2026-07-16

### Fixed

- `search_contracts` / `get_contract`: corrected the request-parameter and response-column vocabulary for the citywide Registered Contracts domain (#16). Two mismatches caused every contracts query to fail against the live API:
  - `vendor_name` was mapped to the request parameter `prime_vendor`, which the Registered Contracts domain does not accept as a filter (it is a response column only). The contracts API has **no vendor-name filter and no name→code lookup** — vendors filter only by `vendor_code`. `vendor_name` now fails fast with actionable guidance (use `vendor_code`, or `search_spending`/`smart_search` for name search) instead of returning an opaque error.
  - `year` was requested as a response column, which the domain rejects (its vocabulary is the `prime_contract_*` / `prime_vendor` set). This also broke `get_contract`, which requests the same default column set. `year` has been removed from `DEFAULT_COLUMNS.Contracts`.
- Verified against the live Checkbook NYC API on 2026-07-16: a plain registered/expense query returns records with the corrected columns and no error; `agency_code` and `vendor_code` filters are accepted. OGE/NYCHA contract domains are unaffected (their configs legitimately include a `year` element).

## [1.3.0] - 2026-07-09

### Added

- `search_nycedc_contracts`: new tool routing to the `Contracts_OGE` domain — NYCEDC / Other Government Entities contracts (registered expense only). Filters and response columns transcribed from the CheckbookNYC API config (`contracts_oge.json`) (#7).
- `search_nycha_contracts`: new tool routing to the `Contracts_NYCHA` domain — NYCHA (Housing Authority) contracts at release/line-item granularity (funding source, program/project, responsibility center). Filters and response columns transcribed from the CheckbookNYC API config (`contracts_nycha.json`) (#7).
- Re-added the `Contracts_OGE` and `Contracts_NYCHA` `DataDomain` members (removed as unused in #3) and their documented default response-column sets, now that tools route to them (#7).
- `node:test` coverage for the NYCEDC/NYCHA criteria builders, the entity default columns, and entity `type_of_data` routing.

The two entities use request-criteria names and response columns that differ from citywide Contracts and from each other (verified against `checkbook_api/src/config/contracts_oge.json` and `contracts_nycha.json`, 2026-07-09), so they are implemented as purpose-built tools rather than an overloaded `entity` flag on `search_contracts`.

## [1.2.0] - 2026-07-09

### Added

- `search_contracts`: new `include_sub_vendors` parameter (boolean, default `false`). When set on a registered-contracts search, the response is enriched with the documented sub-vendor / subcontractor columns — `sub_vendor`, `sub_vendor_mwbe_category`, `sub_contract_purpose`, `sub_contract_status`, `sub_contract_current_amount`, `sub_contract_original_amount`, `sub_vendor_paid_to_date`, `sub_contract_registration_date`, `sub_contract_industry`, `sub_woman_owned_business`, `sub_emerging_business` (#8).
- Contracts default response columns: WBE/EBE flags `prime_woman_owned_business` and `prime_emerging_business` (#9).
- Contracts default response columns: lineage/registration fields `mocs_registered`, `contract_class`, `parent_contract_id`, `prime_contract_version` (#10).
- `node:test` coverage for the new column selection (`contractsColumns`), the sub-vendor column set, and the enriched default Contracts columns.

All new fields were confirmed against the documented [Contracts API](https://www.checkbooknyc.com/contract-api) token tables (2026-07-09). The `contract_includes_sub_vendors` filter (#8) and the #10 request filters are intentionally **not** added: their accepted value enumeration / domain applicability could not be confirmed from the docs, so per the project's build-against-docs rule they are deferred rather than guessed. `registration_date` (#6) remains unimplemented pending confirmation of the exact prime-expense column token.

### Changed

- Internal architecture: migrated from the low-level `Server` API to `McpServer.registerTool`, with zod raw shapes as the single source of truth for each tool's input schema (the SDK now generates the `tools/list` JSON Schema). Tool handlers share a `runSearch` / `valueCriteria` / `rangeCriterion` path in the new `src/tools.ts`; `src/index.ts` is now an 11-line entry point. All tool names, descriptions, and the API contract are unchanged from a client's perspective (#3).

## [1.1.0] - 2026-07-06

### Added

- `get_contract`: new `category` parameter (`expense` | `revenue`, default `expense`) (#4).
- `search_payroll`: documented Payroll-domain criteria — `calendar_year`, `pay_frequency`, `pay_date_from`/`pay_date_to`, `amount_min`/`amount_max` (#4).
- `search_revenue`: documented Revenue-domain criteria — `budget_fiscal_year`, `revenue_category`, `revenue_class`, `revenue_source`, `fund_class`, `funding_class` (#4).
- HTTP hardening: 60s timeout, one retry on 5xx/network error, `User-Agent` header (#4).
- `node:test` suite (15 tests) covering request XML construction, domain criteria/columns, numeric coercion, and smart_search response classification against captured fixtures (#4).
- Tag-triggered npm release automation (`.github/workflows/release.yml`) and this changelog (#5).
- Build-only CI workflow gating PRs and pushes to main on `npm ci` + `tsc` across Node 20/22 (#2).

### Fixed

- `search_payroll`: rebuilt against the real Payroll API contract — removed nonexistent `last_name` / `base_salary` criteria (the API has no employee-name search); `fiscal_year` or `calendar_year` is now required, as the API demands (#4).
- `search_budget`: sends the Budget domain's documented `year` criterion instead of the invalid `fiscal_year`; response columns corrected to documented names (#4).
- `search_revenue`: dropped the invalid `budget_code` criterion; response columns corrected (#4).
- `search_spending`: the fiscal_year-or-issue_date_from requirement is now enforced instead of merely suggested (#4).
- XML parsing: numeric tag values are no longer coerced, so `"040"` agency codes keep leading zeros and long IDs keep full precision (#4).

### Changed

- `smart_search`: downgraded to a documented limitation — the checkbooknyc.com `/smart_search` endpoint is Incapsula-WAF-fronted and JS-rendered, so it is generally unusable server-side; the tool now returns a structured unavailability error with fallback guidance and caps `limit` at 100 (#4).
- README: installation section now leads with `npx`; added an explicit API-key subsection (#1).
- `package-lock.json` self-version synced to `package.json`.

## [1.0.1] - 2026-05-22

### Changed

- Added npm keywords for discoverability.

## [1.0.0] - 2026-05-21

### Added

- Initial release: MCP server for NYC Checkbook (Comptroller) data — tools for smart search, contracts, spending, budget, payroll, revenue, and agency spending summaries.
- Comptroller data-accuracy disclaimer appended to all tool responses.
- Acknowledgment of the NYC Comptroller and link to the open-source Checkbook NYC repository.

[Unreleased]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.4.0...HEAD
[1.6.0]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.4.0...HEAD
[1.5.0]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.4.0...HEAD
[1.3.1]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/BetaNYC/nyc-checkbook-mcp/releases/tag/v1.0.0
