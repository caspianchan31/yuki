// docker-compose.yml, the open core's way to start Yuki with its computer: two services, a private
// network between them, only the service's port published, a memory limit on each (settable in
// .env), the shared token and the members' files in volumes. The file is read with a small reader
// of the YAML subset it uses (maps, lists, scalars), so no YAML package is needed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
type Yaml = string | Yaml[] | { [key: string]: Yaml };

/** The maps, lists and scalars of docker-compose.yml, by indentation. */
export function readYaml(text: string): { [key: string]: Yaml } {
  const lines = text
    .split("\n")
    .map((raw) => raw.replace(/(^|\s)#.*$/, ""))
    .filter((line) => line.trim() !== "")
    .map((line) => ({ indent: line.length - line.trimStart().length, text: line.trim() }));
  const scalar = (value: string) => value.replace(/^(["'])(.*)\1$/, "$2");
  function block(from: number, indent: number): [Yaml, number] {
    if (lines[from]?.text.startsWith("- ")) {
      const list: Yaml[] = [];
      let at = from;
      while (at < lines.length && lines[at].indent === indent && lines[at].text.startsWith("- ")) {
        list.push(scalar(lines[at].text.slice(2)));
        at++;
        // The rest of a list item that is itself a map (env_file's `required`) is not read.
        while (at < lines.length && lines[at].indent > indent) at++;
      }
      return [list, at];
    }
    const map: { [key: string]: Yaml } = {};
    let at = from;
    while (at < lines.length && lines[at].indent === indent) {
      const match = lines[at].text.match(/^([^:]+):(?:\s+(.*))?$/);
      assert.ok(match, `cannot read: ${lines[at].text}`);
      at++;
      if (match[2] !== undefined && match[2] !== "") {
        map[match[1]] = match[2] === "{}" ? {} : scalar(match[2]);
      } else if (at < lines.length && lines[at].indent > indent) {
        const [child, next] = block(at, lines[at].indent);
        map[match[1]] = child;
        at = next;
      } else map[match[1]] = {};
    }
    return [map, at];
  }
  return block(0, 0)[0] as { [key: string]: Yaml };
}

const compose = readYaml(readFileSync(`${root}docker-compose.yml`, "utf8"));
const services = compose.services as { [key: string]: { [key: string]: Yaml } };
const networks = compose.networks as { [key: string]: { [key: string]: Yaml } };

test("two services: the Yuki service and the members' computer", () => {
  assert.deepEqual(Object.keys(services).sort(), ["computer", "yuki"]);
  assert.equal((services.computer.build as { context: string }).context, "./apps/desktop");
  assert.equal((services.yuki.build as { context: string }).context, ".");
});

test("only the Yuki service publishes a port, on this machine unless told otherwise", () => {
  assert.equal(services.computer.ports, undefined);
  assert.equal(services.computer.expose, undefined);
  const ports = services.yuki.ports as string[];
  assert.equal(ports.length, 1);
  assert.match(ports[0], /^\$\{YUKI_BIND:-127\.0\.0\.1\}:\$\{YUKI_PORT:-8787\}:8787$/);
});

test("each container has a memory limit that .env can change, 1g and 2g by default", () => {
  assert.equal(services.yuki.mem_limit, "${YUKI_MEMORY:-1g}");
  assert.equal(services.computer.mem_limit, "${COMPUTER_MEMORY:-2g}");
});

test("a private network joins them, and only the computer reaches the internet by itself", () => {
  assert.equal(networks.link.internal, "true");
  assert.ok((services.yuki.networks as string[]).includes("link"));
  assert.ok((services.computer.networks as string[]).includes("link"));
  assert.equal(networks.outside.internal, undefined);
  assert.ok((services.computer.networks as string[]).includes("outside"));
  assert.ok(!(services.yuki.networks as string[]).includes("outside"));
  assert.ok(!(services.computer.networks as string[]).includes("edge"));
});

test("the service finds the computer by name and the token by file, and waits for it", () => {
  const environment = services.yuki.environment as { [key: string]: string };
  assert.equal(environment.DESKTOP_URL, "http://computer:7070");
  assert.equal(environment.DESKTOP_TOKEN_FILE, "/computer-secrets/token");
  assert.equal(environment.WORKSPACE_MODE, "live");
  assert.equal(
    ((services.yuki.depends_on as { [key: string]: { [key: string]: string } }).computer ?? {})
      .condition,
    "service_healthy",
  );
});

test("the token is made by the computer, shared by a volume the service reads but never writes", () => {
  const computerVolumes = services.computer.volumes as string[];
  const yukiVolumes = services.yuki.volumes as string[];
  assert.ok(computerVolumes.includes("computer-secrets:/secrets"));
  assert.ok(yukiVolumes.includes("computer-secrets:/computer-secrets:ro"));
  assert.ok(computerVolumes.includes("computer-workspace:/workspace"));
  assert.ok(yukiVolumes.includes("yuki-data:/data"));
  assert.ok(yukiVolumes.includes("yuki-keys:/keys"));
  const volumes = Object.keys(compose.volumes as object).sort();
  assert.deepEqual(volumes, ["computer-secrets", "computer-workspace", "yuki-data", "yuki-keys"]);
  // No file of the host is mounted into either container.
  for (const volume of [...computerVolumes, ...yukiVolumes])
    assert.ok(!/^[./~]/.test(volume), `a host path is mounted: ${volume}`);
});

test("both containers drop every capability and cannot gain new ones", () => {
  for (const service of [services.yuki, services.computer]) {
    assert.deepEqual(service.cap_drop, ["ALL"]);
    assert.deepEqual(service.security_opt, ["no-new-privileges:true"]);
  }
});

test(".env.example lists the settings the compose file reads", () => {
  const example = readFileSync(`${root}.env.example`, "utf8");
  for (const name of [
    "YUKI_PORT",
    "YUKI_PUBLIC_URL",
    "YUKI_BIND",
    "YUKI_MEMORY",
    "COMPUTER_MEMORY",
    "DESKTOP_IDLE_MINUTES",
    "DESKTOP_SIZE",
  ])
    assert.match(example, new RegExp(`^# ${name}=`, "m"), name);
  const used = new Set(
    [...readFileSync(`${root}docker-compose.yml`, "utf8").matchAll(/\$\{([A-Z_]+)[:}-]/g)].map(
      (m) => m[1],
    ),
  );
  for (const name of used)
    if (name !== "TZ") assert.match(example, new RegExp(`^# ${name}=`, "m"), `${name} is read`);
});
