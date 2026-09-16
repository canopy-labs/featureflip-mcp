# Changelog

## 0.1.6 — 2026-09-16

### Added

- A `Dockerfile`, so the server can actually be built and run from a source checkout. `bin/featureflip-mcp.mjs` imports `../dist/cli.mjs`, and `dist/` is build output that ships in the npm tarball but not in git — with no `prepare` script, `npm install` in a fresh clone never produced it, so launching the binary from the repo failed with `ERR_MODULE_NOT_FOUND` before the stdio transport opened. Anything that inspects the server from source — an MCP registry enumerating the tool surface, a contributor running it locally — got nothing. Installing from npm was unaffected.
- A container smoke check (`npm run smoke:docker`) that starts the built image over stdio with no credentials and asserts all 19 tools are enumerated. Every other test imports `src/` directly, so all of them passed while the shipped artifact had no runnable entry point at all.

## 0.1.5 — 2026-09-16

### Fixed

- The server starts and serves its tool definitions when no `FEATUREFLIP_TOKEN` is set, instead of exiting. Startup used to load the config, preflight `GET /api/v1/me` and resolve the organization *before* opening the stdio transport, so anything that inspected the server without credentials — a registry enumerating the tool surface, an editor probing on first run — got `process.exit(1)` and recorded zero tools. `tools/list` now answers in full and individual tool *calls* return the same `FEATUREFLIP_TOKEN is required` guidance that startup used to print.
- A token that is present but bad still fails fast at startup, unchanged: the 401 and 404 preflight messages are untouched. Only the no-token-at-all path is deferred.

## 0.1.4 — 2026-08-28

### Fixed

- `create_flag`, `restore_flag` and `wrap_feature` declare `destructiveHint: false`, and `update_flag` declares `destructiveHint: true`. All four previously carried an empty `annotations: {}`, which a comment described as "an explicit non-destructive write" — but the MCP specification defaults an absent `destructiveHint` to **true**, so clients were told the opposite: that creating a flag was destructive. `update_flag` genuinely is destructive, because `clientSideVisible` decides whether the browser, React and Swift SDKs can see the flag at all.
- The tool-surface test asserted `'readOnlyHint' in a || 'destructiveHint' in a || Object.keys(a).length === 0`, which is true for every possible object and so caught nothing. It now requires each tool to declare one hint or the other, and pins the three additive writes.

## 0.1.3 — 2026-08-28

### Added

- The server is published to the official MCP Registry as `io.github.canopy-labs/featureflip`. `package.json` carries the `mcpName` ownership marker the registry validates the npm tarball against, and `server.json` describes the package, its stdio transport and its three environment variables. Both versions in `server.json` are patched from the release tag by the publish workflow, which authenticates to the registry with GitHub OIDC.

## 0.1.2 — 2026-08-05

### Fixed

- `LICENSE` is now the verbatim Apache-2.0 text. Three phrases in the operative sections had been reworded and the appendix dropped, which left automated license scanners unable to identify it. The license itself is unchanged; the file now says what it always claimed to.
- The `go` snippet returned by `wrap_feature` installs and imports `github.com/canopy-labs/featureflip-go/v2`, matching the path the module declares. It emitted the unsuffixed path, which Go does not resolve to any v2 release, so an agent following the snippet could not build against the current SDK (#2138).
- The README states the license under its own heading rather than as one bullet in a notes list.

## 0.1.1 — 2026-07-14

### Fixed

- `wrap_feature` sets `clientSideVisible` on flags it creates for the browser, React and Swift SDKs. Without it the new flag was invisible to the very SDK the call had just wrapped a feature for (#1854).

## 0.1.0 — 2026-07-10

- Initial release: 18 MCP tools over the Featureflip public Management API.
