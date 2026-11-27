import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { object } from "../../verify/values.ts";
import type { Organisation, Person, PilotConfig } from "./types.ts";

function requiredText(row: Record<string, unknown>, field: string) {
  const value = row[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Configuration requires ${field}`);
  }
  return value;
}
function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Configuration requires nonempty ${field}`);
  }
  return value;
}
function accountDid(row: Record<string, unknown>) {
  const did = requiredText(row, "did");
  if (!/^did:plc:[a-z2-7]{24}$/u.test(did)) {
    throw new Error("Invalid enrolled account DID");
  }
  return did;
}
function parsePerson(input: unknown): Person {
  const row = object(input, "person");
  return {
    did: accountDid(row),
    handle: requiredText(row, "handle"),
    name: requiredText(row, "name"),
  };
}
function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) {
    throw new Error(`Duplicate ${label}`);
  }
}
function parseOrganisation(input: unknown, people: Person[]): Organisation {
  const row = object(input, "organisation");
  const scopes = array(row.scopes, "scopes").map((value) => {
    if (typeof value !== "string" || !/^[a-zA-Z0-9.*:-]{1,100}$/u.test(value)) {
      throw new Error("Invalid organisation scope");
    }
    return value;
  });
  const approvers = array(row.approvers, "approvers").map((value) => {
    if (
      typeof value !== "string" ||
      !people.some((person) => person.did === value)
    ) {
      throw new Error("Approver must be an enrolled person");
    }
    return value;
  });
  unique(scopes, "scope");
  unique(approvers, "approver");
  const issuerPassword = requiredText(row, "issuerPassword");
  if (issuerPassword.length < 16) {
    throw new Error("Organisation requires a strong sandbox credential");
  }
  const domain =
    row.domain === undefined ? undefined : requiredText(row, "domain");
  if (
    domain !== undefined &&
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/u.test(domain)
  ) {
    throw new Error("Invalid organisation domain");
  }
  return {
    approvers,
    description: requiredText(row, "description"),
    did: accountDid(row),
    ...(domain === undefined ? {} : { domain }),
    issuerHandle: requiredText(row, "issuerHandle"),
    issuerPassword,
    name: requiredText(row, "name"),
    scopes,
  };
}
function parseOrigin(value: string) {
  const url = new URL(value);
  const loopback =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.origin !== value || !(url.protocol === "https:" || loopback)) {
    throw new Error("HTTPS origin required");
  }
  return value;
}
function sandboxEndpoint(value: string) {
  const url = new URL(value);
  // The Docker network isolates these transports. Canonical PDS URLs are rewritten to this endpoint.
  const allowed = ["127.0.0.1", "localhost", "pilot-bridge", "fixture"];
  if (
    url.protocol !== "http:" ||
    !allowed.includes(url.hostname) ||
    url.origin !== value
  ) {
    throw new Error("Pilot requires an isolated PDS/PLC transport");
  }
  return value;
}
export function parsePilotConfig(input: unknown): PilotConfig {
  const row = object(input, "pilot configuration");
  if (row.sandbox !== true) {
    throw new Error("Explicit sandbox enrolment is required");
  }
  const dataDir = requiredText(row, "dataDir");
  if (!isAbsolute(dataDir)) {
    throw new Error("Data directory must be absolute");
  }
  const people = array(row.people, "people").map(parsePerson);
  const organisations = array(row.organisations, "organisations").map((org) =>
    parseOrganisation(org, people),
  );
  unique(
    [
      ...people.map((person) => person.did),
      ...organisations.map((org) => org.did),
    ],
    "account DID",
  );
  unique(
    [
      ...people.map((person) => person.handle),
      ...organisations.map((org) => org.issuerHandle),
    ],
    "account handle",
  );
  unique(
    organisations.flatMap((org) =>
      org.domain === undefined ? [] : [org.domain],
    ),
    "organisation domain",
  );
  const pdsCanonical =
    row.pdsCanonical === undefined
      ? undefined
      : parseOrigin(requiredText(row, "pdsCanonical"));
  return {
    dataDir,
    organisations,
    origin: parseOrigin(requiredText(row, "origin")),
    pds: sandboxEndpoint(requiredText(row, "pds")),
    ...(pdsCanonical === undefined ? {} : { pdsCanonical }),
    people,
    plc: sandboxEndpoint(requiredText(row, "plc")),
    sandbox: true,
  };
}
export function readPilotConfig(file = process.env.PILOT_CONFIG_FILE) {
  if (!file) {
    throw new Error("PILOT_CONFIG_FILE is required");
  }
  const input: unknown = JSON.parse(readFileSync(file, "utf-8"));
  return parsePilotConfig(input);
}
