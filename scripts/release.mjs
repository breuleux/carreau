// Release a version: bump package.json, check (build + tests), commit, tag.
// Publish with `git push --follow-tags` when it looks right.
// Consumers pin the tag: "carreau": "github:breuleux/carreau#v0.1.0".
//
// The tag carries source only: hosts (e.g. buche) compile it through the package's
// "source" export condition — nothing to build at install time, nothing generated in
// git. The build run here is a check (and produces dist/ + types/ locally, for
// bundler-less consumers and for a future publish).

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
  console.error("usage: node scripts/release.mjs <version>   (e.g. 0.1.0)");
  process.exit(1);
}
const prev = JSON.parse(readFileSync("package.json", "utf8")).version;
try {
  run("git diff --quiet && git diff --cached --quiet");
} catch {
  console.error("working tree has unstaged changes: commit or stash them first");
  process.exit(1);
}

run(`npm version ${version} --no-git-tag-version --allow-same-version`); // package.json only; we make the commit ourselves
try {
  run("npm run build");
  run("npm test");
  run("git add package.json package-lock.json");
  run(`git commit -m "Release v${version}"`);
  run(`git tag v${version}`);
} catch {
  run(`npm version ${prev} --no-git-tag-version --allow-same-version`); // put the version back
  console.error("release aborted; version reverted");
  process.exit(1);
}
console.log(`\nv${version} committed and tagged. Publish:  git push --follow-tags`);
