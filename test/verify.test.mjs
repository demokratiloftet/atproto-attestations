import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair } from '../src/core/sign.mjs';
import { createAttestation, createStatus } from '../src/core/attestation.mjs';
import { verifyAttestation } from '../verify/index.mjs';
import { parseDescriptor } from '../verify/claim-type.mjs';

const ISSUER = 'https://nif.example/.well-known/attestation-issuer.json';
const SUBJECT = 'did:plc:coach';
const NOW = Date.parse('2026-09-17T12:00:00Z');

const descriptor = parseDescriptor({
  version: 1, id: 'no.nif.clubRole', label: { nb: 'Klubbrolle' }, description: 'Rolle i et idrettslag.',
  visibility: 'public', maxLifetimeDays: 180,
  claim: { type: 'object', additionalProperties: false, required: ['orgId', 'role'], properties: { orgId: { type: 'string' }, role: { type: 'string', enum: ['leder', 'trener', 'medlem'] } } },
  issuance: { requesters: [{ kind: 'self' }] }, disclosure: { mode: 'public-record' },
});

const setup = async () => {
  const signer = await generateKeyPair('key-1');
  const mint = (overrides = {}) => createAttestation({
    signer, issuer: ISSUER, subject: SUBJECT, claimType: 'no.nif.clubRole',
    claim: { orgId: 'fjord', role: 'leder' }, lifetimeDays: 30, now: NOW, ...overrides,
  });
  const policy = {
    version: 1, maxClockSkewSeconds: 60, requireStatusCheck: false,
    trust: [{ claimTypes: ['no.nif.*'], issuer: ISSUER, keys: [signer.publicJwk] }],
  };
  return { signer, mint, policy, claimTypes: { 'no.nif.clubRole': descriptor } };
};

const check = (result, name) => result.checks.find(c => c.name === name);

test('a well-formed claim from a trusted issuer is valid', async () => {
  const { mint, policy, claimTypes } = await setup();
  const { record } = await mint();
  const result = await verifyAttestation(record, { trustPolicy: policy, claimTypes, now: NOW });
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.attestation.claim.orgId, 'fjord');
  assert.equal(result.attestation.subject, SUBJECT);
  for (const name of ['signature', 'trust', 'schema', 'window']) assert.equal(check(result, name).ok, true, name);
});

test('the signed payload is the truth; a rewritten view is reported, not believed', async () => {
  const { mint, policy, claimTypes } = await setup();
  const { record } = await mint();
  record.view.claimType = 'no.nif.instructorLicence';
  record.view.subject = 'did:plc:someone-else';
  const result = await verifyAttestation(record, { trustPolicy: policy, claimTypes, now: NOW });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'view-mismatch');
  assert.equal(result.attestation.subject, SUBJECT, 'the verdict still reports the signed subject');
});

test('a claim signed by someone else, or by an untrusted issuer, is refused', async () => {
  const { mint, policy, claimTypes } = await setup();
  const attacker = await generateKeyPair('key-1');
  const forged = await mint({ signer: attacker });
  assert.equal((await verifyAttestation(forged.record, { trustPolicy: policy, claimTypes, now: NOW })).reason, 'invalid-signature');

  const elsewhere = await mint({ issuer: 'https://attacker.example/.well-known/attestation-issuer.json' });
  assert.equal((await verifyAttestation(elsewhere.record, { trustPolicy: policy, claimTypes, now: NOW })).reason, 'untrusted-issuer');

  // Trusted for club roles does not mean trusted for police attestations.
  const outOfScope = await mint({ claimType: 'no.politiet.attest', claim: { orgId: 'fjord', role: 'leder' } });
  assert.equal((await verifyAttestation(outOfScope.record, { trustPolicy: policy, claimTypes, now: NOW })).reason, 'untrusted-issuer');
});

test('expiry and not-yet-valid claims fail, with a bounded clock skew', async () => {
  const { mint, policy, claimTypes } = await setup();
  const { record } = await mint({ lifetimeDays: 1 });
  const later = NOW + 2 * 86400000;
  assert.equal((await verifyAttestation(record, { trustPolicy: policy, claimTypes, now: later })).reason, 'expired');
  assert.equal((await verifyAttestation(record, { trustPolicy: policy, claimTypes, now: NOW - 3600000 })).reason, 'not-yet-valid');
  assert.equal((await verifyAttestation(record, { trustPolicy: policy, claimTypes, now: NOW - 30000 })).valid, true, 'small skew is tolerated');
});

