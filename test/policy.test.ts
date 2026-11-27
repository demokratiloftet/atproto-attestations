import assert from "node:assert/strict";
import { test } from "node:test";

import { createAttestation } from "../src/core/attestation.ts";
import { evaluateRequester } from "../src/core/policy.ts";
import { generateKeyPair } from "../src/core/sign.ts";
import type { AttestationOptions, PolicyContext } from "../src/types.ts";
import { parseDescriptor } from "../verify/claim-type.ts";
import type { Claim, RequesterRule } from "../verify/types.ts";

const ISSUER = "https://nif.example/.well-known/attestation-issuer.json";
const NOW = Date.parse("2026-09-17T12:00:00Z");
const COACH = "did:plc:coach";
const LEADER = "did:plc:leader";
const CHILD = "did:plc:child";
const clubRole = parseDescriptor({
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
// The case that motivated this: a club leader may ask about a coach in their
// own club; a child, a parent, or the leader of another club may not.
const attest = parseDescriptor({
  claim: {
    additionalProperties: false,
    properties: { orgId: { type: "string" }, purpose: { type: "string" } },
    required: ["orgId", "purpose"],
    type: "object",
  },
  description: "Syntetisk demonstrasjon av begrenset innsyn.",
  disclosure: {
    mode: "query-only",
    purposes: ["politiattest-kontroll"],
    requesters: [
      {
        claimType: "no.nif.clubRole",
        kind: "attestation",
        where: { orgId: "$request.orgId", role: "leder" },
      },
    ],
  },
  id: "no.politiet.attest",
  issuance: { requesters: [{ client: "politiet-backend", kind: "client" }] },
  label: { nb: "Politiattest" },
  maxLifetimeDays: 1095,
  version: 1,
  visibility: "restricted",
});
const setup = async () => {
  const signer = await generateKeyPair("key-1");
  const claimTypes = {
    "no.nif.clubRole": clubRole,
    "no.politiet.attest": attest,
  };
  const trustPolicy = {
    requireStatusCheck: false,
    trust: [
      {
        claimTypes: ["no.nif.*", "no.politiet.*"],
        issuer: ISSUER,
        keys: [signer.publicJwk],
      },
    ],
    version: 1,
  };
  const role = async (
    subject: string,
    claim: Claim,
    overrides: Partial<AttestationOptions> = {},
  ) =>
    (
      await createAttestation({
        claim,
        claimType: "no.nif.clubRole",
        issuer: ISSUER,
        lifetimeDays: 30,
        now: NOW,
        signer,
        subject,
        ...overrides,
      })
    ).record;
  const evaluate = (
    rules: RequesterRule[] | undefined,
    context: Omit<PolicyContext, "trustPolicy" | "claimTypes">,
  ) =>
    evaluateRequester(rules, {
      claimTypes,
      now: NOW,
      trustPolicy,
      ...context,
    });
  return { claimTypes, evaluate, role, signer, trustPolicy };
};

void test("self-service: the holder may ask about their own account, and nobody else may", async () => {
  const { evaluate } = await setup();
  const rules: RequesterRule[] = [{ kind: "self" }];
  assert.equal(
    (
      await evaluate(rules, {
        request: {},
        requester: { did: COACH },
        subject: COACH,
      })
    ).allowed,
    true,
  );
  const denied = await evaluate(rules, {
    request: {},
    requester: { did: LEADER },
    subject: COACH,
  });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /ikke/iu);
});

void test("a club leader may ask about a coach in the club they lead", async () => {
  const { role, evaluate } = await setup();
  const evidence = [await role(LEADER, { orgId: "fjord", role: "leder" })];
  const result = await evaluate(attest.disclosure.requesters, {
    request: { orgId: "fjord" },
    requester: { attestations: evidence, did: LEADER },
    subject: COACH,
  });
  assert.equal(result.allowed, true, result.reason);
  assert.ok(result.allowed && result.matched);
  assert.equal(result.matched.claimType, "no.nif.clubRole");
});

void test("the same leader may not ask about another club", async () => {
  const { role, evaluate } = await setup();
  const evidence = [await role(LEADER, { orgId: "fjord", role: "leder" })];
  const result = await evaluate(attest.disclosure.requesters, {
    request: { orgId: "marka" },
    requester: { attestations: evidence, did: LEADER },
    subject: COACH,
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /orgId/u);
});

void test("a member, a coach and someone with no attestation at all are refused", async () => {
  const { role, evaluate } = await setup();
  const rules = attest.disclosure.requesters;
  const cases: [string, unknown[]][] = [
    ["a plain member", [await role(CHILD, { orgId: "fjord", role: "medlem" })]],
    ["a coach", [await role(COACH, { orgId: "fjord", role: "trener" })]],
    ["nobody in particular", []],
  ];
  for (const [who, attestations] of cases) {
    const result = await evaluate(rules, {
      request: { orgId: "fjord" },
      requester: { attestations, did: CHILD },
      subject: COACH,
    });
    assert.equal(result.allowed, false, `${who} was allowed`);
  }
});

void test("evidence that belongs to somebody else does not make the requester a leader", async () => {
  const { role, evaluate } = await setup();
  // A real leader's attestation, presented by someone who is not that leader.
  const stolen = [await role(LEADER, { orgId: "fjord", role: "leder" })];
  const result = await evaluate(attest.disclosure.requesters, {
    request: { orgId: "fjord" },
    requester: { attestations: stolen, did: CHILD },
    subject: COACH,
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /kontoen/iu);
});

void test("expired or forged evidence does not authorise anything", async () => {
  const { role, evaluate, trustPolicy, claimTypes } = await setup();
  const rules = attest.disclosure.requesters;
  const context = (attestations: unknown[]) => ({
    request: { orgId: "fjord" },
    requester: { attestations, did: LEADER },
    subject: COACH,
  });
  const expired = [
    await role(
      LEADER,
      { orgId: "fjord", role: "leder" },
      { lifetimeDays: 1, now: NOW - 5 * 86_400_000 },
    ),
  ];
  assert.equal((await evaluate(rules, context(expired))).allowed, false);

  const attacker = await generateKeyPair("key-1");
  const forged = [
    (
      await createAttestation({
        claim: { orgId: "fjord", role: "leder" },
        claimType: "no.nif.clubRole",
        issuer: ISSUER,
        lifetimeDays: 30,
        now: NOW,
        signer: attacker,
        subject: LEADER,
      })
    ).record,
  ];
  assert.equal((await evaluate(rules, context(forged))).allowed, false);

  // Policy evidence is checked with exactly the same rules an application uses.
  assert.equal(trustPolicy.trust[0].keys.length, 1);
  assert.equal(Object.keys(claimTypes).length, 2);
});

void test("a trusted backend client may be named directly, and only the named one qualifies", async () => {
  const { evaluate } = await setup();
  const rules = attest.issuance.requesters;
  assert.equal(
    (
      await evaluate(rules, {
        request: { orgId: "fjord" },
        requester: { client: "politiet-backend" },
        subject: COACH,
      })
    ).allowed,
    true,
  );
  assert.equal(
    (
      await evaluate(rules, {
        request: { orgId: "fjord" },
        requester: { client: "calendar" },
        subject: COACH,
      })
    ).allowed,
    false,
  );
  assert.equal(
    (
      await evaluate(rules, {
        request: { orgId: "fjord" },
        requester: { did: LEADER },
        subject: COACH,
      })
    ).allowed,
    false,
  );
});

void test("an empty rule list denies, and a decision always states a reason", async () => {
  const { evaluate } = await setup();
  const result = await evaluate([], {
    request: {},
    requester: { did: LEADER },
    subject: COACH,
  });
  assert.equal(result.allowed, false);
  assert.equal(typeof result.reason, "string");
  assert.equal(result.reason.length > 5, true);
});
