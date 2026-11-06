import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The app is a frame for the website (App.tsx). These guard what bundling it needs, which the
// tests that only import its modules never see: a file its entry or its bundler config names that
// is gone fails the build of all three platforms (web, iOS, Android).
const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(app, file), "utf8");

test("every file the app's entry imports exists for the web build and for the phone apps", () => {
  // The bundler picks a file by platform: the web build tries `.web` first, the phone apps
  // `.native`, then both fall back to the plain name.
  const endings = {
    web: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".js"],
    phones: [".native.tsx", ".native.ts", ".native.js", ".tsx", ".ts", ".js"],
  };
  const files = [
    ...read("index.js").matchAll(/^import\s+(?:[^"'\n]+\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/gm),
  ].map((match) => match[1]);
  assert.ok(files.includes("./App"), "the entry imports the app");
  for (const file of files)
    for (const [platform, list] of Object.entries(endings))
      assert.ok(
        list.some((ending) => existsSync(join(app, file + ending))),
        `${file} has no file for ${platform}`,
      );
});

test("every path the bundler config names exists", () => {
  const paths = [
    ...read("metro.config.js").matchAll(/path\.resolve\(__dirname,\s*"([^"]+)"\)/g),
  ].map((match) => match[1]);
  assert.ok(paths.length > 0, "the config names the repository root it watches");
  for (const path of paths) assert.ok(existsSync(join(app, path)), `${path} is gone`);
});

test("the bundler does not follow the type-check path aliases", () => {
  // tsconfig.json points `react` at its type declarations for the type check; a bundler that
  // followed it would bundle a package with no code.
  const { paths } = JSON.parse(read("tsconfig.json")).compilerOptions;
  assert.match(paths.react[0], /@types\/react/);
  assert.equal(JSON.parse(read("app.json")).expo.experiments?.tsconfigPaths, false);
});
