import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { generateKeyPair } from "../src/core/sign.ts";
import { createAttestation } from "../src/core/attestation.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "independent-verifier-"));
try {
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "verifier-consumer",
      private: true,
      type: "module",
    }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      join(root, "dist/loftet-attestation-verifier-0.1.0.tgz"),
    ],
    { cwd: directory, stdio: "pipe" },
  );
  const signer = await generateKeyPair("consumer-check");
  const issuer = "https://issuer.example/.well-known/attestation-issuer.json";
  const { record } = await createAttestation({
    signer,
    issuer,
    subject: "did:plc:consumer",
    claimType: "no.nif.identityLinked",
    claim: { assuranceLevel: "low", provider: "demo" },
    lifetimeDays: 1,
  });
  writeFileSync(
    join(directory, "fixture.json"),
    JSON.stringify({
      record,
      descriptor: JSON.parse(
        readFileSync(
          join(root, "claim-types/no.nif.identityLinked.json"),
          "utf8",
        ),
      ),
      policy: {
        trust: [
          {
            issuer,
            claimTypes: ["no.nif.identityLinked"],
            keys: [signer.publicJwk],
          },
        ],
        requireStatusCheck: false,
      },
    }),
  );
  writeFileSync(
    join(directory, "consumer.ts"),
    `import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyAttestation,parseTrustPolicy,parseDescriptor} from '@loftet/attestation-verifier';
import type {Verification} from '@loftet/attestation-verifier';
const data = JSON.parse(readFileSync('fixture.json','utf8'));
const trustPolicy = parseTrustPolicy(data.policy);
const descriptor = parseDescriptor(data.descriptor);
const claimTypes = {[descriptor.id]:descriptor};
const result: Verification = await verifyAttestation(data.record,{trustPolicy,claimTypes});
assert(result.valid,result.reason);
assert.equal(result.attestation.subject,'did:plc:consumer');
assert.equal((await verifyAttestation('invalid',{trustPolicy,claimTypes})).valid,false);
console.log('PASS standalone package verifies a real signature and refuses invalid input');
`,
  );
  execFileSync(
    join(root, "node_modules/.bin/tsc"),
    [
      "--strict",
      "--module",
      "nodenext",
      "--target",
      "es2023",
      "--lib",
      "es2023",
      "--typeRoots",
      join(root, "node_modules/@types"),
      "--types",
      "node",
      "consumer.ts",
    ],
    { cwd: directory, stdio: "inherit" },
  );
  execFileSync(process.execPath, ["consumer.js"], {
    cwd: directory,
    stdio: "inherit",
  });
  const contents: { files: { path: string }[] }[] = JSON.parse(
    execFileSync("npm", ["pack", "./dist/verify", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  assert(
    contents[0].files.every((file) =>
      /^(package\.json|[a-z-]+\.(js|d\.ts))$/.test(file.path),
    ),
  );
  assert(
    !contents[0].files.some((file) => /^(sign|issuer|keys)\./.test(file.path)),
  );
  console.log(
    "PASS verifier declarations compile without DOM; package contains no issuer implementation",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
