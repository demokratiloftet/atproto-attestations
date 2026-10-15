import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AuthStore } from "@loftet/auth";

import { createPilotServer } from "../src/pilot/server.ts";
import { PilotService } from "../src/pilot/service.ts";
import type {
  PilotConfig,
  Ref,
  Repository,
  Proposal,
} from "../src/pilot/types.ts";
import { ACCEPTANCE, EVENT } from "../src/pilot/types.ts";
import { verifyAttestation } from "../verify/index.ts";
import { parseTrustPolicy } from "../verify/trust-policy.ts";

const makeDid = (letter: string) => `did:plc:${letter.repeat(24)}`;
const alice = makeDid("a");
const reviewer = makeDid("b");
const outsider = makeDid("c");
const otherReviewer = makeDid("d");
const org = makeDid("e");
const otherOrg = makeDid("f");
class MemoryRepo implements Repository {
  records = new Map<string, { record: Record<string, unknown>; cid: string }>();
  failAcceptance = false;
  writes = 0;
  unavailable = false;
  // oxlint-disable-next-line class-methods-use-this -- Implements the Repository interface with a stateless authentication fixture.
  async login(identifier: string, password: string) {
    if (password !== "synthetic-test-password") {
      throw Object.assign(new Error("Invalid login"), { status: 401 });
    }
    return {
      did:
        identifier === "org.test"
          ? org
          : identifier === "other.test"
            ? otherOrg
            : identifier === "alice.test"
              ? alice
              : reviewer,
      handle: identifier,
    };
  }
  async put(
    did: string,
    collection: string,
    key: string,
    record: Record<string, unknown>
  ) {
    const uri = `at://${did}/${collection}/${key}`;
    const cid = createHash("sha256")
      .update(JSON.stringify(record))
      .digest("hex");
    this.records.set(uri, { cid, record: structuredClone(record) });
    this.writes += 1;
    if (this.failAcceptance && collection === ACCEPTANCE) {
      this.failAcceptance = false;
      throw new Error("Response lost after write");
    }
    return { cid, uri };
  }
  async read(ref: Ref) {
    if (this.unavailable) {
      throw new Error("offline");
    }
    const found = this.records.get(ref.uri);
    if (!found || found.cid !== ref.cid) {
      throw new Error("changed");
    }
    return structuredClone(found.record);
  }
  async remove(did: string, collection: string, key: string) {
    this.records.delete(`at://${did}/${collection}/${key}`);
  }
}
async function setup(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "affiliation-test-"));
  const config: PilotConfig = {
    dataDir: directory,
    organisations: [
      {
        approvers: [reviewer],
        description: "Syntetisk",
        did: org,
        domain: "devotta.test",
        issuerHandle: "org.test",
        issuerPassword: "synthetic-test-password",
        name: "Devotta demo",
        scopes: ["*", "team:one"],
      },
      {
        approvers: [otherReviewer],
        description: "Syntetisk",
        did: otherOrg,
        domain: "other.test",
        issuerHandle: "other.test",
        issuerPassword: "synthetic-test-password",
        name: "En annen organisasjon",
        scopes: ["*"],
      },
    ],
    origin: "http://127.0.0.1:3013",
    pds: "http://127.0.0.1:9000",
    people: [
      { did: alice, handle: "alice.test", name: "Person" },
      { did: reviewer, handle: "reviewer.test", name: "Godkjenner" },
      { did: outsider, handle: "outside.test", name: "Utenfor" },
      {
        did: otherReviewer,
        handle: "other-reviewer.test",
        name: "Annen godkjenner",
      },
    ],
    plc: "http://127.0.0.1:9001",
    sandbox: true,
  };
  const repo = new MemoryRepo();
  const service = new PilotService(config, repo);
  await service.init();
  t.after(() => {
    service.close();
    rmSync(directory, { force: true, recursive: true });
  });
  const terms = (subject = alice, organisationDid = org) => ({
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    organisationDid,
    relationship: "employee",
    roleId: "example.developer",
    roleLabel: "Utvikler",
    scope: "*",
    subject,
    validFrom: new Date(Date.now() - 1000).toISOString(),
    visibility: "public",
  });
  const active = async () => {
    const p = await service.propose(alice, terms());
    return service.approve(reviewer, p.id, p.revision);
  };
  const grant = async (p: Proposal) =>
    service.grant(reviewer, p.id, p.revision, {
      action: "events.publish",
      expiresAt: p.terms.expiresAt,
      scope: "*",
    });
  const event = (organisationDid = org, scope = "*") => ({
    organisationDid,
    scope,
    startsAt: new Date(Date.now() + 3_600_000).toISOString(),
    title: "Syntetisk fagkveld",
  });
  return { active, config, directory, event, grant, repo, service, terms };
}
void test("person initiated: exact two approvals publish two records and verify", async (t) => {
  const { service, repo, terms } = await setup(t);
  const p = await service.propose(alice, terms());
  assert.equal(p.state, "pending");
  assert.equal(repo.records.size, 0);
  const a = await service.approve(reviewer, p.id, 1);
  assert.equal(a.state, "active");
  assert.equal(repo.records.size, 2);
  assert.equal((await service.verify(a)).valid, true);
});
void test("organisation initiated requires subject acceptance", async (t) => {
  const { service, repo, terms } = await setup(t);
  const p = await service.propose(reviewer, terms());
  assert.equal(p.subjectApproved, false);
  assert.equal(repo.records.size, 0);
  await assert.rejects(service.approve(outsider, p.id, 1), /access/u);
  const a = await service.approve(alice, p.id, 1);
  assert.equal((await service.verify(a)).valid, true);
});
void test("cannot appoint yourself, approve yourself or act for another organisation", async (t) => {
  const { service, terms } = await setup(t);
  await assert.rejects(service.propose(outsider, terms()), /on behalf/u);
  await assert.rejects(
    service.propose(reviewer, terms(alice, otherOrg)),
    /on behalf/u
  );
  const p = await service.propose(reviewer, terms(reviewer));
  await service.approve(reviewer, p.id, 1);
  assert.equal(service.getProposal(p.id).state, "pending");
  assert.equal(service.getProposal(p.id).organisationApprovedBy, undefined);
});
void test("role change invalidates old acceptance and grants; stale forms refused", async (t) => {
  const { service, active, grant } = await setup(t);
  const p = await active();
  await grant(p);
  const next = await service.change(reviewer, p.id, 1, {
    ...p.terms,
    roleId: "example.adviser",
    roleLabel: "Rådgiver",
  });
  assert.equal(next.revision, 2);
  assert.equal(next.subjectApproved, false);
  assert.equal((await service.verify(p)).valid, false);
  assert.equal(await service.permission(alice, org, "*"), undefined);
  await assert.rejects(service.approve(alice, p.id, 1), /has changed/u);
  assert.equal((await service.approve(alice, p.id, 2)).state, "active");
});
void test("subject and organisation are immutable on edits", async (t) => {
  const { service, terms } = await setup(t);
  const p = await service.propose(alice, terms());
  await assert.rejects(
    service.change(alice, p.id, 1, { ...p.terms, subject: outsider }),
    /cannot be changed/u
  );
});
void test("decline remains private and cannot later be approved", async (t) => {
  const { service, repo, terms } = await setup(t);
  const p = await service.propose(alice, terms());
  await service.end(reviewer, p.id, 1, "declined");
  assert.equal(repo.records.size, 0);
  assert.equal((await service.view()).publicCredentials.length, 0);
  await assert.rejects(
    service.approve(reviewer, p.id, 1),
    /cannot be approved/u
  );
});
void test("unknown publication outcome retries same two keys and survives service restart", async (t) => {
  const s = await setup(t);
  const p = await s.service.propose(alice, s.terms());
  s.repo.failAcceptance = true;
  await s.service.approve(reviewer, p.id, 1);
  assert.equal(s.service.getProposal(p.id).state, "publishing");
  assert.equal(
    (await s.service.verify(s.service.getProposal(p.id))).valid,
    false
  );
  const recovery = new PilotService(s.config, s.repo);
  await recovery.init();
  try {
    const a = await recovery.retry(alice, p.id);
    assert.equal(a.state, "active");
    assert.equal(s.repo.records.size, 2);
    assert.equal((await recovery.verify(a)).valid, true);
  } finally {
    recovery.close();
  }
});
void test("affiliation does not grant publishing; explicit grant is required", async (t) => {
  const { service, active, grant, event, repo } = await setup(t);
  const p = await active();
  await assert.rejects(service.publishEvent(alice, event()), /permission/u);
  await assert.rejects(
    service.grant(alice, p.id, 1, {
      action: "events.publish",
      expiresAt: p.terms.expiresAt,
      scope: "*",
    }),
    /Only/u
  );
  await grant(p);
  const e = await service.publishEvent(alice, event());
  assert.equal(e.state, "published");
  assert.equal(e.ref?.uri.startsWith(`at://${org}/${EVENT}/`), true);
  assert.equal(repo.records.get(e.ref?.uri ?? "")?.record.actor, undefined);
});
void test("copied credential, wrong org and wrong scope never authorise", async (t) => {
  const { service, active, grant, event } = await setup(t);
  await grant(await active());
  await assert.rejects(service.publishEvent(outsider, event()), /permission/u);
  await assert.rejects(
    service.publishEvent(alice, event(otherOrg)),
    /permission/u
  );
  await assert.rejects(
    service.publishEvent(alice, event(org, "team:one")),
    /permission/u
  );
});
void test("grant revocation takes effect on the next action", async (t) => {
  const { service, active, grant, event } = await setup(t);
  const g = await grant(await active());
  await assert.rejects(
    service.revokeGrant(otherReviewer, g.id),
    /do not have permission/u
  );
  await service.revokeGrant(reviewer, g.id);
  await assert.rejects(service.publishEvent(alice, event()), /permission/u);
});
void test("subject withdrawal revokes affiliation and dependent permission", async (t) => {
  const { service, active, grant, event, repo } = await setup(t);
  const p = await active();
  await grant(p);
  await service.end(alice, p.id, 1, "revoked");
  assert.equal(repo.records.size, 0);
  assert.equal((await service.view()).publicCredentials.length, 0);
  assert.equal((await service.verify(p)).valid, false);
  await assert.rejects(service.publishEvent(alice, event()), /permission/u);
});
void test("expiry, missing acceptance, tampering and outage fail closed", async (t) => {
  const { service, active, grant, event, repo } = await setup(t);
  const p = await active();
  await grant(p);
  repo.unavailable = true;
  await assert.rejects(service.publishEvent(alice, event()), /permission/u);
  repo.unavailable = false;
  assert.ok(p.acceptanceRef);
  const entry = repo.records.get(p.acceptanceRef.uri);
  assert.ok(entry);
  entry.record.revision = 2;
  assert.equal((await service.verify(p)).valid, false);
  entry.record.revision = 1;
  repo.records.delete(p.acceptanceRef.uri);
  assert.equal((await service.verify(p)).valid, false);
  p.terms.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal((await service.verify(p)).valid, false);
});
void test("private affiliations and grants stay out of repos and anonymous views", async (t) => {
  const { service, repo, terms, grant, event } = await setup(t);
  const p = await service.propose(alice, { ...terms(), visibility: "private" });
  const a = await service.approve(reviewer, p.id, 1);
  assert.equal(a.state, "active");
  assert.equal(repo.records.size, 0);
  assert.equal((await service.view()).publicCredentials.length, 0);
  assert.equal((await service.view(outsider)).proposals.length, 0);
  await grant(a);
  await service.publishEvent(alice, event());
  assert.equal(repo.records.size, 1);
});
void test("trust binds issuer to signed organisation, not record location", async (t) => {
  const { service, active } = await setup(t);
  const p = await active();
  const policy = structuredClone(service.trust);
  for (const entry of policy.trust) {
    entry.where = { organisationDid: otherOrg };
  }
  const result = await verifyAttestation(p.record, {
    ...service.verificationOptions(),
    trustPolicy: policy,
  });
  assert.equal(result.reason, "untrusted-issuer");
  assert.throws(
    () =>
      parseTrustPolicy({
        trust: [
          {
            claimTypes: ["*"],
            issuer: "https://example.test",
            where: { organisationDid: "$request.org" },
          },
        ],
      }),
    /literal/u
  );
});
void test("unexpected input, unbounded lifetimes and unknown actions are refused", async (t) => {
  const { service, terms, active } = await setup(t);
  await assert.rejects(
    service.propose(alice, { ...terms(), approved: true }),
    /Unknown/u
  );
  await assert.rejects(
    service.propose(alice, {
      ...terms(),
      expiresAt: new Date(Date.now() + 91 * 86_400_000).toISOString(),
    }),
    /90 days/u
  );
  const p = await active();
  await assert.rejects(
    service.grant(reviewer, p.id, 1, {
      action: "admin",
      expiresAt: p.terms.expiresAt,
      scope: "*",
    }),
    /Unknown/u
  );
  await assert.rejects(
    service.grant(reviewer, p.id, 1, {
      action: "events.publish",
      expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      scope: "*",
    }),
    /expire/u
  );
});
void test("revocation is ordered ahead of subsequent queued actions", async (t) => {
  const { service, active, grant, event } = await setup(t);
  const p = await active();
  await grant(p);
  const revoke = service.exclusive(() =>
    service.end(reviewer, p.id, 1, "revoked")
  );
  const publish = service.exclusive(() => service.publishEvent(alice, event()));
  await revoke;
  await assert.rejects(publish, /permission/u);
});
void test("HTTP requires session and exact origin; cookies rotate; private state and login rate are protected", async (t) => {
  const { service, config, directory } = await setup(t);
  const auth = new AuthStore(join(directory, "auth"));
  const server = createPilotServer(config, service, auth);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  config.origin = url;
  // createPilotServer captured its origin; use its expected Host even on the ephemeral port.
  const call = async (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ) =>
    fetch(url + path, {
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        ...(body ? { "content-type": "application/json", origin: url } : {}),
        ...headers,
      },
      method: body ? "POST" : "GET",
    });
  try {
    assert.equal((await call("/api/proposals", {})).status, 401);
    assert.equal(
      (
        await call(
          "/api/login",
          { handle: "alice.test", password: "synthetic-test-password" },
          { origin: "https://evil.test" }
        )
      ).status,
      403
    );
    assert.equal(
      (await call("/api/login", { handle: "alice.test", password: "wrong" }))
        .status,
      401
    );
    const response = await call("/api/login", {
      handle: "alice.test",
      password: "synthetic-test-password",
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie");
    assert.ok(cookie);
    assert.match(cookie, /HttpOnly/u);
    assert.match(cookie, /SameSite=Lax/u);
    const logged = await call("/api/state", undefined, {
      cookie: cookie.split(";")[0],
    });
    assert.equal((await logged.json()).person.did, alice);
    await call("/api/logout", {}, { cookie: cookie.split(";")[0] });
    const after = await call("/api/state", undefined, {
      cookie: cookie.split(";")[0],
    });
    assert.equal((await after.json()).person, null);
    // Two login attempts above plus eighteen refused accounts exhaust this peer's minute window.
    for (let attempt = 0; attempt < 18; attempt += 1) {
      assert.equal(
        (
          await call("/api/login", {
            handle: "unknown.test",
            password: "wrong",
          })
        ).status,
        401
      );
    }
    assert.equal(
      (
        await call("/api/login", {
          handle: "alice.test",
          password: "synthetic-test-password",
        })
      ).status,
      429
    );
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    auth.close();
  }
});
