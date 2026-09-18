# Security Policy

## Reporting a vulnerability

Email **security@featureflip.io**. Please don't open a public issue for a security report.

Tell us enough to reproduce it: the version (`npm ls @featureflip/mcp`, or the image tag if you run it through Docker), what you did, what happened, and what you expected instead. Attach a proof of concept if you have one. We'd rather read your reproduction than guess at our own.

We'll reply to acknowledge the report and keep you posted while we work on it. If you'd like credit in the release notes when a fix ships, say so and tell us how you want to be named.

## What belongs here

This repository is the Featureflip MCP server. It's a management surface for feature flags, driven by an API token: it reads and edits flags, targeting rules and rollouts. Flag *evaluation* is not part of it, and happens in your application's own SDK.

Reports about this server, how it handles your token, or what it sends to the Featureflip API belong here.

Anything else goes to the same address: the Featureflip service, the web app, a language SDK. You don't need to work out which repository it belongs to first.

## How your token is handled

`FEATUREFLIP_TOKEN` is read from the environment once at startup and sent as a `Bearer` credential on requests to the API base URL. It isn't written to disk, and it isn't included in log output or error messages. If you find a path where it is, that's a report we want.

`FEATUREFLIP_API_URL` decides where that credential is sent. It defaults to the Featureflip API; point it somewhere else and your token goes there instead, so treat it like any other destination for a secret.

A personal token (`ffp_`) carries your own access. A service token (`ffs_`) is a scoped machine identity, which is the better choice for CI and for agents running unattended. Every mutation either one makes is audit-logged and attributed back to the token.

## More

How the Featureflip service handles data: <https://featureflip.io/product/security/>
