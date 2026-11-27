import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAttestation } from "../src/core/attestation.ts";
import { generateKeyPair } from "../src/core/sign.ts";

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf-8"));
}
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
    "pnpm",
    [
      "add",
      "--ignore-scripts",
      join(root, "dist/loftet-attestation-verifier-0.1.1.tgz"),
    ],
    { cwd: directory, stdio: "pipe" },
  );
  const signer = await generateKeyPair("consumer-check");
  const issuer = "https://issuer.example/.well-known/attestation-issuer.json";
  const { record } = await createAttestation({
    claim: { assuranceLevel: "low", provider: "demo" },
    claimType: "no.nif.identityLinked",
    issuer,
    lifetimeDays: 1,
    signer,
    subject: "did:plc:consumer",
  });
  writeFileSync(
    join(directory, "fixture.json"),
    JSON.stringify({
      descriptor: readJson(
        join(root, "claim-types/no.nif.identityLinked.json"),
      ),
      policy: {
        requireStatusCheck: false,
        trust: [
          {
            claimTypes: ["no.nif.identityLinked"],
            issuer,
            keys: [signer.publicJwk],
          },
        ],
      },
      record,
    }),
  );
  writeFileSync(
    join(directory, "consumer.ts"),
    `import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyAttestation,verifyPublicAffiliation,parseTrustPolicy,parseDescriptor} from '@loftet/attestation-verifier';
import type {Verification} from '@loftet/attestation-verifier';
assert.equal(typeof verifyPublicAffiliation,'function');
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
  const rawContents: unknown = JSON.parse(
    execFileSync(
      "pnpm",
      ["--dir", "dist/verify", "pack", "--dry-run", "--json"],
      {
        cwd: root,
        encoding: "utf-8",
      },
    ),
  );
  assert.ok(
    rawContents &&
      typeof rawContents === "object" &&
      "files" in rawContents &&
      Array.isArray(rawContents.files),
  );
  const files = rawContents.files.map((file: unknown) => {
    assert.ok(
      file &&
        typeof file === "object" &&
        "path" in file &&
        typeof file.path === "string",
    );
    return { path: file.path };
  });
  assert.ok(
    files.every((file) =>
      /^(package\.json|LICENSE|[a-z-]+\.(js|d\.ts))$/u.test(file.path),
    ),
  );
  assert.ok(!files.some((file) => /^(sign|issuer|keys)\./u.test(file.path)));
  console.log(
    "PASS verifier declarations compile without DOM; package contains no issuer implementation",
  );
} finally {
  rmSync(directory, { force: true, recursive: true });
}
