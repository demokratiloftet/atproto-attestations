import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPair } from '../src/core/sign.mjs';
import { IssuerStore } from '../src/core/store.mjs';
import { loadClaimTypes } from '../src/core/registry.mjs';
import { createDemoAdapter } from '../src/adapters/demo-nif.mjs';
import { createIssuer } from '../src/core/issuer.mjs';
import { verifyAttestation } from '../verify/index.mjs';

const ISSUER = 'https://demo-utsteder.example/.well-known/attestation-issuer.json';
const LEADER = 'did:plc:leader';
const COACH = 'did:plc:coach';
const CHILD = 'did:plc:child';
const claimTypes = loadClaimTypes('claim-types');

function memoryPublisher() {
  const records = new Map();
  let n = 0;
  return {
    id: 'memory', records,
    async publish(record) { const uri = `at://did:plc:issuer/no.demokratiloftet.attestation/${++n}`; records.set(uri, record); return { uri, cid: `cid-${n}` }; },
    async remove(uri) { records.delete(uri); return {}; },
  };
}

async function setup({ now = () => Date.parse('2026-09-17T12:00:00Z') } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'attest-'));
  const signer = await generateKeyPair('key-1');
  const store = new IssuerStore(dir);
  const publisher = memoryPublisher();
  const adapter = createDemoAdapter({ file: join(dir, 'roster.json') });
  const issuer = createIssuer({ issuer: ISSUER, name: 'Demo-utsteder', signer, store, claimTypes, adapter, publisher, demo: true, now });

  adapter.enrol(LEADER, { identity: { assuranceLevel: 'substantial', provider: 'demo-idp' }, clubs: [{ orgId: 'fjord', orgName: 'Fjord idrettslag', role: 'leder' }] });
  adapter.enrol(COACH, {
    identity: { assuranceLevel: 'substantial', provider: 'demo-idp' },
    clubs: [{ orgId: 'fjord', orgName: 'Fjord idrettslag', role: 'trener' }],
    licences: [{ discipline: 'svomming', level: 'instruktor-2' }],
    attests: [{ orgId: 'fjord' }],
  });
  adapter.enrol(CHILD, { identity: { assuranceLevel: 'substantial', provider: 'demo-idp' }, clubs: [{ orgId: 'fjord', orgName: 'Fjord idrettslag', role: 'medlem' }] });

  const linked = async subject => (await issuer.issue({ claimType: 'no.nif.identityLinked', subject, request: {}, requester: { did: subject } })).record;
  return { issuer, adapter, store, publisher, signer, linked, dir, now };
}

test('a person links their account, then receives a licence that verifies independently', async () => {
  const { issuer, linked, now } = await setup();
  const evidence = [await linked(COACH)];
  const result = await issuer.issue({ claimType: 'no.nif.instructorLicence', subject: COACH, request: { discipline: 'svomming' }, requester: { did: COACH }, subjectAttestations: evidence });

  assert.equal(result.attestation.claim.level, 'instruktor-2');
  assert.equal(typeof result.uri, 'string', 'a public claim is published');

  // Verified the way any unrelated application would, with no access to the issuer.
  const verdict = await verifyAttestation(result.record, {
    trustPolicy: { ...issuer.trustPolicy(), requireStatusCheck: false }, claimTypes, now: now(),
    expect: { subject: COACH, claimType: 'no.nif.instructorLicence', claim: { discipline: 'svomming' } },
  });
  assert.equal(verdict.valid, true, verdict.reason);
});

test('without the required identity assurance, nothing is issued', async () => {
  const { issuer } = await setup();
  await assert.rejects(
    () => issuer.issue({ claimType: 'no.nif.clubRole', subject: COACH, request: { orgId: 'fjord' }, requester: { did: COACH } }),
    error => error.status === 403 && /identitet|assurance|kobling/i.test(error.message));
});

test('a club leader may issue a role for someone in their own club, and only there', async () => {
  const { issuer, linked } = await setup();
  const leaderRole = (await issuer.issue({ claimType: 'no.nif.clubRole', subject: LEADER, request: { orgId: 'fjord' }, requester: { did: LEADER }, subjectAttestations: [await linked(LEADER)] })).record;

  const delegated = await issuer.issue({
    claimType: 'no.nif.clubRole', subject: COACH, request: { orgId: 'fjord' },
    requester: { did: LEADER, attestations: [leaderRole] }, subjectAttestations: [await linked(COACH)],
  });
  assert.equal(delegated.attestation.claim.role, 'trener');

  // The same leader, a club they do not lead.
  await assert.rejects(async () => issuer.issue({
    claimType: 'no.nif.clubRole', subject: COACH, request: { orgId: 'marka' },
    requester: { did: LEADER, attestations: [leaderRole] }, subjectAttestations: [await linked(COACH)],
  }), error => error.status === 403);
});

test('the adapter can refuse, and its refusal is not a policy failure', async () => {
  const { issuer, linked } = await setup();
  await assert.rejects(
    async () => issuer.issue({ claimType: 'no.nif.instructorLicence', subject: COACH, request: { discipline: 'klatring' }, requester: { did: COACH }, subjectAttestations: [await linked(COACH)] }),
    error => error.status === 422 && /lisens/i.test(error.message));
});

