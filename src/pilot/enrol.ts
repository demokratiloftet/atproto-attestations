/** Operator enrolment is the trust bootstrap; no public route grants organisation authority. */
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { object } from "../../verify/values.ts";
import { parsePilotConfig, readPilotConfig } from "./config.ts";
import type { PilotConfig } from "./types.ts";

export function enrolOrganisation(
  config: PilotConfig,
  input: unknown,
): PilotConfig {
  const row = object(input, "organisation enrolment");
  const people: unknown = row.people ?? [];
  if (!Array.isArray(people)) {
    throw new TypeError("New people must be an array");
  }
  return parsePilotConfig({
    ...config,
    organisations: [...config.organisations, row.organisation],
    people: [
      ...config.people,
      ...people.map((person: unknown) => object(person, "new person")),
    ],
  });
}
export function enrolFile(configFile: string, enrolmentFile: string) {
  const config = readPilotConfig(configFile);
  const input: unknown = JSON.parse(readFileSync(enrolmentFile, "utf-8"));
  const updated = enrolOrganisation(config, input);
  const temporary = `${configFile}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    renameSync(temporary, configFile);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  return updated.organisations.length;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [configFile, enrolmentFile] = process.argv.slice(2);
  if (!configFile || !enrolmentFile) {
    throw new Error("Usage: enrol.ts CONFIG_FILE ENROLMENT_FILE");
  }
  const count = enrolFile(configFile, enrolmentFile);
  console.log(
    `Enrolled organisation; ${count} organisations configured. Restart the app to activate. Credentials were not printed.`,
  );
}
