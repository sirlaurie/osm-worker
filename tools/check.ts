import { spawnSync } from "node:child_process";

const mode = process.argv[2] ?? "check";

if (!["check", "format", "lint"].includes(mode)) {
  throw new Error(`Unknown check mode: ${mode}`);
}

const fix = mode === "format";

for (const args of [
  [
    "node_modules/@biomejs/biome/bin/biome",
    fix ? "check" : "ci",
    ...(fix ? ["--write"] : []),
    ".",
  ],
  [
    "node_modules/eslint/bin/eslint.js",
    ".",
    "--max-warnings",
    "0",
    ...(fix ? ["--fix"] : []),
  ],
  ...(mode === "check"
    ? [["node_modules/typescript/bin/tsc", "--noEmit"]]
    : []),
]) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });

  if (result.error) throw result.error;

  if (result.status !== 0) process.exit(result.status ?? 1);
}
