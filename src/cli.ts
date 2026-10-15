#!/usr/bin/env node
import { writeFileSync } from "node:fs";

import { message } from "../verify/values.ts";
import { readConfig } from "./config.ts";
import { createService } from "./service.ts";
// Operator commands. Issuance normally happens over HTTP from an application;
// these exist to set a demonstration up and to inspect what the issuer did.
import type { Person } from "./types.ts";

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
};
const required = (name: string): string => {
  const value = flag(name);
  if (!value) {
    throw new Error(`Missing --${name}`);
  }
  return value;
};
function pairs(name: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [index, value] of rest.entries()) {
    if (value !== `--${name}`) {
      continue;
    }
    const [key, ...parts] = (rest[index + 1] ?? "").split("=");
    if (!key || parts.length === 0) {
      throw new Error(`Expected --${name} key=value`);
    }
    result[key] = parts.join("=");
  }
  return result;
}
const USAGE = `attest-issuer <command>

  document                 print the public issuer document
  trust-policy [--out f]   print what a consuming application should trust
  seed                     create the synthetic demo cast in the local roster
  issue --claim-type <id> --subject <did> [--requester-did <did>] [--request k=v]
  revoke --id <id> [--requester-did <did>]
  held --subject <did>
  audit [--limit n]`;
const config = readConfig();
const { issuer, adapter } = await createService(config);
const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));
// The synthetic cast used by the demonstration: a leader, a coach with a
// swimming licence and a police certificate, and a child with neither.
const CAST = {
  leder: {
    clubs: [{ orgId: "fjord", orgName: "Fjord idrettslag", role: "leder" }],
    identity: {
      assuranceLevel: "substantial",
      method: "syntetisk-demo",
      provider: "demo-idp",
    },
  },
  medlem: {
    clubs: [{ orgId: "fjord", orgName: "Fjord idrettslag", role: "medlem" }],
    identity: {
      assuranceLevel: "substantial",
      method: "syntetisk-demo",
      provider: "demo-idp",
    },
  },
  trener: {
    attests: [{ orgId: "fjord" }],
    clubs: [{ orgId: "fjord", orgName: "Fjord idrettslag", role: "trener" }],
    identity: {
      assuranceLevel: "substantial",
      method: "syntetisk-demo",
      provider: "demo-idp",
    },
    licences: [
      { discipline: "svomming", level: "instruktor-2", orgId: "fjord" },
    ],
  },
};

try {
  if (command === "document") {
    out(issuer.document());
  } else if (command === "trust-policy") {
    const policy = issuer.trustPolicy();
    const file = flag("out");
    if (file) {
      writeFileSync(file, `${JSON.stringify(policy, null, 2)}\n`);
      console.log(`Wrote ${flag("out")}`);
    } else {
      out(policy);
    }
  } else if (command === "seed") {
    if (!config.demo) {
      throw new Error(
        "Seeding synthetic people is only available in a demo deployment."
      );
    }
    const people: Record<string, Person> = {};
    for (const [role, facts] of Object.entries(CAST)) {
      people[`did:plc:demo-${role}`] = adapter.enrol(
        `did:plc:demo-${role}`,
        facts
      );
    }
    out({ demo: true, people: Object.keys(people) });
  } else if (command === "issue") {
    out(
      await issuer.issue({
        claimType: required("claim-type"),
        request: pairs("request"),
        requester: {
          client: flag("client"),
          did: flag("requester-did") || flag("subject"),
        },
        subject: required("subject"),
      })
    );
  } else if (command === "revoke") {
    out(
      await issuer.revoke({
        claimType: flag("claim-type"),
        id: flag("id"),
        requester: { client: flag("client"), did: flag("requester-did") },
        subject: flag("subject"),
      })
    );
  } else if (command === "held") {
    out(issuer.held(required("subject")));
  } else if (command === "audit") {
    out(issuer.audit(Number(flag("limit")) || 50));
  } else {
    console.error(USAGE);
    process.exit(2);
  }
} catch (error) {
  console.error(
    `${error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 500}: ${message(error)}`
  );
  process.exit(1);
}
