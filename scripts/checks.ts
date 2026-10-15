import { spawnSync } from "node:child_process";

const stages = [
  ["Lint", "lint"],
  ["Formatting", "format:check"],
  ["Type safety", "typecheck"],
  ["Unit and security regression tests", "test"],
  ["Independent verifier package", "test:package"],
];
for (const [label, script] of stages) {
  console.log(`\n▶ ${label}: pnpm ${script}`);
  const result = spawnSync("pnpm", ["run", script], { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  console.log(`✓ ${label}`);
}
console.log(
  "\nAll local checks passed. CI also runs dependency/secret scans, the isolated AT integration and container builds."
);
