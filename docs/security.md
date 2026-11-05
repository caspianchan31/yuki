# 安全页与备份不含密钥（v0.4）

## Backups hold no secret

The deploy (`workflows/deploy-remote.sh`, `BACKUP=1` or the credential store's first start) and the project move (`workflows/move-projects-remote.sh`) used to copy `.env` whole into their backup. They now write `env.redacted`: only the settings in `ENV_KEEP` keep their values (model, ports, templates, public URLs and the like); every other value, and any kept URL that carries a user and password, is `<redacted>`; comments are dropped. The function lives in `workflows/env-redact.sh` and is inlined in both scripts (they run through `bash -s`); `workflows/env-redact-test.sh` checks it and that the copies match. `workflows/switch-model-gemini.sh` keeps only the three model lines it changes. The database copy in a backup holds the credential store's ciphertext, whose key is in `CREDENTIAL_KEY_FILE` outside it, and the legacy `sandbox.pre-credentials` rows, whose `TOKEN_ENCRYPTION_KEY` is no longer in the backup. Restoring a backup therefore needs the live `.env` and key file, which stay where they are.

Copies made before this (`/srv/app/.env.bak-*`, `env.backup` in `/srv/backups/deploy-*`, a move's `.env`) still hold secrets; the 安全 section lists them. Removing them is the operator's call on the server.

## 安全 (设置 → 所有空间, the platform operator only)

`GET /api/platform/security` (`apps/server/src/security.ts`, `tenancy.assertOperator`): paths and counts, never a value.

- **凭据密钥**: `CREDENTIAL_KEY_FILE` outside `DATA_DIR` (`apart`), inside it (`inside_data`: a data backup would carry the key), or unset (sample mode).
- **明文残留**: records (by kind) and conversations (`chat_runs`) that hold a URL with a user and password in it, and those that hold one of the server's own secret settings verbatim (`TOKEN_ENCRYPTION_KEY`, the model keys, …; values of 12 characters or more, compared in the database, never returned).
- **备份**: every `.env` copy beside the app (`.env.*`, not `.env` or `.env.example`) and in the backup directories (`OPENMUSE_BACKUP_DIRS`, comma-separated, default `/srv/backups`, three levels deep, a backup's `postgres/` skipped), each with how many of its lines hold a secret (a setting outside `envKeep`, the same list as `ENV_KEEP`, or a kept one with credentials in a URL, that is neither empty nor `<redacted>`); one that cannot be read says so.

Client: `packages/client/src/security-core.ts` (read defensively, worded as three blocks), the 安全 section in `PlatformPanel` (`spaces.tsx`) with 重新检查. Tests: `tests/security.test.ts`, `apps/mobile/test/security.test.ts`.
