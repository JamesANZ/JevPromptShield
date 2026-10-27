import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const root = resolve(new URL("..", import.meta.url).pathname);
const temp = await mkdtemp(join(tmpdir(), "jev-shield-package-"));

try {
  const packed = await exec(npm, ["pack", "--json", "--pack-destination", temp], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
  const [manifest] = JSON.parse(packed.stdout);
  assert.ok(manifest);
  const paths = manifest.files.map((file) => file.path);
  assert.ok(paths.includes("dist/src/index.js"));
  assert.ok(paths.includes("dist/src/index.d.ts"));
  assert.ok(paths.includes("dist/src/cli.js"));
  assert.ok(paths.includes("corpus/cases.jsonl"));
  assert.ok(paths.includes("LICENSE"));
  assert.equal(paths.some((path) => path.startsWith("src/")), false);
  assert.equal(paths.some((path) => path.startsWith("test/")), false);
  assert.equal(paths.some((path) => path.startsWith("dist/test/")), false);
  assert.equal(paths.some((path) => path.startsWith(".idea/")), false);

  const installDir = join(temp, "install");
  await exec(npm, ["init", "-y"], { cwd: temp });
  await exec(npm, [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    installDir,
    join(temp, manifest.filename),
  ], { cwd: temp, maxBuffer: 10 * 1024 * 1024 });

  const smoke = join(installDir, "smoke.mjs");
  await writeFile(smoke, `
    import assert from "node:assert/strict";
    import { analyze, decisionFromScores } from "jev-shield";
    const result = await analyze({ content: "ordinary question" }, {
      client: { async decide() { return decisionFromScores({ prompt_injection: 0 }); } },
    });
    assert.equal(result.safe, true);
    console.log("packed import and analysis: ok");
  `);
  const imported = await exec(process.execPath, [smoke], { cwd: installDir });
  assert.match(imported.stdout, /packed import and analysis: ok/);

  const cli = join(installDir, "node_modules", "jev-shield", "dist", "src", "cli.js");
  const corpus = await exec(process.execPath, [cli, "corpus"], { cwd: installDir });
  assert.equal(JSON.parse(corpus.stdout).n, 100);
  const packageJson = JSON.parse(await readFile(join(installDir, "node_modules", "jev-shield", "package.json"), "utf8"));
  assert.equal(packageJson.private, undefined);
  assert.ok((await readdir(join(installDir, "node_modules", "jev-shield"))).includes("README.md"));
  console.log(`package install: ok (${manifest.entryCount} files, ${manifest.size} bytes)`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