test('a payload that does not match its claim type is refused', async () => {
  const { mint, policy, claimTypes } = await setup();
  const { record } = await mint({ claim: { orgId: 'fjord', role: 'sjef' } });
  const result = await verifyAttestation(record, { trustPolicy: policy, claimTypes, now: NOW });
  assert.equal(result.reason, 'schema');
  assert.match(check(result, 'schema').detail, /role/);
});

test('revocation is checked against a signed status answer, and failing to reach it is never "valid"', async () => {
  const { signer, mint, policy, claimTypes } = await setup();
  const { record, payload } = await mint();
  const strict = { ...policy, requireStatusCheck: true };
  const status = async state => createStatus({ signer, issuer: ISSUER, id: payload.id, state, now: NOW });

  const active = await status('active');
  assert.equal((await verifyAttestation(record, { trustPolicy: strict, claimTypes, now: NOW, fetchStatus: async () => active })).valid, true);

  const revoked = await status('revoked');
  assert.equal((await verifyAttestation(record, { trustPolicy: strict, claimTypes, now: NOW, fetchStatus: async () => revoked })).reason, 'revoked');

  const offline = async () => { throw new Error('connection refused'); };
  assert.equal((await verifyAttestation(record, { trustPolicy: strict, claimTypes, now: NOW, fetchStatus: offline })).reason, 'status-unavailable');
  assert.equal((await verifyAttestation(record, { trustPolicy: strict, claimTypes, now: NOW })).reason, 'status-unavailable');

  // A stale status answer must not stand in for a current one.
  assert.equal((await verifyAttestation(record, { trustPolicy: strict, claimTypes, now: NOW + 3600000, fetchStatus: async () => active })).reason, 'status-stale');

  // A status answer for a different attestation, or signed by another key, is not an answer.
  const wrongId = await createStatus({ signer, issuer: ISSUER, id: 'other-id', state: 'active', now: NOW });
  assert.equal((await verifyAttestation(record, { trustPolicy: strict, claimTypes, now: NOW, fetchStatus: async () => wrongId })).reason, 'status-unavailable');
});

test('an application states what it expects, and a valid claim about something else does not satisfy it', async () => {
  const { mint, policy, claimTypes } = await setup();
  const { record } = await mint();
  const expect = { subject: SUBJECT, claimType: 'no.nif.clubRole', claim: { orgId: 'fjord', role: 'leder' } };
  assert.equal((await verifyAttestation(record, { trustPolicy: policy, claimTypes, now: NOW, expect })).valid, true);
  for (const wrong of [{ ...expect, subject: 'did:plc:other' }, { ...expect, claim: { orgId: 'marka', role: 'leder' } }, { ...expect, claim: { orgId: 'fjord', role: 'trener' } }])
    assert.equal((await verifyAttestation(record, { trustPolicy: policy, claimTypes, now: NOW, expect: wrong })).reason, 'expectations');
});

test('provenance is a separate check: a valid claim republished from the wrong repository is flagged', async () => {
  const { mint, policy, claimTypes } = await setup();
  const { record } = await mint();
  const trustPolicy = { ...policy, trust: [{ ...policy.trust[0], repo: 'did:plc:nif' }] };
  const at = uri => ({ trustPolicy, claimTypes, now: NOW, uri });
  assert.equal((await verifyAttestation(record, at('at://did:plc:nif/no.demokratiloftet.attestation/3k2'))).valid, true);
  const moved = await verifyAttestation(record, at('at://did:plc:attacker/no.demokratiloftet.attestation/3k2'));
  assert.equal(moved.reason, 'provenance');
  assert.equal(check(moved, 'signature').ok, true, 'the signature is still good; only its location is wrong');
});

test('nonsense input fails closed rather than throwing', async () => {
  const { policy, claimTypes } = await setup();
  for (const value of [null, {}, { jws: 'rubbish' }, { $type: 'other', jws: 'a.b.c' }, 'not-a-record']) {
    const result = await verifyAttestation(value, { trustPolicy: policy, claimTypes, now: NOW });
    assert.equal(result.valid, false);
    assert.equal(typeof result.reason, 'string');
  }
});

test('an unknown claim type is refused rather than accepted unvalidated', async () => {
  const { mint, policy } = await setup();
  const { record } = await mint();
  assert.equal((await verifyAttestation(record, { trustPolicy: policy, claimTypes: {}, now: NOW })).reason, 'unknown-claim-type');
});
