import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

import { loadClaimTypes } from "../src/core/registry.ts";
import { verifyAttestation } from "../verify/index.ts";

const PORT = 3999;
const base = `http://127.0.0.1:${PORT}`;
const claimTypes = loadClaimTypes("claim-types");
const LEADER = "did:plc:serverleader";
const COACH = "did:plc:servercoach";
let child: ChildProcess | undefined;

const call = (
  path: string,
  {
    method = "GET",
    token = "test-client-token-0123456789",
    json,
  }: { method?: string; token?: string | null; json?: unknown } = {}
) =>
  fetch(`${base}${path}`, {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
    },
    method,
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });

before(async () => {
  child = spawn(process.execPath, ["dist/src/server.js"], {
    env: {
      ...process.env,
      ISSUER_CLIENTS_JSON: JSON.stringify([
        {
          id: "calendar",
          scopes: ["issue", "query", "revoke", "admin"],
          token: "test-client-token-0123456789",
        },
        {
          id: "reader",
          scopes: ["query"],
          token: "reader-token-0123456789012345",
        },
        {
          id: "politiet-backend",
          scopes: ["issue"],
          token: "politiet-token-01234567890123",
        },
      ]),
      ISSUER_DATA_DIR: mkdtempSync(join(tmpdir(), "attest-server-")),
      ISSUER_ENV: "local",
      ISSUER_ORIGIN: base,
      PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) {
        return;
      }
    } catch {
      /* still starting */
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error("The issuer did not start");
});
after(() => child?.kill());

void test("the key document and trust policy are public; everything else needs a client", async () => {
  const document = await (
    await call("/.well-known/attestation-issuer.json", { token: null })
  ).json();
  assert.equal(document.keys.length, 1);
  assert.equal(
    document.keys[0].d,
    undefined,
    "the private key must never be served"
  );
  assert.equal(document.demo, true);
  assert.equal(
    (await (await call("/trust-policy.json", { token: null })).json()).trust
      .length,
    1
  );
  assert.equal(
    (await call("/issue", { json: {}, method: "POST", token: null })).status,
    401
  );
  assert.equal(
    (
      await call("/issue", {
        json: {},
        method: "POST",
        token: "wrong-token-000000000000000",
      })
    ).status,
    401
  );
});

void test("a client may only do what its scopes allow", async () => {
  const forbidden = await call("/issue", {
    json: { claimType: "no.nif.identityLinked", subject: COACH },
    method: "POST",
    token: "reader-token-0123456789012345",
  });
  assert.equal(forbidden.status, 403);
  assert.match((await forbidden.json()).error, /issue/u);
});

void test("the full journey over HTTP: enrol, issue, verify from the published policy, query, revoke", async () => {
  for (const [did, facts] of [
    [
      LEADER,
      {
        clubs: [{ orgId: "fjord", orgName: "Fjord idrettslag", role: "leder" }],
        identity: { assuranceLevel: "substantial", provider: "demo-idp" },
      },
    ],
    [
      COACH,
      {
        attests: [{ orgId: "fjord" }],
        clubs: [
          { orgId: "fjord", orgName: "Fjord idrettslag", role: "trener" },
        ],
        identity: { assuranceLevel: "substantial", provider: "demo-idp" },
        licences: [{ discipline: "svomming", level: "instruktor-2" }],
      },
    ],
  ]) {
    assert.equal(
      (
        await call("/demo/enrol", {
          json: { facts, subject: did },
          method: "POST",
        })
      ).status,
      200
    );
  }

  const link = async (did: string) =>
    (
      await (
        await call("/issue", {
          json: {
            claimType: "no.nif.identityLinked",
            requesterDid: did,
            subject: did,
          },
          method: "POST",
        })
      ).json()
    ).record;
  const leaderLink = await link(LEADER);
  const coachLink = await link(COACH);
  const leaderRole = await (
    await call("/issue", {
      json: {
        claimType: "no.nif.clubRole",
        request: { orgId: "fjord" },
        requesterDid: LEADER,
        subject: LEADER,
        subjectAttestations: [leaderLink],
      },
      method: "POST",
    })
  ).json();
  assert.equal(leaderRole.attestation.claim.role, "leder");

  const licence = await (
    await call("/issue", {
      json: {
        claimType: "no.nif.instructorLicence",
        request: { discipline: "svomming" },
        requesterDid: COACH,
        subject: COACH,
        subjectAttestations: [coachLink],
      },
      method: "POST",
    })
  ).json();
  // An application verifies using only what the issuer publishes.
  const trustPolicy = await (
    await call("/trust-policy.json", { token: null })
  ).json();
  const fetchStatus = async (url: string) =>
    (await (await fetch(new URL(url).pathname.replace(/^/u, base))).json()).jws;
  const verdict = await verifyAttestation(licence.record, {
    claimTypes,
    expect: { claim: { discipline: "svomming" }, subject: COACH },
    fetchStatus,
    trustPolicy,
  });
  assert.equal(verdict.valid, true, verdict.reason);

  // The restricted claim names the client that may issue it, so the calendar
  // cannot issue a police certificate however well it authenticates people.
  const wrongClient = await call("/issue", {
    json: {
      claimType: "no.politiet.attest",
      request: { orgId: "fjord" },
      subject: COACH,
      subjectAttestations: [coachLink],
    },
    method: "POST",
  });
  assert.equal(wrongClient.status, 403);
  const issued = await call("/issue", {
    json: {
      claimType: "no.politiet.attest",
      request: { orgId: "fjord" },
      subject: COACH,
      subjectAttestations: [coachLink],
    },
    method: "POST",
    token: "politiet-token-01234567890123",
  });
  assert.equal(issued.status, 201);
  assert.equal(
    (await issued.json()).uri,
    undefined,
    "a restricted claim is never published"
  );
  const asLeader = await call("/query", {
    json: {
      attestations: [leaderRole.record],
      claimType: "no.politiet.attest",
      request: { orgId: "fjord" },
      requesterDid: LEADER,
      subject: COACH,
    },
    method: "POST",
  });
  assert.equal((await asLeader.json()).answer, "valid");

  const asStranger = await call("/query", {
    json: {
      claimType: "no.politiet.attest",
      request: { orgId: "fjord" },
      requesterDid: COACH,
      subject: COACH,
    },
    method: "POST",
  });
  assert.equal(asStranger.status, 403);

  assert.equal(
    (
      await (
        await call("/revoke", {
          json: { id: licence.attestation.id, requesterDid: COACH },
          method: "POST",
        })
      ).json()
    ).revoked,
    true
  );
  const afterRevoke = await verifyAttestation(licence.record, {
    claimTypes,
    fetchStatus,
    trustPolicy,
  });
  assert.equal(afterRevoke.reason, "revoked");

  const audit = await (await call("/audit")).json();
  assert.equal(
    audit.entries.some(
      (e: { action: string; outcome: string }) =>
        e.action === "query" && e.outcome === "denied"
    ),
    true
  );
});

void test("the status of an unknown attestation is answered, not leaked as a 404", async () => {
  const response = await call("/status/does-not-exist", { token: null });
  assert.equal(response.status, 200);
  assert.equal(typeof (await response.json()).jws, "string");
});

void test("refuses rebinding and foreign browser origins even with a valid token", async () => {
  for (const headers of [
    { host: "attacker.invalid" },
    { origin: "https://attacker.invalid" },
  ]) {
    const status = await new Promise((resolve, reject) => {
      const req = request(
        `${base}/audit`,
        {
          headers: {
            authorization: "Bearer test-client-token-0123456789",
            ...headers,
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        }
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  }
});

void test("malformed request objects, evidence and demo facts fail before writes", async () => {
  for (const json of [
    [],
    null,
    { claimType: "no.nif.identityLinked", request: [], subject: COACH },
    {
      attestations: "token",
      claimType: "no.nif.identityLinked",
      subject: COACH,
    },
    {
      claimType: "no.nif.identityLinked",
      subject: COACH,
      subjectAttestations: {},
    },
  ]) {
    assert.equal((await call("/issue", { json, method: "POST" })).status, 400);
  }
  assert.equal(
    (await call("/revoke", { json: {}, method: "POST" })).status,
    400
  );
  assert.equal(
    (
      await call("/demo/enrol", {
        json: { facts: { clubs: "not-an-array" }, subject: COACH },
        method: "POST",
      })
    ).status,
    400
  );
});
