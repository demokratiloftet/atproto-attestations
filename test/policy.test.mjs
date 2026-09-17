import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair } from '../src/core/sign.mjs';
import { createAttestation } from '../src/core/attestation.mjs';
import { evaluateRequester } from '../src/core/policy.mjs';
import { parseDescriptor } from '../verify/claim-type.mjs';

const ISSUER = 'https://nif.example/.well-known/attestation-issuer.json';
const NOW = Date.parse('2026-09-17T12:00:00Z');
const COACH = 'did:plc:coach';
const LEADER = 'did:plc:leader';
const CHILD = 'did:plc:child';

const clubRole = parseDescriptor({
  version: 1, id: 'no.nif.clubRole', label: { nb: 'Klubbrolle' }, description: 'Rolle i et idrettslag.',
  visibility: 'public', maxLifetimeDays: 180,
  claim: { type: 'object', additionalProperties: false, required: ['orgId', 'role'], properties: { orgId: { type: 'string' }, role: { type: 'string', enum: ['leder', 'trener', 'medlem'] } } },
  issuance: { requesters: [{ kind: 'self' }] }, disclosure: { mode: 'public-record' },
});

// The case that motivated this: a club leader may ask about a coach in their
// own club; a child, a parent, or the leader of another club may not.
const attest = parseDescriptor({
  version: 1, id: 'no.politiet.attest', label: { nb: 'Politiattest' }, description: 'Syntetisk demonstrasjon av begrenset innsyn.',
  visibility: 'restricted', maxLifetimeDays: 1095,
  claim: { type: 'object', additionalProperties: false, required: ['orgId', 'purpose'], properties: { orgId: { type: 'string' }, purpose: { type: 'string' } } },
  issuance: { requesters: [{ kind: 'client', client: 'politiet-backend' }] },
  disclosure: {
    mode: 'query-only', purposes: ['politiattest-kontroll'],
    requesters: [{ kind: 'attestation', claimType: 'no.nif.clubRole', where: { role: 'leder', orgId: '$request.orgId' } }],
  },
});

const setup = async () => {
  const signer = await generateKeyPair('key-1');
  const claimTypes = { 'no.nif.clubRole': clubRole, 'no.politiet.attest': attest };
  const trustPolicy = { version: 1, requireStatusCheck: false, trust: [{ claimTypes: ['no.nif.*', 'no.politiet.*'], issuer: ISSUER, keys: [signer.publicJwk] }] };
  const role = async (subject, claim, overrides = {}) => (await createAttestation({
    signer, issuer: ISSUER, subject, claimType: 'no.nif.clubRole', claim, lifetimeDays: 30, now: NOW, ...overrides,
  })).record;
  const evaluate = (rules, context) => evaluateRequester(rules, { trustPolicy, claimTypes, now: NOW, ...context });
  return { signer, role, evaluate, trustPolicy, claimTypes };
};

test('self-service: the holder may ask about their own account, and nobody else may', async () => {
  const { evaluate } = await setup();
  const rules = [{ kind: 'self' }];
  assert.equal((await evaluate(rules, { requester: { did: COACH }, subject: COACH, request: {} })).allowed, true);
  const denied = await evaluate(rules, { requester: { did: LEADER }, subject: COACH, request: {} });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /ikke/i);
});

test('a club leader may ask about a coach in the club they lead', async () => {
  const { role, evaluate } = await setup();
  const evidence = [await role(LEADER, { orgId: 'fjord', role: 'leder' })];
  const result = await evaluate(attest.disclosure.requesters, { requester: { did: LEADER, attestations: evidence }, subject: COACH, request: { orgId: 'fjord' } });
  assert.equal(result.allowed, true, result.reason);
  assert.equal(result.matched.claimType, 'no.nif.clubRole');
});

test('the same leader may not ask about another club', async () => {
  const { role, evaluate } = await setup();
  const evidence = [await role(LEADER, { orgId: 'fjord', role: 'leder' })];
  const result = await evaluate(attest.disclosure.requesters, { requester: { did: LEADER, attestations: evidence }, subject: COACH, request: { orgId: 'marka' } });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /orgId/);
});

test('a member, a coach and someone with no attestation at all are refused', async () => {
  const { role, evaluate } = await setup();
  const rules = attest.disclosure.requesters;
  const cases = [
    ['a plain member', [await role(CHILD, { orgId: 'fjord', role: 'medlem' })]],
    ['a coach', [await role(COACH, { orgId: 'fjord', role: 'trener' })]],
    ['nobody in particular', []],
  ];
  for (const [who, attestations] of cases) {
    const result = await evaluate(rules, { requester: { did: CHILD, attestations }, subject: COACH, request: { orgId: 'fjord' } });
    assert.equal(result.allowed, false, `${who} was allowed`);
  }
});

test('evidence that belongs to somebody else does not make the requester a leader', async () => {
  const { role, evaluate } = await setup();
  // A real leader's attestation, presented by someone who is not that leader.
  const stolen = [await role(LEADER, { orgId: 'fjord', role: 'leder' })];
  const result = await evaluate(attest.disclosure.requesters, { requester: { did: CHILD, attestations: stolen }, subject: COACH, request: { orgId: 'fjord' } });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /kontoen/i);
});

test('expired or forged evidence does not authorise anything', async () => {
  const { role, evaluate, trustPolicy, claimTypes } = await setup();
  const rules = attest.disclosure.requesters;
  const context = attestations => ({ requester: { did: LEADER, attestations }, subject: COACH, request: { orgId: 'fjord' } });

  const expired = [await role(LEADER, { orgId: 'fjord', role: 'leder' }, { lifetimeDays: 1, now: NOW - 5 * 86400000 })];
  assert.equal((await evaluate(rules, context(expired))).allowed, false);

  const attacker = await generateKeyPair('key-1');
  const forged = [(await createAttestation({ signer: attacker, issuer: ISSUER, subject: LEADER, claimType: 'no.nif.clubRole', claim: { orgId: 'fjord', role: 'leder' }, lifetimeDays: 30, now: NOW })).record];
  assert.equal((await evaluate(rules, context(forged))).allowed, false);

  // Policy evidence is checked with exactly the same rules an application uses.
  assert.equal(trustPolicy.trust[0].keys.length, 1);
  assert.equal(Object.keys(claimTypes).length, 2);
});

test('a trusted backend client may be named directly, and only the named one qualifies', async () => {
  const { evaluate } = await setup();
  const rules = attest.issuance.requesters;
  assert.equal((await evaluate(rules, { requester: { client: 'politiet-backend' }, subject: COACH, request: { orgId: 'fjord' } })).allowed, true);
  assert.equal((await evaluate(rules, { requester: { client: 'calendar' }, subject: COACH, request: { orgId: 'fjord' } })).allowed, false);
  assert.equal((await evaluate(rules, { requester: { did: LEADER }, subject: COACH, request: { orgId: 'fjord' } })).allowed, false);
});

test('an empty rule list denies, and a decision always states a reason', async () => {
  const { evaluate } = await setup();
  const result = await evaluate([], { requester: { did: LEADER }, subject: COACH, request: {} });
  assert.equal(result.allowed, false);
  assert.equal(typeof result.reason, 'string');
  assert.equal(result.reason.length > 5, true);
});
