/**
 * Single source of truth for the package version (issue #22).
 *
 * The McpServer name/version (src/index.ts) and the outbound User-Agent
 * (src/checkbook.ts) both derive the version from HERE, which reads it straight
 * from package.json. Before this, the three had drifted to 1.0.0 / 1.0.1 /
 * 1.5.0 respectively — and the User-Agent is sent on every request, so the drift
 * was externally visible to the Comptroller's office. Deriving all three from one
 * place makes future drift impossible.
 *
 * Why a runtime readFileSync and NOT `import pkg from "../package.json" with
 * { type: "json" }`: JSON import attributes are Node >= 20.6 only, but this
 * package declares `engines.node >= 18` (package.json). Engineering standards §1
 * ("code to the declared range; no syntax/stdlib call that only works at one
 * end") forbids a feature absent at the floor. `readFileSync` + `import.meta.url`
 * works on every Node >= 18. (This machine runs Node 26, where import attributes
 * WOULD compile and pass — exactly the version-drift trap §1 warns about, since it
 * would then break for an 18-declared consumer.)
 *
 * Resolution: `new URL("../package.json", import.meta.url)` resolves relative to
 * the COMPILED module (dist/version.js), i.e. <pkg-root>/package.json. That file
 * is present both in the source tree and in the published npm package — npm always
 * includes package.json regardless of the "files" allowlist. fs.readFileSync has
 * accepted a file: URL since Node 7.6 (Node.js fs docs).
 */

import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version?: unknown };

if (typeof pkg.version !== "string" || pkg.version.length === 0) {
  // Fail loud rather than emit an empty/undefined version into the User-Agent
  // (engineering standards §6: no silent undefined values).
  throw new Error("Could not read a valid 'version' string from package.json");
}

export const VERSION: string = pkg.version;
