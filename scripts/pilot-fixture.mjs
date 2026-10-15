import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import { AuthStore } from "@loftet/auth";

import { PilotRepository } from "../dist/src/pilot/repository.js";
import { createPilotServer } from "../dist/src/pilot/server.js";
import { PilotService } from "../dist/src/pilot/service.js";
// Real SDK PDS + mock PLC on loopback. Only synthetic accounts; no public relays.
import { TestNetworkNoAppView } from "../pilot-fixture/node_modules/@atproto/dev-env/dist/index.js";

const preview = process.argv.includes("--serve");
const port = Number(process.env.PILOT_PREVIEW_PORT ?? 4313);
const directory = preview
  ? resolvePath(`.runtime/pilot-local-${Date.now()}`)
  : mkdtempSync(join(tmpdir(), "pilot-real-pds-"));
mkdirSync(directory, { mode: 0o700, recursive: true });
const network = await TestNetworkNoAppView.create({
  pds: { crawlers: [], handleBackupNameservers: [], hostname: "localhost" },
});
const password = randomBytes(24).toString("base64url");
const accounts = [];
for (const [handle, name] of [
  ["devotta-pilot.test", "Devotta · demo"],
  ["fjord-pilot.test", "Fjord idrettslag · demo"],
  ["emil-pilot.test", "Emil · person"],
  ["nina-pilot.test", "Nina · Devotta-godkjenner"],
  ["maja-pilot.test", "Maja · uten fullmakt"],
  ["kari-pilot.test", "Kari · klubbgodkjenner"],
]) {
  const agent = network.pds.getAgent();
  const { data } = await agent.createAccount({
    email: `${handle}@example.invalid`,
    handle,
    password,
  });
  await agent.com.atproto.repo.putRecord({
    collection: "app.bsky.actor.profile",
    record: { $type: "app.bsky.actor.profile", displayName: name },
    repo: data.did,
    rkey: "self",
  });
  accounts.push({ did: data.did, handle, name });
}
const config = {
  dataDir: directory,
  organisations: [
    {
      approvers: [accounts[3].did],
      description: "Syntetisk Devotta-pilot. Ingen reelle arbeidsforhold.",
      did: accounts[0].did,
      domain: "devotta.test",
      issuerHandle: accounts[0].handle,
      issuerPassword: password,
      name: accounts[0].name,
      scopes: ["*", "team:platform"],
    },
    {
      approvers: [accounts[5].did],
      description:
        "Syntetisk klubb som viser organisasjonsavgrensning. Ingen NIF-integrasjon.",
      did: accounts[1].did,
      domain: "fjord.test",
      issuerHandle: accounts[1].handle,
      issuerPassword: password,
      name: accounts[1].name,
      scopes: ["*", "team:svomming"],
    },
  ],
  origin: `http://127.0.0.1:${port}`,
  pds: network.pds.url,
  people: accounts.slice(2),
  plc: network.plc.url,
  sandbox: true,
};
writeFileSync(join(directory, "config.json"), JSON.stringify(config), {
  mode: 0o600,
});
writeFileSync(
  join(directory, "logins.json"),
  JSON.stringify({
    accounts: accounts.slice(2).map((p) => ({ ...p, password })),
  }),
  { mode: 0o600 }
);
const auth = new AuthStore(join(directory, "auth"));
const repo = new PilotRepository(config, auth);
const service = new PilotService(config, repo);
let server;
for (const method of ["put", "read"]) {
  const original = repo[method].bind(repo);
  repo[method] = async (...args) => {
    try {
      return await original(...args);
    } catch (error) {
      console.error(`Fixture ${method}: ${error.message}`);
      throw error;
    }
  };
}
try {
  await service.init();
  for (const account of accounts.slice(2)) {
    await repo.login(account.handle, password);
  }
  const person = accounts[2].did;
  const admin = accounts[3].did;
  const org = accounts[0].did;
  const terms = {
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    organisationDid: org,
    relationship: "employee",
    roleId: "devotta.developer",
    roleLabel: "Utvikler",
    scope: "*",
    subject: person,
    validFrom: new Date(Date.now() - 1000).toISOString(),
    visibility: "public",
  };
  const p = await service.propose(person, terms);
  assert.equal(p.state, "pending");
  const approved = await service.approve(admin, p.id, 1);
  assert.equal(approved.state, "active", approved.error);
  const verification = await service.verify(approved);
  assert.equal(verification.valid, true, JSON.stringify(verification));
  await assert.rejects(
    service.publishEvent(person, {
      organisationDid: org,
      scope: "*",
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      title: "Før fullmakt",
    }),
    /permission/u
  );
  const g = await service.grant(admin, p.id, 1, {
    action: "events.publish",
    expiresAt: terms.expiresAt,
    scope: "*",
  });
  const event = await service.publishEvent(person, {
    organisationDid: org,
    scope: "*",
    startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    title: "Åpen fagkveld hos Devotta · demo",
  });
  assert.equal(event.state, "published");
  await assert.rejects(
    service.publishEvent(accounts[4].did, {
      organisationDid: org,
      scope: "*",
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      title: "Uten fullmakt",
    }),
    /permission/u
  );
  if (preview) {
    server = createPilotServer(config, service, auth);
    await new Promise((resolve) => {
      server.listen(port, "127.0.0.1", resolve);
    });
    console.log(`Pilot preview: ${config.origin}`);
    console.log(`Private login file: ${join(directory, "logins.json")}`);
    const close = async () => {
      server.close();
      service.close();
      auth.close();
      await network.close();
      process.exit(0);
    };
    process.on("SIGTERM", close);
    process.on("SIGINT", close);
  } else {
    // Tamper with the acceptance in the real subject repository: the old CID must fail.
    const a = approved.acceptance;
    await repo.put(
      person,
      "no.demokratiloftet.affiliation.acceptance",
      `${p.id}-1`,
      { ...a, revision: 99 }
    );
    assert.equal((await service.verify(approved)).valid, false);
    await repo.put(
      person,
      "no.demokratiloftet.affiliation.acceptance",
      `${p.id}-1`,
      a
    );
    assert.equal((await service.verify(approved)).valid, true);
    await service.revokeGrant(admin, g.id);
    assert.equal(await service.permission(person, org, "*"), undefined);
    const invite = await service.propose(admin, {
      ...terms,
      roleId: "devotta.adviser",
      roleLabel: "Rådgiver",
    });
    assert.equal(invite.subjectApproved, false);
    assert.equal((await service.approve(person, invite.id, 1)).state, "active");
    await service.end(person, p.id, 1, "revoked");
    assert.equal((await service.verify(approved)).valid, false);
    console.log(
      "PASS real PDS: both initiation flows, two repository signatures, exact CID acceptance, tamper rejection, scoped event publishing, outsider denial, grant revocation and subject withdrawal."
    );
  }
} finally {
  if (!preview) {
    service.close();
    auth.close();
    await network.close();
    rmSync(directory, { force: true, recursive: true });
  }
}
