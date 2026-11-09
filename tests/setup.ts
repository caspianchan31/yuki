// Unit/API fixtures must never emit production SDK telemetry.
// Telemetry tests exercise enabled behavior in isolated child processes.
process.env.DO_NOT_TRACK = "1";
process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
// v1.6 生成图片: no check of the model gateway at start, so the tests' fake model server sees
// only the chat (tests/image-generation.test.ts drives the check with its own fake gateway).
process.env.IMAGE_GENERATION = "off";
