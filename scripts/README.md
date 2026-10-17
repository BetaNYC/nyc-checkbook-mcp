# API surface probing

## What this is for

The Checkbook NYC API tells you its own specification if you ask wrong. Errors `1101` (bad request parameter) and `1106` (bad response column) enumerate the **full valid set** for the resolved domain. Sending one deliberately invalid name per domain per axis therefore returns the real spec.

```bash
bash scripts/probe-api-spec.sh   # writes probe-results.txt, 43 paced requests, ~65s
npm run check:columns            # compares every default column list, per call shape, against it; no network
```

**Build against this output, not against the published documentation.** That distinction is not academic: it is the difference between a working release and a broken one. See *Documentation defects* below, and the `SUB_VENDOR_COLUMNS` comment in `src/tools.ts`.

## Two things to know before trusting the output

**The enumeration is a floor, not a ceiling.** `fiscal_year` on `Registered Contracts(expense) All Years`, and `calendar_year` on `Payroll`, are both **absent from their domain's valid list yet both return `<result>success</result>`.** Passing them appears to resolve a *different* domain rather than error.

So absence from a valid-values list is **not** proof a parameter is rejected. Test it. A test built on "the API listed these, therefore only these" will be wrong in this specific way.

**The column vocabulary depends on the criteria you send.** The same `type_of_data` resolves to different lists with and without `fiscal_year` (issue #40). `Contracts_NYCHA` lists `year` as valid when `fiscal_year` is sent, and rejected it on a `vendor_name`-only search. `Contracts_OGE` lists `apt_pin` without `fiscal_year` (`... All Years`), and rejected it with (`Registered Contracts_oge(expense)`). So a probe only describes the call shape it sent. The tools therefore send a different column list per shape: NYCHA adds `year` only with `fiscal_year`, and OGE adds `apt_pin` only without it (`nychaContractsColumns()` / `nycedcContractsColumns()` in `src/tools.ts`). The script sends one `cols` variant per call shape the tools use, and the checker requires each shape's list to be valid in every variant mapped to that shape. A variant with no criteria omits `<search_criteria>` entirely, exactly as the server does.

**The rate limit is 1 request per second, and it is documented nowhere.** The script paces at 1.5s and aborts on the first non-200. Exceeding the limit does not throttle: it trips an Imperva block at the edge that persists well past the burst and returns 403 to everything on that IP, an ordinary browser included.

Two further cautions, both learned the hard way:

- **Do not re-run to check whether you are blocked.** Every extra request extends the block. Wait, then send a single request.
- **The pacer in `src/checkbook.ts` and the pacing here are both per-process.** Running this script while an MCP client is live can exceed the limit no matter how well either behaves. Run it alone. (Issue #28.)

## Documentation defects in the Comptroller's published docs and config

Each of these is a defect in the published documentation or the published API config (`checkbook_api/src/config/*.json` in [NYCComptroller/Checkbook](https://github.com/NYCComptroller/Checkbook)), not in this server. Recorded here because each one is a trap for anyone building against this API. Item 7 is a trap in the API's own behavior; whether the published docs describe it has not been checked.

1. **`sub_contract_registration_date` is documented as a valid contracts response column** on `/contract-api`. The live API rejects it with `1106`. Because one invalid response column fails the *entire* request, this single token broke `include_sub_vendors` on every call from v1.2.0 through v1.6.0. Fixed in v1.6.1. **The docs overstate the API.**
2. **`payee_name` is documented as NYCEDC-only** on `/spending-api` ("Applicable Filters: Other Government Entities (NYCEDC)"). The live citywide `Spending` domain accepts it, and this server depends on that. **The docs understate the API** — the opposite direction from (1), which is why neither direction can be assumed.
3. **`max_records` is self-contradictory.** The General Information prose says "up to a maximum of 20000 records per call"; the parameter table on the same page says "fewer than 1000" and caps the field at four characters, which cannot express `20000`. Tested: **20,000 works.** This server uses it as the ceiling, with a default page size of 50.
4. **`records_from` vs `record_from`.** The prose uses `records_from`; the parameter table says `record_from`. **`records_from` is what works**, and pagination offsets correctly with it.
5. **`year` is listed unconditionally as a `Contracts_NYCHA` response column** in `contracts_nycha.json`. The live API rejected it with `1106` on a `vendor_name`-only search (2026-10-15), and lists it as valid when `fiscal_year` is sent (probe, 2026-10-16). Because it was in the default list, `search_nycha_contracts` failed on calls without `fiscal_year` from v1.2.0 through v1.6.2; calls with `fiscal_year` were not affected. Fixed in v1.6.3 (#40): `year` is now requested only with `fiscal_year`. **The config overstates the API** for some call shapes.
6. **`apt_pin` is listed unconditionally as a `Contracts_OGE` response column** in `contracts_oge.json`. The live API rejected it with `1106` on a `fiscal_year` search (2026-10-15), and lists it as valid without `fiscal_year` (probe, 2026-10-16). So `search_nycedc_contracts` failed on calls with `fiscal_year` from v1.2.0 through v1.6.2; calls without it were not affected. Fixed in v1.6.3 (#40): `apt_pin` is now requested only without `fiscal_year`.
7. **Registered revenue contracts use a different response vocabulary from registered expense contracts**, under the same `type_of_data` (`Contracts`). `status=registered, category=revenue` resolves `Registered Contracts(revenue)`, whose valid list uses plain names (`contract_id`, `purpose`, `agency`, `prime_mwbe_category`, ...), lists no `sub_*` columns and no `spent_to_date`, and has none of the `prime_contract_*` names that registered/expense and registered/all use (probe, 2026-10-16). The live API rejected `prime_contract_id` with `1106` on `search_contracts({category:"revenue"})` (2026-10-16), so every registered revenue `search_contracts` and `get_contract` call failed. Before v1.6.3 this server sent the registered/expense list for every category. Fixed in v1.6.3 (#42): `contractsColumns()` picks `DEFAULT_COLUMNS.Contracts_revenue` for that shape. Every pending shape (expense, revenue, all) lists the same names as pending/expense, and registered/all lists the registered/expense names, so those shapes keep their lists. `year` is listed for revenue only with `fiscal_year`, and is not requested.

## Checking the default response columns (pre-release)

`scripts/check-default-columns.mjs` reads `probe-results.txt` and checks the column list each call shape sends (every `DEFAULT_COLUMNS` list, plus `SUB_VENDOR_COLUMNS` and the NYCHA/OGE shape-specific columns) against the live valid list of every probe variant mapped to that shape in `COLUMN_CHECKS`. It makes no network requests.

```bash
bash scripts/probe-api-spec.sh   # once, alone (no MCP client running)
npm run check:columns            # exit 0 clean, 1 findings, 2 cannot read input or dist/
```

It exists because a rejected default column has shipped four times, and each time it was patched by hand: `year` on citywide contracts (#16), `sub_contract_registration_date` (v1.6.1), `year`/`apt_pin` on NYCHA/OGE (#40), and the expense list sent for registered revenue contracts (#42).

How to read the result:

- **`UNVERIFIED`** means a default column is absent from a variant's valid list. Per the floor-not-ceiling caveat above, that is **not proof of rejection**, but it fails the check, because shipping an unverified column is how every one of these outages happened. Test it with **one** paced request. If the request fails, remove the column. If it succeeds, record the evidence (date, request shape, result) in `LIVE_VERIFIED_ABSENT` in the script.
- **`MISSING-PROBE`** means the probe output has no section for a variant the checker needs, usually because it predates a new variant. Re-run the probe once. Probe output older than the script's variant list fails; it never passes silently.
- **`UNPARSED-PROBE`** means the probe aborted on that variant (non-200), or the response was not the error form for its section: a `COLUMNS` section must hold the `1106` "response column ... is not allowed" error. A `1101` "request parameter ... is not valid" error there means the variant's criteria were rejected, and its list names criteria, not columns, so it is never compared. Wait out any block before running the probe again; fix the variant's criteria for a `1101`.
- **`UNMAPPED-DOMAIN`** means a `DEFAULT_COLUMNS` key has no `COLUMN_CHECKS` entry. Add one, with a matching `cols` line in the probe script; `test/check-default-columns.test.mjs` enforces that every mapped variant is one the script sends.

**What a pass does not cover.** Every run prints the call shapes no probe sends. Today that includes NYCHA and OGE searches combining `fiscal_year` with other criteria, or omitting it with criteria other than `vendor_name` / `contract_id`, and `get_contract` for pending or registered/expense contracts (its `contract_id` criterion is probed only for registered/revenue). Every `(status, category)` pair of `search_contracts`, with and without `fiscal_year`, is probed since #42.

The parser and comparison logic are tested offline against `test/fixtures/probe-results-sample.txt`, which is real API output with its provenance in its header. That fixture is a snapshot. It shows that the checker works, not that today's columns are valid.

## Citywide contracts have no vendor-name filter

Confirmed, unchanged. The domain rejects `prime_vendor`:

```
1101: Provided request parameter 'prime_vendor' is not valid for
'Registered Contracts(expense) All Years' domain.
```

Vendors are filtered only by `vendor_code`, and **`payee_code` is a valid *request* parameter on Spending but not a valid *response* column** — so there is no API path that yields a vendor code you could then filter contracts by. `VENDOR_NAME_UNSUPPORTED_MESSAGE` is accurate and should stay.

Worth telling users about: the **public web UI** at `/advanced-search` and `/data-feeds` *does* offer a Vendor text field for citywide contracts, plus an Award Method dropdown and an All Years option. **The web front end can express queries the public API cannot.**

## Re-run cadence

Re-run after any Checkbook release, before every release of this server (followed by `npm run check:columns`), and before trusting any claim in this file. The point of the script is that these facts are cheap to regenerate and expensive to assume.
