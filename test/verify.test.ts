import assert from "node:assert/strict";
import { test } from "node:test";

import { createAttestation, createStatus } from "../src/core/attestation.ts";
import { generateKeyPair, signCompact } from "../src/core/sign.ts";
import type { AttestationOptions } from "../src/types.ts";
import { parseDescriptor } from "../verify/claim-type.ts";
import { verifyAttestation } from "../verify/index.ts";
import type { Verification } from "../verify/types.ts";

const ISSUER = "https://nif.example/.well-known/attestation-issuer.json";
const SUBJECT = "did:plc:coach";
const NOW = Date.parse("2026-09-17T12:00:00Z");
const descriptor = parseDescriptor({
  claim: {
    additionalProperties: false,
    properties: {
      orgId: { type: "string" },
      role: { enum: ["leder", "trener", "medlem"], type: "string" },
    },
    required: ["orgId", "role"],
    type: "object",
  },
  description: "Rolle i et idrettslag.",
  disclosure: { mode: "public-record" },
  id: "no.nif.clubRole",
  issuance: { requesters: [{ kind: "self" }] },
  label: { nb: "Klubbrolle" },
  maxLifetimeDays: 180,
  version: 1,
  visibility: "public",
});
const setup = async () => {
  const signer = await generateKeyPair("key-1");
  const mint = (overrides: Partial<AttestationOptions> = {}) =>
    createAttestation({
      claim: { orgId: "fjord", role: "leder" },
      claimType: "no.nif.clubRole",
      issuer: ISSUER,
      lifetimeDays: 30,
      now: NOW,
      signer,
      subject: SUBJECT,
      ...overrides,
    });
  const policy = {
    maxClockSkewSeconds: 60,
    requireStatusCheck: false,
    trust: [
      {
        claimTypes: ["no.nif.*"],
        issuer: ISSUER,
        keys: [signer.publicJwk],
      },
    ],
    version: 1,
  };
  return {
    claimTypes: { "no.nif.clubRole": descriptor },
    mint,
    policy,
    signer,
  };
};
const check = (result: Verification, name: string) => {
  const found = result.checks.find((c) => c.name === name);
  assert.ok(found, `Missing ${name} check`);
  return found;
};

void test("a well-formed claim from a trusted issuer is valid", async () => {
  const { mint, policy, claimTypes } = await setup();
  const { record } = await mint();
  const result = await verifyAttestation(record, {
    claimTypes,
    now: NOW,
    trustPolicy: policy,
  });
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.attestation.claim.orgId, "fjord");
  assert.equal(result.attestation.subject, SUBJECT);
  for (const name of ["signature", "trust", "schema", "window"]) {
    assert.equal(check(result, name).ok, true, name);
  }
});

