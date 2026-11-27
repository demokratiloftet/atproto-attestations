import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDemoAdapter } from "../src/adapters/demo-nif.ts";
import { createIssuer } from "../src/core/issuer.ts";
import { loadClaimTypes } from "../src/core/registry.ts";
import { generateKeyPair } from "../src/core/sign.ts";
import { IssuerStore } from "../src/core/store.ts";
import type { Requester } from "../src/types.ts";
import { verifyAttestation } from "../verify/index.ts";
import type { AttestationRecord, Claim } from "../verify/types.ts";

const CHILD = "did:plc:child";
const COACH = "did:plc:coach";
const ISSUER =
  "https://demo-utsteder.example/.well-known/attestation-issuer.json";
const LEADER = "did:plc:leader";
const claimTypes = loadClaimTypes("claim-types");

function memoryPublisher() {
  const records = new Map<string, AttestationRecord>();
  let n = 0;
  return {
    async describe() {
      return {};
    },
    id: "memory",
    async publish(record: AttestationRecord) {
      n += 1;
      const uri = `at://did:plc:issuer/no.demokratiloftet.attestation/${n}`;
      records.set(uri, record);
      return { cid: `cid-${n}`, uri };
    },
    records,
    async remove(uri: string) {
      records.delete(uri);
      return {};
    },
  };
}

async function setup({ now = () => Date.parse("2026-09-17T12:00:00Z") } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "attest-"));
  const signer = await generateKeyPair("key-1");
  const store = new IssuerStore(dir);
  const publisher = memoryPublisher();
  const adapter = createDemoAdapter({ file: join(dir, "roster.json") });
  const issuer = createIssuer({
    adapter,
    claimTypes,
    demo: true,
    issuer: ISSUER,
    name: "Demo-utsteder",
    now,
    publisher,
    signer,
    store,
  });

  adapter.enrol(LEADER, {
    clubs: [{ orgId: "fjord", orgName: "Fjord idrettslag", role: "leder" }],
    identity: { assuranceLevel: "substantial", provider: "demo-idp" },
  });
  adapter.enrol(COACH, {
    attests: [{ orgId: "fjord" }],
    clubs: [{ orgId: "fjord", orgName: "Fjord idrettslag", role: "trener" }],
    identity: { assuranceLevel: "substantial", provider: "demo-idp" },
    licences: [{ discipline: "svomming", level: "instruktor-2" }],
  });
  adapter.enrol(CHILD, {
    clubs: [{ orgId: "fjord", orgName: "Fjord idrettslag", role: "medlem" }],
    identity: { assuranceLevel: "substantial", provider: "demo-idp" },
  });

  const linked = async (subject: string) =>
    (
      await issuer.issue({
        claimType: "no.nif.identityLinked",
        request: {},
        requester: { did: subject },
        subject,
      })
    ).record;
  return { adapter, dir, issuer, linked, now, publisher, signer, store };
}

void test("a person links their account, then receives a licence that verifies independently", async () => {
  const { issuer, linked, now } = await setup();
  const evidence = [await linked(COACH)];
  const result = await issuer.issue({
    claimType: "no.nif.instructorLicence",
    request: { discipline: "svomming" },
    requester: { did: COACH },
    subject: COACH,
    subjectAttestations: evidence,
  });

  assert.equal(result.attestation.claim.level, "instruktor-2");
  assert.equal(typeof result.uri, "string", "a public claim is published");

  // Verified the way any unrelated application would, with no access to the issuer.
  const verdict = await verifyAttestation(result.record, {
    claimTypes,
    expect: {
      claim: { discipline: "svomming" },
      claimType: "no.nif.instructorLicence",
      subject: COACH,
    },
    now: now(),
    trustPolicy: { ...issuer.trustPolicy(), requireStatusCheck: false },
  });
  assert.equal(verdict.valid, true, verdict.reason);
});

