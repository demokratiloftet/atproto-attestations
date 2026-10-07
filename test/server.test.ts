import type { ChildProcess } from "node:child_process";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAttestation } from "../verify/index.ts";
import { loadClaimTypes } from "../src/core/registry.ts";

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
  }: { method?: string; token?: string | null; json?: unknown } = {},
) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });

before(async () => {
  child = spawn(process.execPath, ["dist/src/server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ISSUER_ENV: "local",
      ISSUER_ORIGIN: base,
      ISSUER_DATA_DIR: mkdtempSync(join(tmpdir(), "attest-server-")),
      ISSUER_CLIENTS_JSON: JSON.stringify([
        {
          id: "calendar",
          token: "test-client-token-0123456789",
          scopes: ["issue", "query", "revoke", "admin"],
        },
        {
          id: "reader",
          token: "reader-token-0123456789012345",
          scopes: ["query"],
        },
        {
          id: "politiet-backend",
          token: "politiet-token-01234567890123",
          scopes: ["issue"],
        },
      ]),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      /* still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The issuer did not start");
});
after(() => child?.kill());

test("the key document and trust policy are public; everything else needs a client", async () => {
  const document = await (
    await call("/.well-known/attestation-issuer.json", { token: null })
  ).json();
  assert.equal(document.keys.length, 1);
  assert.equal(
    document.keys[0].d,
    undefined,
    "the private key must never be served",
  );
  assert.equal(document.demo, true);
  assert.equal(
    (await (await call("/trust-policy.json", { token: null })).json()).trust
      .length,
    1,
  );
  assert.equal(
    (await call("/issue", { method: "POST", token: null, json: {} })).status,
    401,
  );
  assert.equal(
    (
      await call("/issue", {
        method: "POST",
        token: "wrong-token-000000000000000",
        json: {},
      })
    ).status,
    401,
  );
});

test("a client may only do what its scopes allow", async () => {
  const forbidden = await call("/issue", {
    method: "POST",
    token: "reader-token-0123456789012345",
    json: { claimType: "no.nif.identityLinked", subject: COACH },
  });
  assert.equal(forbidden.status, 403);
  assert.match((await forbidden.json()).error, /issue/);
});

test("the full journey over HTTP: enrol, issue, verify from the published policy, query, revoke", async () => {
  for (const [did, facts] of [
    [
      LEADER,
      {
        identity: { assuranceLevel: "substantial", provider: "demo-idp" },
        clubs: [{ orgId: "fjord", orgName: "Fjord idrettslag", role: "leder" }],
      },
    ],
    [
      COACH,
      {
        identity: { assuranceLevel: "substantial", provider: "demo-idp" },
        clubs: [
          { orgId: "fjord", orgName: "Fjord idrettslag", role: "trener" },
        ],
        licences: [{ discipline: "svomming", level: "instruktor-2" }],
        attests: [{ orgId: "fjord" }],
      },
    ],
  ])
    assert.equal(
      (
        await call("/demo/enrol", {
          method: "POST",
          json: { subject: did, facts },
        })
      ).status,
      200,
    );

  const link = async (did: string) =>
    (
      await (
        await call("/issue", {
          method: "POST",
          json: {
            claimType: "no.nif.identityLinked",
            subject: did,
            requesterDid: did,
          },
        })
      ).json()
    ).record;
  const leaderLink = await link(LEADER);
  const coachLink = await link(COACH);

  const leaderRole = await (
    await call("/issue", {
      method: "POST",
      json: {
        claimType: "no.nif.clubRole",
        subject: LEADER,
        requesterDid: LEADER,
        request: { orgId: "fjord" },
        subjectAttestations: [leaderLink],
      },
    })
  ).json();
  assert.equal(leaderRole.attestation.claim.role, "leder");

  const licence = await (
    await call("/issue", {
      method: "POST",
      json: {
        claimType: "no.nif.instructorLicence",
        subject: COACH,
        requesterDid: COACH,
        request: { discipline: "svomming" },
        subjectAttestations: [coachLink],
      },
    })
  ).json();

  // An application verifies using only what the issuer publishes.
  const trustPolicy = await (
    await call("/trust-policy.json", { token: null })
  ).json();
  const fetchStatus = async (url: string) =>
    (await (await fetch(new URL(url).pathname.replace(/^/, base))).json()).jws;
  const verdict = await verifyAttestation(licence.record, {
    trustPolicy,
    claimTypes,
    fetchStatus,
    expect: { subject: COACH, claim: { discipline: "svomming" } },
  });
  assert.equal(verdict.valid, true, verdict.reason);

  // The restricted claim names the client that may issue it, so the calendar
  // cannot issue a police certificate however well it authenticates people.
  const wrongClient = await call("/issue", {
    method: "POST",
    json: {
      claimType: "no.politiet.attest",
      subject: COACH,
      request: { orgId: "fjord" },
      subjectAttestations: [coachLink],
    },
  });
  assert.equal(wrongClient.status, 403);
  const issued = await call("/issue", {
    method: "POST",
    token: "politiet-token-01234567890123",
    json: {
      claimType: "no.politiet.attest",
      subject: COACH,
      request: { orgId: "fjord" },
      subjectAttestations: [coachLink],
    },
  });
  assert.equal(issued.status, 201);
  assert.equal(
    (await issued.json()).uri,
    undefined,
    "a restricted claim is never published",
  );
  const asLeader = await call("/query", {
    method: "POST",
    json: {
      claimType: "no.politiet.attest",
      subject: COACH,
      request: { orgId: "fjord" },
      requesterDid: LEADER,
      attestations: [leaderRole.record],
    },
  });
  assert.equal((await asLeader.json()).answer, "valid");

  const asStranger = await call("/query", {
    method: "POST",
    json: {
      claimType: "no.politiet.attest",
      subject: COACH,
      request: { orgId: "fjord" },
      requesterDid: COACH,
    },
  });
  assert.equal(asStranger.status, 403);

  assert.equal(
    (
      await (
        await call("/revoke", {
          method: "POST",
          json: { id: licence.attestation.id, requesterDid: COACH },
        })
      ).json()
    ).revoked,
    true,
  );
  const after = await verifyAttestation(licence.record, {
    trustPolicy,
    claimTypes,
    fetchStatus,
  });
  assert.equal(after.reason, "revoked");

  const audit = await (await call("/audit")).json();
  assert.equal(
    audit.entries.some(
      (e: { action: string; outcome: string }) =>
        e.action === "query" && e.outcome === "denied",
    ),
    true,
  );
});

test("the status of an unknown attestation is answered, not leaked as a 404", async () => {
  const response = await call("/status/does-not-exist", { token: null });
  assert.equal(response.status, 200);
  assert.equal(typeof (await response.json()).jws, "string");
});

test("refuses rebinding and foreign browser origins even with a valid token", async () => {
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
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  }
});

test("malformed request objects, evidence and demo facts fail before writes", async () => {
  for (const json of [
    [],
    null,
    { claimType: "no.nif.identityLinked", subject: COACH, request: [] },
    {
      claimType: "no.nif.identityLinked",
      subject: COACH,
      attestations: "token",
    },
    {
      claimType: "no.nif.identityLinked",
      subject: COACH,
      subjectAttestations: {},
    },
  ]) {
    assert.equal((await call("/issue", { method: "POST", json })).status, 400);
  }
  assert.equal(
    (await call("/revoke", { method: "POST", json: {} })).status,
    400,
  );
  assert.equal(
    (
      await call("/demo/enrol", {
        method: "POST",
        json: { subject: COACH, facts: { clubs: "not-an-array" } },
      })
    ).status,
    400,
  );
});
