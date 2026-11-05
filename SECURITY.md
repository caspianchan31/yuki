# Security policy

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** form for private reports. Include the affected commit, reproduction steps using fictional data, and the observed impact. Do not open a public issue containing credentials or a working exploit against someone else's deployment. This alpha has no guaranteed response time.

## Deployment boundary

OpenMuse currently supports one owner per deployment. Live mode has one admin account (username and password, scrypt-hashed; sessions are random bearer tokens stored hashed, 30 days); it is not multi-tenant account authentication. The account is created once on the setup page with a one-time code from the API log, so a public deployment cannot be claimed by the first visitor. Sample mode binds to loopback and contains fictional data. Use HTTPS and restricted network access for a remote live deployment.

The API holds provider credentials. Google tokens are encrypted at rest; short-lived signed URLs grant file access. Protect `.env`, `.openmuse` and database backups as private data. A signed URL is a credential until it expires.


This core runs with no computer and no browser worker: members work through chat, connected apps and routines, and no command, desktop or browser session runs on the server.

## External actions

A proposal is bound to the account, reviewed content, and applicable provider version. The server requires a recorded approval before dispatching a send or calendar change. An uncertain network outcome is retained for reconciliation. Cancellation stops later task steps; a provider request already in flight may still finish.

A server-only CopilotKit Intelligence project key is needed for the sample walkthrough. CI uses synthetic keys and mocked Intelligence boundaries. No provider keys, personal data, or third-party logins are needed for CI. CopilotKit Intelligence and any configured model/provider operate under their own terms and data policies. Optional live Jev (`JEV_MODE=live`) sends the user's latest message, agent-written context, and candidate choices to TypeSafe.
