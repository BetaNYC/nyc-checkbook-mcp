# Contributing

Thanks for considering a contribution. Before you start, please:

- Read this guide
- Check the [README](README.md) for what the server does and how to run it
- Review the open [issues](https://github.com/BetaNYC/nyc-checkbook-mcp/issues) and [pull requests](https://github.com/BetaNYC/nyc-checkbook-mcp/pulls)
- For anything substantial, open an issue first so we can agree on the approach before you write code

## Where to ask what

This repository covers the MCP server only. Questions about Checkbook NYC itself go upstream to the NYC Comptroller's office, which maintains the platform and runs a public technical forum.

| Topic | Where |
|---|---|
| A tool returns the wrong shape, a schema is wrong, the server crashes | [Our issue tracker](https://github.com/BetaNYC/nyc-checkbook-mcp/issues) |
| Data looks wrong or incomplete, a field is undocumented, the API behaves unexpectedly | [Checkbook NYC forum](https://groups.google.com/group/checkbooknyc), or `checkbooknyc` at `googlegroups.com` |
| The Checkbook platform itself | [github.com/NYCComptroller/Checkbook](https://github.com/NYCComptroller/Checkbook) |

Asking data questions in the open forum rather than in our tracker gets you a better answer and helps everyone else building against the same API.

## Ground rules specific to this project

This server talks to a live public service run by a city agency. A few rules follow from that, and they are not negotiable in review.

**Respect the published limits.** The API allows one request per second and up to 20,000 records per call. The client enforces the rate limit internally through `pace()` in `src/checkbook.ts`. Do not add a code path that bypasses it, and do not follow redirects, because a redirect chain is followed inside a single `fetch()` where pacing cannot reach it. Exceeding the rate limit does not merely throttle you. It places the client into a blocked state at the upstream edge that persists past the burst and affects everyone sharing your network.

**Build against documentation, never against a guess.** Every request parameter, response column, and enum value in this codebase should be traceable to the [Checkbook API documentation](https://www.checkbooknyc.com/data-feeds/api) or to a written answer from the Comptroller's office. Fields that have not been verified against the live API are gated behind an explicit opt-in flag and marked `UNVERIFIED` in `src/tools.ts`. If you add a field you have not verified, mark it the same way. A mock built on a guessed field name passes its tests and is still wrong.

**Do not add undocumented endpoints.** The office has told us which surfaces are supported. Internal endpoints that happen to return data are not fair game, and building on them undercuts the case for keeping the documented API open.

## How to contribute

### Reporting issues

A useful bug report includes the tool you called, the arguments you passed, what you expected, and what came back. If the server returned an error string, paste it verbatim. If you hit an HTTP 403, note roughly how many requests you had made in the preceding minute, because that is usually the answer.

### Feature requests

Say what question you are trying to answer with NYC financial data, not only which parameter you want added. The underlying API has more surface than this server exposes, and knowing the goal helps us pick the right part of it.

### Code contributions

Open a pull request against `main`. Please make sure:

- `npm test` passes, which builds and runs the full suite
- New logic comes with a test. The suite runs against fixtures in `test/fixtures/` and does not touch the network, so tests must not make live API calls
- Behavior changes are reflected in the README, in the same commit
- If you add or change a response column, or add a domain or call shape, update `COLUMN_CHECKS` in `scripts/check-default-columns.mjs` and the matching `cols` probe in `scripts/probe-api-spec.sh`. A column valid for only some call shapes goes in a shape-specific list in `src/tools.ts` (like `NYCHA_FISCAL_YEAR_COLUMNS`), never in the base `DEFAULT_COLUMNS` list. A shape with a different vocabulary altogether gets its own `DEFAULT_COLUMNS` list, selected in `src/tools.ts` (like `Contracts_revenue`, picked by `contractsColumns()` for registered revenue contracts). Either way it gets its own `COLUMN_CHECKS` entry mapped to that shape's probe variants only. Do not copy columns from the published docs or config without checking them: both have listed columns the live API rejects. A maintainer runs the probe and `npm run check:columns` before each release, so you do not need to make live calls yourself
- Commits are scoped to one change

Maintainers will review. For changes touching the request path, `src/checkbook.ts`, expect questions about rate limiting.

### Generative AI

We neither encourage nor prohibit AI coding tools here. This project was itself largely written with [Claude](https://claude.ai), and the README says so.

If you used a generative tool for any part of a contribution, say so in the pull request. Generated code needs more review, not less, particularly in this codebase: the most common failure we have seen is a plausible but invented API field name that passes a mock test and fails against the live service. Verify against the documentation before you submit, rather than leaving that work to a reviewer.

## License

This project is licensed under the [MIT License](LICENSE). By submitting a pull request, you agree that your contribution is licensed under the same terms.
