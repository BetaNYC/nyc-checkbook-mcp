# What's changed

This page lists the changes to nyc-checkbook-mcp that a reader would notice: new tools, changes to what the tools return, and corrections when the server gave a wrong answer. Newest first. Dates are New York dates, the day a version reached npm. CHANGELOG.md sometimes gives a different date, the day the change merged or the date in UTC.

- **History begins:** 2026-05-21, the first release. Corrections made before this date may be missing.
- **Data refresh:** None to list. Every answer asks the Checkbook NYC API, run by the NYC Comptroller's office, at the time of the question.

To report a problem with this server or ask for a feature, [open an issue on GitHub](https://github.com/BetaNYC/nyc-checkbook-mcp/issues).

## Unreleased: Two tools that explain the server, and this page

- **Tags:** MCP
- **What changed:** This page is new and lists every change to the server that a reader would notice. Two new tools let your AI assistant answer "what's new in this server?" from this page, and "who built this?" with links to BetaNYC and to the place to report a problem with this server.
- **MCP version:** [nyc-checkbook-mcp 1.7.0](CHANGELOG.md)
- **More detail:** [Release notes](CHANGELOG.md)

## 2026-10-17: Version 1.6.3 fixes searches of NYCHA, NYCEDC and revenue contracts

- **Tags:** MCP
- **What changed:** Searches of NYCHA contracts without a fiscal year, of NYCEDC contracts with one, and of registered revenue contracts failed with an error from the Checkbook NYC API; they work now. When the API reports matching records but sends none back, the server now says so instead of showing an empty list, and it refuses the one search known to do this, registered revenue contracts filtered by fiscal year. CHANGELOG.md dates this release October 16; it reached npm just after midnight on October 17.
- **MCP version:** [nyc-checkbook-mcp 1.6.3](CHANGELOG.md#163---2026-10-16)
- **More detail:** [NYCHA and NYCEDC issue](https://github.com/BetaNYC/nyc-checkbook-mcp/issues/40) · [Revenue contracts issue](https://github.com/BetaNYC/nyc-checkbook-mcp/issues/42) · [The fix](https://github.com/BetaNYC/nyc-checkbook-mcp/pull/41)

## 2026-10-11: The server stopped pointing people to a search that is turned off

- **Tags:** MCP
- **What changed:** Version 1.6.0 turned off smart search, but three messages from the tools still suggested it. Version 1.6.2 points instead to the spending search by payee name, whose results carry contract IDs, and to the contract search and lookup by contract ID.
- **MCP version:** [nyc-checkbook-mcp 1.6.2](CHANGELOG.md#162---2026-10-11)
- **More detail:** [The issue](https://github.com/BetaNYC/nyc-checkbook-mcp/issues/34) · [The fix](https://github.com/BetaNYC/nyc-checkbook-mcp/pull/36)

## 2026-08-01: Asking for subcontractors no longer breaks contract searches

- **Tags:** MCP
- **What changed:** From July 16 to August 1, 2026, a search of registered contracts that asked to include subcontractors failed every time, because it asked the Checkbook NYC API for a column the API rejects. Version 1.6.1 drops that column and adds three that were missing: subcontract start date, end date and reference ID. CHANGELOG.md dates this release July 31; it reached npm just after midnight on August 1.
- **MCP version:** [nyc-checkbook-mcp 1.6.1](CHANGELOG.md#161---2026-07-31)
- **More detail:** [The fix](https://github.com/BetaNYC/nyc-checkbook-mcp/pull/33) · [Subcontractor fields issue](https://github.com/BetaNYC/nyc-checkbook-mcp/issues/8)

## 2026-07-29: Errors from the Checkbook NYC API looked like "no records"

- **Tags:** MCP, Correction
- **What changed:** From May 21 to July 29, 2026, when the Checkbook NYC API refused a request or could not be reached, the tools answered with a count of zero records and put the error in a separate field. On July 21, 2026, spending searches that the API refused came back this way, and an AI assistant reading the count could report that an organization received no City payments. Version 1.6.0 answers with an error instead, so a failed request can no longer be read as "none found."
- **If you used the old numbers:** If an answer from that period said there were no spending, contract, budget, payroll or revenue records for something, check it again with the current version or on checkbooknyc.com. Answers that found records were not affected by this problem.
- **Who it affects:** Anyone who relied on a "none found" answer from this server before July 29, 2026.
- **MCP version:** [nyc-checkbook-mcp 1.6.0](CHANGELOG.md#160---2026-07-29)
- **More detail:** [The issue](https://github.com/BetaNYC/nyc-checkbook-mcp/issues/21) · [The fix](https://github.com/BetaNYC/nyc-checkbook-mcp/pull/30)

## 2026-07-29: Version 1.6.0 stays within the API's limits and turns off smart search

- **Tags:** MCP
- **What changed:** The server now sends at most one request per second and can return up to 20,000 records in one call, the two limits the Comptroller's office confirmed on July 28, 2026; it used to stop at 1,000. Smart search is off unless you turn it on, because the Comptroller's office confirmed it is not part of the supported API. Contract searches gained five filters: purpose, PIN, registration dates, whether a contract has subcontractors, and received dates for pending contracts.
- **MCP version:** [nyc-checkbook-mcp 1.6.0](CHANGELOG.md#160---2026-07-29)
- **More detail:** [The limits](https://github.com/BetaNYC/nyc-checkbook-mcp/pull/29) · [The five filters](https://github.com/BetaNYC/nyc-checkbook-mcp/pull/31) · [Turning off smart search](https://github.com/BetaNYC/nyc-checkbook-mcp/issues/25)

## 2026-07-21: Tools ignored settings they did not have, without saying so

- **Tags:** MCP, Correction
- **What changed:** From May 21 to July 21, 2026, when an AI assistant passed a setting a tool does not have, the tool dropped it without saying so and answered a different question. On July 21, a contract search with "vendor" set to Community League of the Heights returned 5,755,099 unrelated contract records, because the setting is called vendor name. Version 1.4.0, which reached npm on July 21 although CHANGELOG.md calls it unreleased, refuses the call and names the settings the tool does accept.
- **If you used the old numbers:** If an answer from that period looked broader than your question, for example citywide when you asked about one vendor, ask it again with the current version. It now refuses a setting it does not know instead of ignoring it.
- **MCP version:** [nyc-checkbook-mcp 1.4.0](CHANGELOG.md)
- **More detail:** [The issue](https://github.com/BetaNYC/nyc-checkbook-mcp/issues/19) · [The fix](https://github.com/BetaNYC/nyc-checkbook-mcp/pull/20)

## 2026-07-16: NYCHA and NYCEDC contracts, subcontractors, and contract searches that work

- **Tags:** MCP
- **What changed:** From May 21 to July 16, 2026, searches of registered contracts and contract lookups failed, because they asked the Checkbook NYC API for a column it rejects; version 1.3.1 fixes them, and a search by vendor name now explains that the contracts API cannot search by name and suggests other ways. Two new tools search the contracts of NYCHA, the Housing Authority, and of NYCEDC and other government entities, and contract results gained columns such as whether a vendor is a women-owned or emerging business, plus an option to include subcontractors (it did not work until August 1). These changes were written as versions 1.2.0 and 1.3.0, but neither was published on its own; they first reached npm in 1.3.1.
- **MCP version:** [nyc-checkbook-mcp 1.3.1](CHANGELOG.md#131---2026-07-16)
- **More detail:** [The contract search fix](https://github.com/BetaNYC/nyc-checkbook-mcp/pull/17) · [NYCHA and NYCEDC tools](https://github.com/BetaNYC/nyc-checkbook-mcp/pull/13) · [Release notes for 1.2.0](CHANGELOG.md#120---2026-07-09) · [Release notes for 1.3.0](CHANGELOG.md#130---2026-07-09)

## 2026-07-06: Agency codes lost their leading zero

- **Tags:** MCP, Correction
- **What changed:** From May 21 to July 6, 2026, the server turned values that look like numbers into numbers, so an agency code such as "040" came back as 40, and long ID numbers could come back changed. Version 1.1.0 returns every value exactly as Checkbook NYC sends it.
- **If you used the old numbers:** If you copied an agency code or a long ID number from an answer in that period, check it on checkbooknyc.com or ask again with the current version. An agency code shown without its leading zero, such as 40 for 040, is the same agency.
- **MCP version:** [nyc-checkbook-mcp 1.1.0](CHANGELOG.md#110---2026-07-06)
- **More detail:** [The fix](https://github.com/BetaNYC/nyc-checkbook-mcp/pull/4)

## 2026-07-06: Payroll, budget and revenue searches rebuilt to match the API

- **Tags:** MCP
- **What changed:** The payroll, budget and revenue searches sent search terms the Checkbook NYC API does not accept, and payroll and revenue searches failed as a result; version 1.1.0 rebuilds all three from the API's own list of accepted terms. Payroll searches now need a fiscal or calendar year, and there is no search by employee name, because the API has none. Smart search, which the Checkbook NYC website blocks for programs like this one, now says it is unavailable and suggests other tools.
- **MCP version:** [nyc-checkbook-mcp 1.1.0](CHANGELOG.md#110---2026-07-06)
- **More detail:** [The fix](https://github.com/BetaNYC/nyc-checkbook-mcp/pull/4)

## 2026-05-21: First release, with City spending, contracts, budget, payroll and revenue

- **Tags:** MCP
- **What changed:** The first version, published on npm, searched Checkbook NYC, the NYC Comptroller's office's record of City finances: spending, contracts, budget, payroll, revenue and agency spending totals, plus smart search. Every answer carried a note that the data comes from the Comptroller's office and that critical figures should be checked at the source.
- **MCP version:** [nyc-checkbook-mcp 1.0.0](CHANGELOG.md#100---2026-05-21)
- **More detail:** [Release notes](CHANGELOG.md#100---2026-05-21) · [The package on npm](https://www.npmjs.com/package/@betanyc/nyc-checkbook-mcp)
