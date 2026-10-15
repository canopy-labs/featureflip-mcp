# Changelog

## 0.3.0 — 2026-10-15

### Added

- `update_flag`, `update_targeting` and a `manage_segment` update now return the `etag` of what they wrote, taken from the write's own response. An agent can pass it as `ifMatch` on its next write without reading the resource again. Before this, a second conditional write needed a fresh read first, or it failed with a 412. The ETag is never fetched with a follow-up read, which could pick up someone else's later write. When the API sends no ETag, the field is left out. (#3842)

### Fixed

- A `manage_targeting_rule` update that leaves out `conditionGroups` no longer fails with a `TypeError` when one of the rule's current groups has `conditions: null`. The API contract allows null there. The group is now carried over with an empty list. (#3842)

## 0.2.0 — 2026-10-14

### Added

- `set_default_flag_lifetime` sets or removes a project's default flag lifetime. `preview: true` reports how many flags would newly be, or stop being, past expiry, without changing anything. (#3794)
- `list_sdk_keys` and `manage_sdk_key` (create, rename, revoke). Creating a key returns the full key once, so an agent setting up an SDK can write it into an `.env` file. The list shows only the last four characters.
- `manage_segment` (create, update, delete). `update_targeting` could already reference a segment that nothing in the MCP server could create. A segment created without `conditions` is sent with an empty list, which the API requires.
- `manage_project` and `manage_environment` (create, update). Neither can delete.
- `manage_targeting_rule` adds, updates, removes or reorders one rule without replacing the whole list. A rule added here or through `update_targeting` without `conditionGroups` (segment-only or rollout-only) is sent with an empty list, which the API requires.
- Optimistic concurrency. `get_flag`, `get_targeting` and `get_segment` return an `etag`, and `update_flag`, `update_targeting` and a `manage_segment` update take it back as `ifMatch`. `manage_segment` refuses `ifMatch` on create and delete, which the API can't make conditional, instead of dropping it and writing unconditionally. (#3808) The write then fails with a 412 if the resource changed after the agent read it, instead of overwriting the other change. Tools that read before writing (`update_flag`, `manage_webhook`, `manage_segment`, `manage_environment`, `manage_targeting_rule`) also send the ETag from their own read.

### Changed

- A write carrying If-Match is no longer retried after a 502 or 504. If the first attempt landed, the retry would fail with a 412 and blame someone else for the agent's own change. A 503 is still retried.
- An `ifMatch` passed without its surrounding quotes (`abc` instead of `"abc"`) is quoted before it is sent. Otherwise every conditional write would fail with a 412 that looks like a concurrent change.

## 0.1.13 — 2026-10-13

### Added

- Every tool declares an `outputSchema` and returns `structuredContent` alongside the JSON text. Clients can type-check a result instead of parsing prose. Tools that pass an API response through take their schema from the public API spec, so it matches the API contract. The schema allows extra fields and nulls, so a field the API adds later can't make an older server version fail a call.
- `find_stale_flags` counts a project's default flag lifetime. Each result now carries `effectiveExpiresAtUtc`, the date in effect from the flag or its project's default, and `expirySource` (`explicit`, `project-default`, or `null`). A flag with no date of its own can still be reported as past expiry. Against an API that doesn't report project defaults yet, `effectiveExpiresAtUtc` falls back to the flag's own date. (#3194)

### Changed

- Every tool parameter now has a description. 54 of 113 had only a name and a type, mostly `project`, `flag`, `environment`, `limit` and `cursor`, along with fields like `create_flag`'s `type` and `update_targeting`'s `rules`. Agents now see what each parameter expects.

## 0.1.12 — 2026-10-12

### Added

- Each release now carries `featureflip-mcp-<version>.mcpb`, an MCP Bundle with the server and its dependencies inside. Claude Desktop installs it in one click and asks for the API token in its own settings, so there is no JSON config to write. Needs Node.js 20.19 or later. (#2588)

## 0.1.11 — 2026-10-11

### Added

- `set_flag_permanent` marks a flag permanent, for a kill switch or ops toggle that is meant to stay, or makes it temporary again with `permanent: false`. `create_flag` takes an optional `isPermanent` as well. Permanent flags are left out of `find_stale_flags` and `list_removal_candidates`. Marking is refused with `PERMANENT_FLAG_HAS_EXPIRY` while the flag has an expiry date, so clear the date first; making a flag temporary always works. (#3193, #3671)

### Changed

- `set_flag_expiry` documents its `PERMANENT_FLAG_HAS_EXPIRY` refusal on a permanent flag.
- `@modelcontextprotocol/server` 2.1.0 → 2.3.1.

## 0.1.10 — 2026-10-03

### Added

- `list_removal_candidates` lists the flags the server is confident can be removed from code, the same list the flag cleanup GitHub Action works from. Each item has `key`, `reason`, `status`, `treatment` (which branch to keep) and `blockedBy`. `staleness` is `dead` (the default) or `stale`. (#3458)
- `find_stale_flags` reports `blockedBy` for each flag: the live flags that still list it as a prerequisite and have to be removed and archived first. It is `[]` when nothing depends on the flag, and `null` when the server didn't classify the flag as a removal candidate, which means unknown rather than unblocked. If the lookup fails, the stale report still comes back, with every `blockedBy` set to `null` and a `blockedByNote` saying why. Against an API that predates `blockedBy`, every value is `null`. (#3458)

### Changed

- `find_stale_flags`, `list_removal_candidates` and `archive_flag` tell the agent to remove dependents first. `archive_flag` refuses a flag that another live flag still lists as a prerequisite (`FLAG_HAS_DEPENDENTS`), and the agent now hears that before trying.

## 0.1.9 — 2026-10-01

### Added

- `set_flag_owner` names the person responsible for a flag: an active member's email, or `me` for the token's own user. Pass `null` (or `none`) to leave the flag unowned. `create_flag` takes an optional `ownerEmail` as well. Naming an owner needs the Pro plan or above, and the API refuses it below that with `PLAN_FEATURE_UNAVAILABLE`; clearing works on every plan.
- `find_stale_flags` reports each flag's owner (`{id, email, name}`, or `null` when unowned), and both `find_stale_flags` and `list_flags` take an `owner` filter: an email, `none` for unowned flags, or `me` for the token's own user. `me` needs a personal access token (`ffp_...`), because a service token has no user and so owns no flags; the tool refuses it rather than dropping the filter and listing every flag. (#3189)

### Changed

- `@modelcontextprotocol/server` 2.0.0 → 2.1.0.

### Fixed

- `set_flag_expiry` and `create_flag` treat a bare date (`2026-12-01`) as the end of that day in UTC, the same as the dashboard. It used to mean midnight, so a flag dated through the MCP server expired a day earlier than one given the same date in the dashboard, and today's date was refused. A full timestamp is still stored exactly. The change is in the API, so it applies to every server version; this release updates the tool descriptions to match. (#3345)
- `update_flag` changes only the fields you pass. Before, leaving out `name` failed with a 400 ("The Name field is required"), and leaving out `description` erased the flag's description, because the API's `PUT` replaces the whole flag. When either one is missing, the tool now reads the flag first and sends its current value back. Pass `description: ""` to clear it. (#3220)

## 0.1.8 — 2026-09-24

### Added

- Four tools for outbound webhook subscriptions. (#3181)
  - `list_webhooks` lists subscriptions, plus `availableEventTypes`: the event types a subscription can filter on.
  - `list_webhook_deliveries` pages one subscription's delivery log.
  - `manage_webhook` creates, updates and deletes subscriptions, and rotates or retires signing secrets. `create` and `rotate_secret` return a secret that is shown only once. `update` changes only the fields you pass: the API's `PUT` replaces the whole subscription, so the tool reads it first and sends back everything else unchanged. An empty list widens that filter back to "all".
  - `deliver_webhook` queues a test event or redelivers a finished delivery.
- Webhook filters take project keys and `project/environment` keys (`web/production`), or ids. Environment keys need their project because every project tends to have a `production`.
- Every webhook action needs an Admin token, reads included. While webhooks aren't enabled for the organization, every webhook call returns 404.
- `set_flag_expiry` sets the date a flag is expected to be removed by, or clears it with `expiresAtUtc: null`. Expiry is advisory: evaluation never changes. The Management API refuses a time that has already passed (`EXPIRY_IN_PAST`) and refuses any new date while flag expiration isn't enabled for the organization (`FEATURE_NOT_ENABLED`). Clearing is always allowed. (#2563)
- `create_flag` takes an optional `expiresAtUtc`.

### Changed

- Requests that fail on a transient gateway error (502, 503, 504) or a dropped connection are retried, up to 3 attempts. That covers what a rolling deploy of the Management API produces. Reads and other requests that are safe to replay retry all of these. A `POST` without an idempotency key retries only a 503, because after a 502 or 504 it may already have been applied, and replaying it would report a spurious conflict. (#3147)
- The npm package now carries `keywords`, so it can be found by searching npm for "mcp" or "feature flags". (#3151)
- `find_stale_flags` reports each flag's `expiresAtUtc` and an `expired` boolean. A flag whose expiry has passed is a candidate however recently it was edited, since the date is its owner's stated intent. An expired flag that is on in some environments and off in others used to be skipped. It is now reported with the new reason `past-expiry`, because it has no obvious fold direction and its owner has to decide. Expired flags are checked before the 50-candidate cap applies, so truncation can't hide them. Against an API that doesn't return `expiresAtUtc`, results are the same as before.

## 0.1.7 — 2026-09-18

### Added

- `archive_flag` takes an optional `force`. The Management API now refuses to archive a flag that live traffic is still evaluating, and the reason is worth stating plainly: archiving stops the flag being served, so every caller falls back to its own hardcoded default. Archiving on the day a removal PR merges — but before that build reaches production — therefore changes behaviour for real users, which is the opposite of what the removal intended. The refusal clears itself once the deploy lands, so waiting is the right default rather than a limitation. `force: true` overrides it, for the one case that never drains on its own: clients that can never be updated, such as an old mobile app version still in the wild. (#3043)

- The `archive_flag` description names the `FLAG_RECENTLY_EVALUATED` refusal and what it means, so an agent that hits it can tell a guardrail from a failure without going to the API reference.

### Changed

- The `Dockerfile`'s build and runtime stages move from `node:22-alpine` to `node:24-alpine`, Node's Active LTS line.

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
