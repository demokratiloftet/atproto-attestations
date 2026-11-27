/** Operator-only synthetic examples. Organisation-specific values come from input data. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AuthStore } from "@loftet/auth";

import { object } from "../../verify/values.ts";
import { readPilotConfig } from "./config.ts";
import { text } from "./domain.ts";
import { PilotRepository } from "./repository.ts";
import { PilotService } from "./service.ts";

const config = readPilotConfig();
const secretFile = process.env.AUTH_ENCRYPTION_KEY_FILE;
const secret = secretFile
  ? readFileSync(secretFile, "utf-8").trim()
  : undefined;
const auth = new AuthStore(join(config.dataDir, "auth"), secret);
const repo = new PilotRepository(config, auth);
const service = new PilotService(config, repo);
async function inputData() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const value: unknown = chunk;
    if (!Buffer.isBuffer(value)) {
      throw new TypeError("Expected input bytes");
    }
    chunks.push(value);
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  return object(input, "private seed input");
}
async function seedExample(input: unknown) {
  const example = object(input, "example");
  const person = config.people.find((p) => p.handle === example.subject);
  const org = config.organisations.find(
    (o) => o.issuerHandle === example.organisation,
  );
  const approver = org?.approvers[0];
  if (!person || !org || !approver) {
    throw new Error("Example refers to an unenrolled account");
  }
  const terms = {
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    organisationDid: org.did,
    relationship: text(example, "relationship"),
    roleId: text(example, "roleId"),
    roleLabel: text(example, "roleLabel"),
    scope: text(example, "scope"),
    subject: person.did,
    validFrom: new Date(Date.now() - 1000).toISOString(),
    visibility: "public",
  };
  const existing = service.store
    .proposals()
    .find(
      (p) =>
        p.terms.subject === person.did &&
        p.terms.organisationDid === org.did &&
        p.terms.roleId === terms.roleId,
    );
  let proposal = existing ?? (await service.propose(approver, terms));
  if (example.accepted === true && proposal.state === "pending") {
    proposal = await service.approve(
      person.did,
      proposal.id,
      proposal.revision,
    );
  }
  if (proposal.state === "publishing") {
    proposal = await service.retry(person.did, proposal.id);
  }
  if (example.grant !== true) {
    return;
  }
  if (proposal.state !== "active") {
    throw new Error("Seed could not activate affiliation");
  }
  await service.grant(approver, proposal.id, proposal.revision, {
    action: "events.publish",
    expiresAt: proposal.terms.expiresAt,
    scope: terms.scope,
  });
  if (
    typeof example.eventTitle === "string" &&
    !service.store
      .events()
      .some(
        (e) => e.organisationDid === org.did && e.title === example.eventTitle,
      )
  ) {
    await service.publishEvent(person.did, {
      organisationDid: org.did,
      scope: terms.scope,
      startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      title: example.eventTitle,
    });
  }
}
try {
  const input = await inputData();
  const seedId = text(input, "seedId");
  await service.init();
  if (!service.store.get("seed", seedId)) {
    if (!Array.isArray(input.accounts) || !Array.isArray(input.examples)) {
      throw new TypeError("Private accounts and example plan required");
    }
    for (const account of input.accounts) {
      const row = object(account, "account");
      await repo.login(text(row, "handle"), text(row, "password"));
    }
    for (const example of input.examples) {
      await seedExample(example);
    }
    service.store.put("seed", { id: seedId });
  }
  console.log("Synthetic examples ready; existing workflow data preserved.");
} finally {
  service.close();
  auth.close();
}
