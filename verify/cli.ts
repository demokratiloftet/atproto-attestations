#!/usr/bin/env node
// An independent consumer. It reads a record, a trust policy and the claim-type
// descriptors, and decides on its own. It never contacts the issuer except for
// the public status answer, and it holds no credentials.
import type { Descriptor, Expectation, TrustPolicy } from "./types.ts";
import { isObject, message } from "./values.ts";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { verifyAttestation, parseTrustPolicy } from "./index.ts";
import { parseDescriptor } from "./claim-type.ts";

const USAGE = `attest-verify <record.json|-> --trust <trust-policy.json> --claim-types <dir>
    [--expect-subject <did>] [--expect-claim <field>=<value>] [--no-status] [--quiet]

Exit: 0 accepted · 1 refused · 2 usage error`;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const has = (name: string) => args.includes(`--${name}`);
function quit(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

const source =
  args.find(
    (a) =>
      !a.startsWith("--") &&
      args[args.indexOf(a) - 1]?.startsWith("--") !== true,
  ) ?? args[0];
if (!source || has("help")) quit(2, USAGE);

const read = (path: string) =>
  path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
let record: unknown, trustPolicy: TrustPolicy;
const claimTypes: Record<string, Descriptor> = {};
try {
  record = JSON.parse(read(source));
} catch (error) {
  quit(2, `Could not read the record: ${message(error)}`);
}
try {
  trustPolicy = parseTrustPolicy(
    JSON.parse(readFileSync(flag("trust") || "trust-policy.json", "utf8")),
  );
} catch (error) {
  quit(2, `Could not read the trust policy: ${message(error)}\n\n${USAGE}`);
}
const directory = flag("claim-types") || "claim-types";
try {
  for (const file of readdirSync(directory).filter((name) =>
    name.endsWith(".json"),
  )) {
    const descriptor = parseDescriptor(
      JSON.parse(readFileSync(join(directory, file), "utf8")),
    );
    claimTypes[descriptor.id] = descriptor;
  }
} catch (error) {
  quit(2, `Could not read claim types from ${directory}: ${message(error)}`);
}

const expect: Expectation = {};
if (flag("expect-subject")) expect.subject = flag("expect-subject");
if (flag("expect-claim-type")) expect.claimType = flag("expect-claim-type");
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--expect-claim") continue;
  const [field, ...rest] = String(args[i + 1] || "").split("=");
  if (!field || !rest.length) quit(2, "--expect-claim needs <field>=<value>");
  (expect.claim ||= {})[field] = rest.join("=");
}

// The status answer is signed by the issuer, so fetching it over HTTP does not
// place trust in the connection. An unreachable issuer still refuses the claim.
const fetchStatus = async (url: string) => {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  return response.json() as Promise<unknown>;
};

const result = await verifyAttestation(record, {
  trustPolicy: has("no-status")
    ? { ...trustPolicy, requireStatusCheck: false }
    : trustPolicy,
  claimTypes,
  uri:
    isObject(record) && typeof record.uri === "string"
      ? record.uri
      : flag("uri"),
  ...(Object.keys(expect).length ? { expect } : {}),
  fetchStatus,
});

if (has("quiet")) console.log(JSON.stringify(result));
else {
  const { attestation } = result;
  console.log(`${result.valid ? "GODTATT" : "AVVIST"}  ${result.reason}`);
  if (attestation)
    console.log(
      `  ${attestation.claimType}  ${JSON.stringify(attestation.claim)}\n  om ${attestation.subject}\n  fra ${attestation.issuer}\n  gyldig ${attestation.issuedAt} → ${attestation.expiresAt}${attestation.demo ? "\n  DEMO: syntetisk attestasjon" : ""}`,
    );
  for (const check of result.checks)
    console.log(
      `  ${check.ok ? "✓" : "✗"} ${check.name}${check.detail ? `: ${check.detail}` : ""}`,
    );
}
process.exit(result.valid ? 0 : 1);