void test("the signed payload is the truth; a rewritten view is reported, not believed", async () => {
  const { mint, policy, claimTypes } = await setup();
  const { record } = await mint();
  record.view.claimType = "no.nif.instructorLicence";
  record.view.subject = "did:plc:someone-else";
  const result = await verifyAttestation(record, {
    claimTypes,
    now: NOW,
    trustPolicy: policy,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "view-mismatch");
  assert.ok(result.attestation);
  assert.equal(
    result.attestation.subject,
    SUBJECT,
    "the verdict still reports the signed subject"
  );
});

void test("a claim signed by someone else, or by an untrusted issuer, is refused", async () => {
  const { mint, policy, claimTypes } = await setup();
  const attacker = await generateKeyPair("key-1");
  const forged = await mint({ signer: attacker });
  assert.equal(
    (
      await verifyAttestation(forged.record, {
        claimTypes,
        now: NOW,
        trustPolicy: policy,
      })
    ).reason,
    "invalid-signature"
  );

  const elsewhere = await mint({
    issuer: "https://attacker.example/.well-known/attestation-issuer.json",
  });
  assert.equal(
    (
      await verifyAttestation(elsewhere.record, {
        claimTypes,
        now: NOW,
        trustPolicy: policy,
      })
    ).reason,
    "untrusted-issuer"
  );

  // Trusted for club roles does not mean trusted for police attestations.
  const outOfScope = await mint({
    claim: { orgId: "fjord", role: "leder" },
    claimType: "no.politiet.attest",
  });
  assert.equal(
    (
      await verifyAttestation(outOfScope.record, {
        claimTypes,
        now: NOW,
        trustPolicy: policy,
      })
    ).reason,
    "untrusted-issuer"
  );
});

void test("expiry and not-yet-valid claims fail, with a bounded clock skew", async () => {
  const { mint, policy, claimTypes } = await setup();
  const { record } = await mint({ lifetimeDays: 1 });
  const later = NOW + 2 * 86_400_000;
  assert.equal(
    (
      await verifyAttestation(record, {
        claimTypes,
        now: later,
        trustPolicy: policy,
      })
    ).reason,
    "expired"
  );
  assert.equal(
    (
      await verifyAttestation(record, {
        claimTypes,
        now: NOW - 3_600_000,
        trustPolicy: policy,
      })
    ).reason,
    "not-yet-valid"
  );
  assert.equal(
    (
      await verifyAttestation(record, {
        claimTypes,
        now: NOW - 30_000,
        trustPolicy: policy,
      })
    ).valid,
    true,
    "small skew is tolerated"
  );
});

void test("a payload that does not match its claim type is refused", async () => {
  const { mint, policy, claimTypes } = await setup();
  const { record } = await mint({ claim: { orgId: "fjord", role: "sjef" } });
  const result = await verifyAttestation(record, {
    claimTypes,
    now: NOW,
    trustPolicy: policy,
  });
  assert.equal(result.reason, "schema");
  assert.match(check(result, "schema").detail ?? "", /role/u);
});

void test('revocation is checked against a signed status answer, and failing to reach it is never "valid"', async () => {
  const { signer, mint, policy, claimTypes } = await setup();
  const { record, payload } = await mint();
  const strict = { ...policy, requireStatusCheck: true };
  const status = async (state: string) =>
    createStatus({ id: payload.id, issuer: ISSUER, now: NOW, signer, state });
  const active = await status("active");
  assert.equal(
    (
      await verifyAttestation(record, {
        claimTypes,
        fetchStatus: async () => active,
        now: NOW,
        trustPolicy: strict,
      })
    ).valid,
    true
  );

  const revoked = await status("revoked");
  assert.equal(
    (
      await verifyAttestation(record, {
        claimTypes,
        fetchStatus: async () => revoked,
        now: NOW,
        trustPolicy: strict,
      })
    ).reason,
    "revoked"
  );

  const offline = async () => {
    throw new Error("connection refused");
  };
  assert.equal(
    (
      await verifyAttestation(record, {
        claimTypes,
        fetchStatus: offline,
        now: NOW,
        trustPolicy: strict,
      })
    ).reason,
    "status-unavailable"
  );
  assert.equal(
    (
      await verifyAttestation(record, {
        claimTypes,
        now: NOW,
        trustPolicy: strict,
      })
    ).reason,
    "status-unavailable"
  );

  // A stale status answer must not stand in for a current one.
  assert.equal(
    (
      await verifyAttestation(record, {
        claimTypes,
        fetchStatus: async () => active,
        now: NOW + 3_600_000,
        trustPolicy: strict,
      })
    ).reason,
    "status-stale"
  );

  // A status answer for a different attestation, or signed by another key, is not an answer.
  const wrongId = await createStatus({
    id: "other-id",
    issuer: ISSUER,
    now: NOW,
    signer,
    state: "active",
  });
  assert.equal(
    (
      await verifyAttestation(record, {
        claimTypes,
        fetchStatus: async () => wrongId,
        now: NOW,
        trustPolicy: strict,
      })
    ).reason,
    "status-unavailable"
  );
});

void test("an application states what it expects, and a valid claim about something else does not satisfy it", async () => {
  const { mint, policy, claimTypes } = await setup();
  const { record } = await mint();
  const expect = {
    claim: { orgId: "fjord", role: "leder" },
    claimType: "no.nif.clubRole",
    subject: SUBJECT,
  };
  assert.equal(
    (
      await verifyAttestation(record, {
        claimTypes,
        expect,
        now: NOW,
        trustPolicy: policy,
      })
    ).valid,
    true
  );
  for (const wrong of [
    { ...expect, subject: "did:plc:other" },
    { ...expect, claim: { orgId: "marka", role: "leder" } },
    { ...expect, claim: { orgId: "fjord", role: "trener" } },
  ]) {
    assert.equal(
      (
        await verifyAttestation(record, {
          claimTypes,
          expect: wrong,
          now: NOW,
          trustPolicy: policy,
        })
      ).reason,
      "expectations"
    );
  }
});

void test("provenance is a separate check: a valid claim republished from the wrong repository is flagged", async () => {
  const { mint, policy, claimTypes } = await setup();
  const { record } = await mint();
  const trustPolicy = {
    ...policy,
    trust: [{ ...policy.trust[0], repo: "did:plc:nif" }],
  };
  const at = (uri: string) => ({ claimTypes, now: NOW, trustPolicy, uri });
  assert.equal(
    (
      await verifyAttestation(
        record,
        at("at://did:plc:nif/no.demokratiloftet.attestation/3k2")
      )
    ).valid,
    true
  );
  const moved = await verifyAttestation(
    record,
    at("at://did:plc:attacker/no.demokratiloftet.attestation/3k2")
  );
  assert.equal(moved.reason, "provenance");
  assert.equal(
    check(moved, "signature").ok,
    true,
    "the signature is still good; only its location is wrong"
  );
});

void test("nonsense input fails closed rather than throwing", async () => {
  const { policy, claimTypes } = await setup();
  for (const value of [
    null,
    {},
    { jws: "rubbish" },
    { $type: "other", jws: "a.b.c" },
    "not-a-record",
  ]) {
    const result = await verifyAttestation(value, {
      claimTypes,
      now: NOW,
      trustPolicy: policy,
    });
    assert.equal(result.valid, false);
    assert.equal(typeof result.reason, "string");
  }
});

void test("an unknown claim type is refused rather than accepted unvalidated", async () => {
  const { mint, policy } = await setup();
  const { record } = await mint();
  assert.equal(
    (
      await verifyAttestation(record, {
        claimTypes: {},
        now: NOW,
        trustPolicy: policy,
      })
    ).reason,
    "unknown-claim-type"
  );
});

void test("malformed signed payloads and nonfinite policy windows cannot pass verification", async () => {
  const { signer, mint, policy, claimTypes } = await setup();
  const { payload, record } = await mint();
  for (const override of [
    { id: null },
    { claim: [] },
    { iat: 42 },
    { status: null },
  ]) {
    const jws = await signCompact(signer, { ...payload, ...override });
    assert.equal(
      (
        await verifyAttestation(jws, {
          claimTypes,
          now: NOW,
          trustPolicy: policy,
        })
      ).reason,
      "malformed"
    );
  }
  for (const maxClockSkewSeconds of [Number.NaN, Infinity, -1]) {
    assert.equal(
      (
        await verifyAttestation(record, {
          claimTypes,
          now: NOW,
          trustPolicy: { ...policy, maxClockSkewSeconds },
        })
      ).reason,
      "no-trust-policy"
    );
  }
  assert.equal(
    (
      await verifyAttestation(record, {
        claimTypes,
        now: NOW,
        trustPolicy: { ...policy, maxStatusAgeSeconds: Number.NaN },
      })
    ).reason,
    "no-trust-policy"
  );
});