void test("without the required identity assurance, nothing is issued", async () => {
  const { issuer } = await setup();
  await assert.rejects(
    () =>
      issuer.issue({
        claimType: "no.nif.clubRole",
        request: { orgId: "fjord" },
        requester: { did: COACH },
        subject: COACH,
      }),
    (error) =>
      error instanceof Error &&
      "status" in error &&
      error.status === 403 &&
      /identitet|assurance|kobling/iu.test(error.message),
  );
});

void test("a club leader may issue a role for someone in their own club, and only there", async () => {
  const { issuer, linked } = await setup();
  const leaderRole = (
    await issuer.issue({
      claimType: "no.nif.clubRole",
      request: { orgId: "fjord" },
      requester: { did: LEADER },
      subject: LEADER,
      subjectAttestations: [await linked(LEADER)],
    })
  ).record;
  const delegated = await issuer.issue({
    claimType: "no.nif.clubRole",
    request: { orgId: "fjord" },
    requester: { attestations: [leaderRole], did: LEADER },
    subject: COACH,
    subjectAttestations: [await linked(COACH)],
  });
  assert.equal(delegated.attestation.claim.role, "trener");

  // The same leader, a club they do not lead.
  await assert.rejects(
    async () =>
      issuer.issue({
        claimType: "no.nif.clubRole",
        request: { orgId: "marka" },
        requester: { attestations: [leaderRole], did: LEADER },
        subject: COACH,
        subjectAttestations: [await linked(COACH)],
      }),
    (error) =>
      error instanceof Error && "status" in error && error.status === 403,
  );
});

void test("the adapter can refuse, and its refusal is not a policy failure", async () => {
  const { issuer, linked } = await setup();
  await assert.rejects(
    async () =>
      issuer.issue({
        claimType: "no.nif.instructorLicence",
        request: { discipline: "klatring" },
        requester: { did: COACH },
        subject: COACH,
        subjectAttestations: [await linked(COACH)],
      }),
    (error) =>
      error instanceof Error &&
      "status" in error &&
      error.status === 422 &&
      /lisens/iu.test(error.message),
  );
});

void test("a lifetime is capped by the claim type and may be shortened by the adapter", async () => {
  const { issuer, linked } = await setup();
  const result = await issuer.issue({
    claimType: "no.nif.instructorLicence",
    request: { discipline: "svomming" },
    requester: { did: COACH },
    subject: COACH,
    subjectAttestations: [await linked(COACH)],
  });
  const days =
    (Date.parse(result.attestation.expiresAt) -
      Date.parse(result.attestation.issuedAt)) /
    86_400_000;
  assert.equal(
    days,
    180,
    "the adapter asked for 180, the claim type allows 365",
  );
});

void test("a restricted claim is never published, and is answered only to an authorised asker", async () => {
  const { issuer, publisher, linked } = await setup();
  const leaderRole = (
    await issuer.issue({
      claimType: "no.nif.clubRole",
      request: { orgId: "fjord" },
      requester: { did: LEADER },
      subject: LEADER,
      subjectAttestations: [await linked(LEADER)],
    })
  ).record;
  const attest = await issuer.issue({
    claimType: "no.politiet.attest",
    request: { orgId: "fjord" },
    requester: { client: "politiet-backend" },
    subject: COACH,
    subjectAttestations: [await linked(COACH)],
  });

  assert.equal(
    attest.uri,
    undefined,
    "a restricted claim has no public record",
  );
  assert.equal(
    [...publisher.records.values()].some(
      (r) => r.view?.claimType === "no.politiet.attest",
    ),
    false,
  );

  const asLeader = await issuer.query({
    claimType: "no.politiet.attest",
    request: { orgId: "fjord" },
    requester: { attestations: [leaderRole], did: LEADER },
    subject: COACH,
  });
  assert.equal(asLeader.answer, "valid");
  assert.deepEqual(
    Object.keys(asLeader).toSorted(),
    ["answer", "checkedAt", "claimType", "subject"],
    "the answer carries no evidence",
  );

  for (const [who, requester, request] of [
    ["a child", { did: CHILD }, { orgId: "fjord" }],
    ["the subject’s own club-mate", { did: COACH }, { orgId: "fjord" }],
    [
      "a leader of another club",
      { attestations: [leaderRole], did: LEADER },
      { orgId: "marka" },
    ],
  ] as [string, Requester, Claim][]) {
    await assert.rejects(
      () =>
        issuer.query({
          claimType: "no.politiet.attest",
          request,
          requester,
          subject: COACH,
        }),
      (error) =>
        error instanceof Error && "status" in error && error.status === 403,
      `${who} was answered`,
    );
  }
});

