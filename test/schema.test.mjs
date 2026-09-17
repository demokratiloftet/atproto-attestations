import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../verify/schema.mjs';
import { parseDescriptor, matchWhere, resolveBinding } from '../verify/claim-type.mjs';

const licence = {
  type: 'object', additionalProperties: false,
  required: ['discipline', 'level'],
  properties: {
    discipline: { type: 'string', enum: ['svomming', 'ski'] },
    level: { type: 'string', minLength: 1, maxLength: 40 },
    orgId: { type: 'string', pattern: '^[a-z0-9-]{1,40}$' },
    issuedCount: { type: 'integer', minimum: 0, maximum: 10 },
    tags: { type: 'array', maxItems: 3, items: { type: 'string' } },
    validFrom: { type: 'string', format: 'datetime' },
  },
};

test('a claim payload is accepted only when it matches the declared schema', () => {
  assert.deepEqual(validate({ discipline: 'svomming', level: 'instruktor-2' }, licence), []);
  assert.deepEqual(validate({ discipline: 'svomming', level: 'a', orgId: 'fjord', issuedCount: 3, tags: ['x'], validFrom: '2026-09-17T10:00:00Z' }, licence), []);
});

test('every rejection names the field that failed', () => {
  const cases = [
    [{ level: 'a' }, 'discipline'],
    [{ discipline: 'svomming' }, 'level'],
    [{ discipline: 'padling', level: 'a' }, 'discipline'],
    [{ discipline: 'svomming', level: '' }, 'level'],
    [{ discipline: 'svomming', level: 'a', orgId: 'FJORD' }, 'orgId'],
    [{ discipline: 'svomming', level: 'a', issuedCount: 11 }, 'issuedCount'],
    [{ discipline: 'svomming', level: 'a', issuedCount: 1.5 }, 'issuedCount'],
    [{ discipline: 'svomming', level: 'a', tags: ['a', 'b', 'c', 'd'] }, 'tags'],
    [{ discipline: 'svomming', level: 'a', validFrom: 'someday' }, 'validFrom'],
    [{ discipline: 'svomming', level: 'a', surprise: true }, 'surprise'],
  ];
  for (const [value, field] of cases) {
    const errors = validate(value, licence);
    assert.equal(errors.length > 0, true, `accepted ${JSON.stringify(value)}`);
    assert.match(errors.join(' '), new RegExp(field), `wrong field for ${JSON.stringify(value)}`);
  }
});

test('__proto__ and prototype pollution attempts are not treated as valid claims', () => {
  const payload = JSON.parse('{"discipline":"svomming","level":"a","__proto__":{"admin":true}}');
  assert.deepEqual(validate(payload, licence), []);
  assert.equal(({}).admin, undefined);
});

const descriptor = {
  version: 1, id: 'no.nif.clubRole', label: { nb: 'Klubbrolle' }, description: 'Rolle i et idrettslag.',
  visibility: 'public', maxLifetimeDays: 180,
  claim: { type: 'object', additionalProperties: false, required: ['orgId', 'role'], properties: { orgId: { type: 'string' }, role: { type: 'string', enum: ['leder', 'trener', 'medlem'] } } },
  issuance: { requesters: [{ kind: 'self' }, { kind: 'attestation', claimType: 'no.nif.clubRole', where: { role: 'leder', orgId: '$request.orgId' } }] },
  disclosure: { mode: 'public-record' },
};

test('a descriptor is parsed, and a broken one is refused at load time', () => {
  assert.equal(parseDescriptor(descriptor).id, 'no.nif.clubRole');
  const broken = [
    { ...descriptor, id: 'Not An NSID' },
    { ...descriptor, visibility: 'secret' },
    { ...descriptor, maxLifetimeDays: 0 },
    { ...descriptor, claim: { type: 'string' } },
    { ...descriptor, issuance: { requesters: [] } },
    { ...descriptor, issuance: { requesters: [{ kind: 'whoever' }] } },
    { ...descriptor, issuance: { requesters: [{ kind: 'attestation' }] } },
    // A restricted claim must not be publishable as a public record.
    { ...descriptor, visibility: 'restricted', disclosure: { mode: 'public-record' } },
    // Query-only disclosure without a requester rule would answer anyone.
    { ...descriptor, visibility: 'restricted', disclosure: { mode: 'query-only' } },
  ];
  for (const value of broken) assert.throws(() => parseDescriptor(value), Error, `accepted ${JSON.stringify(value).slice(0, 80)}`);
});

test('bindings resolve from the request, and an unknown binding is an error, never undefined', () => {
  const context = { request: { orgId: 'fjord' }, subject: 'did:plc:subject' };
  assert.equal(resolveBinding('$request.orgId', context), 'fjord');
  assert.equal(resolveBinding('$subject', context), 'did:plc:subject');
  assert.equal(resolveBinding('leder', context), 'leder');
  for (const bad of ['$request.missing', '$nonsense', '$request.__proto__']) assert.throws(() => resolveBinding(bad, context));
});

test('where-matching binds a delegate to the club named in the request', () => {
  const where = { role: 'leder', orgId: '$request.orgId' };
  const context = { request: { orgId: 'fjord' }, subject: 'did:plc:coach' };
  assert.equal(matchWhere({ role: 'leder', orgId: 'fjord' }, where, context).ok, true);
  assert.equal(matchWhere({ role: 'leder', orgId: 'marka' }, where, context).ok, false);
  assert.equal(matchWhere({ role: 'trener', orgId: 'fjord' }, where, context).ok, false);
  assert.equal(matchWhere({ orgId: 'fjord' }, where, context).ok, false);
});
