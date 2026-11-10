// Unit/API fixtures must never emit production SDK telemetry.
// Telemetry tests exercise enabled behavior in isolated child processes.
process.env.DO_NOT_TRACK = "1";
process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
// v1.6 生成图片: no check of the model gateway at start, so the tests' fake model server sees
// only the chat (tests/image-generation.test.ts drives the check with its own fake gateway).
process.env.IMAGE_GENERATION = "off";
// v1.7.2 身份缓存: off for the suite (many tests end or age a session straight in the database
// and expect the very next request to see it); tests/identity-cache.test.ts turns it on.
process.env.IDENTITY_CACHE_TTL_MS ??= "0";