void test("a query that finds nothing says so without revealing whether the person is known", async () => {
  const { issuer, linked } = await setup();
  const leaderRole = (
    await issuer.issue({
      claimType: "no.nif.clubRole",
      request: { orgId: "fjord" },
      requester: { did: LEADER },
      subject: LEADER,
      subjectAttestations: [await linked(LEADER)],
    })
  ).record;
  const answer = await issuer.query({
    claimType: "no.politiet.attest",
    request: { orgId: "fjord" },
    requester: { attestations: [leaderRole], did: LEADER },
    subject: CHILD,
  });
  assert.equal(answer.answer, "none");
});

void test("revocation removes the published record and flips the signed status", async () => {
  const { issuer, publisher, linked, now } = await setup();
  const result = await issuer.issue({
    claimType: "no.nif.instructorLicence",
    request: { discipline: "svomming" },
    requester: { did: COACH },
    subject: COACH,
    subjectAttestations: [await linked(COACH)],
  });
  const policy = issuer.trustPolicy();
  const fetchStatus = async () =>
    (await issuer.status(result.attestation.id)).jws;

  assert.equal(
    (
      await verifyAttestation(result.record, {
        claimTypes,
        fetchStatus,
        now: now(),
        trustPolicy: policy,
      })
    ).valid,
    true,
  );
  assert.equal(
    (
      await issuer.revoke({
        id: result.attestation.id,
        requester: { did: COACH },
      })
    ).revoked,
    true,
  );
  assert.equal(
    publisher.records.has(result.uri ?? ""),
    false,
    "the public record is withdrawn too",
  );

  const after = await verifyAttestation(result.record, {
    claimTypes,
    fetchStatus,
    now: now(),
    trustPolicy: policy,
  });
  assert.equal(after.reason, "revoked");
});

void test("every restricted question is written to the audit trail, refusals included", async () => {
  const { issuer, store, linked } = await setup();
  const leaderRole = (
    await issuer.issue({
      claimType: "no.nif.clubRole",
      request: { orgId: "fjord" },
      requester: { did: LEADER },
      subject: LEADER,
      subjectAttestations: [await linked(LEADER)],
    })
  ).record;
  await issuer.issue({
    claimType: "no.politiet.attest",
    request: { orgId: "fjord" },
    requester: { client: "politiet-backend" },
    subject: COACH,
    subjectAttestations: [await linked(COACH)],
  });
  await issuer.query({
    claimType: "no.politiet.attest",
    request: { orgId: "fjord" },
    requester: { attestations: [leaderRole], did: LEADER },
    subject: COACH,
  });
  await issuer
    .query({
      claimType: "no.politiet.attest",
      request: { orgId: "fjord" },
      requester: { did: CHILD },
      subject: COACH,
    })
    .catch(() => {});

  const queries = store.recentAudit(20).filter((row) => row.action === "query");
  assert.equal(queries.length, 2);
  assert.deepEqual(
    queries
      .map((row) => String(row.outcome))
      .toSorted((left, right) => left.localeCompare(right)),
    ["allowed", "denied"],
  );
  assert.equal(
    queries.every((row) => row.actor && row.subject === COACH),
    true,
  );
});

void test("an unknown claim type is refused before anything else happens", async () => {
  const { issuer } = await setup();
  await assert.rejects(
    () =>
      issuer.issue({
        claimType: "no.nif.notAThing",
        request: {},
        requester: { did: COACH },
        subject: COACH,
      }),
    (error) =>
      error instanceof Error && "status" in error && error.status === 404,
  );
});