test('a lifetime is capped by the claim type and may be shortened by the adapter', async () => {
  const { issuer, linked } = await setup();
  const result = await issuer.issue({ claimType: 'no.nif.instructorLicence', subject: COACH, request: { discipline: 'svomming' }, requester: { did: COACH }, subjectAttestations: [await linked(COACH)] });
  const days = (Date.parse(result.attestation.expiresAt) - Date.parse(result.attestation.issuedAt)) / 86400000;
  assert.equal(days, 180, 'the adapter asked for 180, the claim type allows 365');
});

test('a restricted claim is never published, and is answered only to an authorised asker', async () => {
  const { issuer, publisher, linked } = await setup();
  const leaderRole = (await issuer.issue({ claimType: 'no.nif.clubRole', subject: LEADER, request: { orgId: 'fjord' }, requester: { did: LEADER }, subjectAttestations: [await linked(LEADER)] })).record;
  const attest = await issuer.issue({ claimType: 'no.politiet.attest', subject: COACH, request: { orgId: 'fjord' }, requester: { client: 'politiet-backend' }, subjectAttestations: [await linked(COACH)] });

  assert.equal(attest.uri, undefined, 'a restricted claim has no public record');
  assert.equal([...publisher.records.values()].some(r => r.view?.claimType === 'no.politiet.attest'), false);

  const asLeader = await issuer.query({ claimType: 'no.politiet.attest', subject: COACH, request: { orgId: 'fjord' }, requester: { did: LEADER, attestations: [leaderRole] } });
  assert.equal(asLeader.answer, 'valid');
  assert.deepEqual(Object.keys(asLeader).sort(), ['answer', 'checkedAt', 'claimType', 'subject'], 'the answer carries no evidence');

  for (const [who, requester, request] of [
    ['a child', { did: CHILD }, { orgId: 'fjord' }],
    ['the subject’s own club-mate', { did: COACH }, { orgId: 'fjord' }],
    ['a leader of another club', { did: LEADER, attestations: [leaderRole] }, { orgId: 'marka' }],
  ]) {
    await assert.rejects(() => issuer.query({ claimType: 'no.politiet.attest', subject: COACH, request, requester }),
      error => error.status === 403, `${who} was answered`);
  }
});

test('a query that finds nothing says so without revealing whether the person is known', async () => {
  const { issuer, linked } = await setup();
  const leaderRole = (await issuer.issue({ claimType: 'no.nif.clubRole', subject: LEADER, request: { orgId: 'fjord' }, requester: { did: LEADER }, subjectAttestations: [await linked(LEADER)] })).record;
  const answer = await issuer.query({ claimType: 'no.politiet.attest', subject: CHILD, request: { orgId: 'fjord' }, requester: { did: LEADER, attestations: [leaderRole] } });
  assert.equal(answer.answer, 'none');
});

test('revocation removes the published record and flips the signed status', async () => {
  const { issuer, publisher, linked, now } = await setup();
  const result = await issuer.issue({ claimType: 'no.nif.instructorLicence', subject: COACH, request: { discipline: 'svomming' }, requester: { did: COACH }, subjectAttestations: [await linked(COACH)] });
  const policy = issuer.trustPolicy();
  const fetchStatus = async () => (await issuer.status(result.attestation.id)).jws;

  assert.equal((await verifyAttestation(result.record, { trustPolicy: policy, claimTypes, now: now(), fetchStatus })).valid, true);
  assert.equal((await issuer.revoke({ id: result.attestation.id, requester: { did: COACH } })).revoked, true);
  assert.equal(publisher.records.has(result.uri), false, 'the public record is withdrawn too');

  const after = await verifyAttestation(result.record, { trustPolicy: policy, claimTypes, now: now(), fetchStatus });
  assert.equal(after.reason, 'revoked');
});

test('every restricted question is written to the audit trail, refusals included', async () => {
  const { issuer, store, linked } = await setup();
  const leaderRole = (await issuer.issue({ claimType: 'no.nif.clubRole', subject: LEADER, request: { orgId: 'fjord' }, requester: { did: LEADER }, subjectAttestations: [await linked(LEADER)] })).record;
  await issuer.issue({ claimType: 'no.politiet.attest', subject: COACH, request: { orgId: 'fjord' }, requester: { client: 'politiet-backend' }, subjectAttestations: [await linked(COACH)] });
  await issuer.query({ claimType: 'no.politiet.attest', subject: COACH, request: { orgId: 'fjord' }, requester: { did: LEADER, attestations: [leaderRole] } });
  await issuer.query({ claimType: 'no.politiet.attest', subject: COACH, request: { orgId: 'fjord' }, requester: { did: CHILD } }).catch(() => {});

  const queries = store.recentAudit(20).filter(row => row.action === 'query');
  assert.equal(queries.length, 2);
  assert.deepEqual(queries.map(row => row.outcome).sort(), ['allowed', 'denied']);
  assert.equal(queries.every(row => row.actor && row.subject === COACH), true);
});

test('an unknown claim type is refused before anything else happens', async () => {
  const { issuer } = await setup();
  await assert.rejects(() => issuer.issue({ claimType: 'no.nif.notAThing', subject: COACH, request: {}, requester: { did: COACH } }),
    error => error.status === 404);
});
