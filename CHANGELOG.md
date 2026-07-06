# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Tag-triggered npm release automation (`.github/workflows/release.yml`) and this changelog.
- Build-only CI workflow gating PRs and pushes to main on `npm ci` + `tsc` across Node 20/22 (#2).

### Fixed

- Pending: API contract fixes to search criteria columns and response parsing (PR #4). Once merged, these changes are unreleased on npm until a new version is tagged — cut a release.

### Changed

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

[Unreleased]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/BetaNYC/nyc-checkbook-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/BetaNYC/nyc-checkbook-mcp/releases/tag/v1.0.0
