import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

test("statement spacing fixes preserve declaration groups and survive Biome formatting", async () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const filePath = "worker/spacing-fixture.ts";
  const source = `export function spacingFixture(input: number): number {
  const first = input + 1;
  const second = input + 2;
  if (second < 0) {
    return 0;
  }
  return first + second;
}
`;
  const eslint = new ESLint({ cwd });
  const [before] = await eslint.lintText(source, { filePath });
  assert(before);
  assert(
    before.messages.some(
      (message) =>
        message.ruleId === "@stylistic/padding-line-between-statements" &&
        message.severity === 2,
    ),
  );

  const fixer = new ESLint({ cwd, fix: true });
  const [fixed] = await fixer.lintText(source, { filePath });
  assert(fixed);
  assert.equal(fixed.errorCount, 0);
  assert.equal(fixed.warningCount, 0);
  assert(fixed.output);
  assert.match(
    fixed.output,
    /const first = input \+ 1;\n {2}const second = input \+ 2;/,
  );
  assert.match(fixed.output, /const second = input \+ 2;\n\n {2}if/);

  const formatted = spawnSync(
    process.execPath,
    [
      "node_modules/@biomejs/biome/bin/biome",
      "format",
      "--stdin-file-path",
      filePath,
    ],
    { cwd, input: fixed.output, encoding: "utf8" },
  );
  assert.ifError(formatted.error);
  assert.equal(formatted.status, 0, formatted.stderr);

  const [after] = await eslint.lintText(formatted.stdout, { filePath });
  assert(after);
  assert.equal(after.errorCount, 0, JSON.stringify(after.messages));
  assert.equal(after.warningCount, 0, JSON.stringify(after.messages));
  assert.match(
    formatted.stdout,
    /const first = input \+ 1;\n {2}const second = input \+ 2;/,
  );
});
