// A claim type is a declarative file. Adding one is a new descriptor, not new
// code, and the same descriptor drives issuance, disclosure and verification.
import { checkSchema, validate } from './schema.mjs';

// An NSID: lowercase reversed domain authority, then a name segment that may
// be camelCase, e.g. no.nif.instructorLicence.
const NSID = /^[a-z][a-z0-9]*(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+\.[a-zA-Z][a-zA-Z0-9]{0,62}$/;
const VISIBILITY = new Set(['public', 'restricted']);
const MODES = new Set(['public-record', 'query-only']);
const RULE_KINDS = new Set(['self', 'attestation', 'client']);
const bad = message => { throw new Error(`Claim type: ${message}`); };

function parseRule(rule, where) {
  if (!rule || typeof rule !== 'object' || !RULE_KINDS.has(rule.kind)) bad(`unknown requester rule kind "${rule?.kind}"`);
  if (rule.kind === 'attestation') {
    if (!NSID.test(rule.claimType || '')) bad('an attestation rule needs a claimType');
    if (rule.where !== undefined && (typeof rule.where !== 'object' || Array.isArray(rule.where) || rule.where === null)) bad('where must be an object');
    for (const value of Object.values(rule.where || {})) if (typeof value === 'string' && value.startsWith('$')) checkBinding(value, where);
  }
  if (rule.kind === 'client' && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(rule.client || '')) bad('a client rule needs a client id');
  return rule;
}

function checkBinding(expression, allowed) {
  const [root, ...rest] = expression.slice(1).split('.');
  if (root === 'subject') { if (rest.length) bad(`unsupported binding ${expression}`); return; }
  if (root !== 'request' || rest.length !== 1 || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(rest[0])) bad(`unsupported binding ${expression}`);
  if (allowed && !allowed.includes(rest[0])) bad(`${expression} does not name a property of this claim`);
}

export function parseDescriptor(input) {
  const d = input;
  if (!d || typeof d !== 'object') bad('descriptor must be an object');
  if (d.version !== 1) bad('unsupported descriptor version');
  if (!NSID.test(d.id || '')) bad(`"${d.id}" is not a valid claim type id`);
  if (!d.label || typeof d.label.nb !== 'string' || !d.label.nb) bad('a Norwegian label is required');
  if (typeof d.description !== 'string' || d.description.length < 10) bad('a description is required');
  if (!VISIBILITY.has(d.visibility)) bad('visibility must be "public" or "restricted"');
  if (!Number.isInteger(d.maxLifetimeDays) || d.maxLifetimeDays < 1 || d.maxLifetimeDays > 3650) bad('maxLifetimeDays must be 1-3650');
  if (d.claim?.type !== 'object') bad('claim schema must describe an object');
  checkSchema(d.claim);
  const fields = Object.keys(d.claim.properties || {});

  const issuance = d.issuance || {};
  if (!Array.isArray(issuance.requesters) || !issuance.requesters.length) bad('issuance.requesters must list at least one rule');
  issuance.requesters.forEach(rule => parseRule(rule, fields));

  const disclosure = d.disclosure || {};
  if (!MODES.has(disclosure.mode)) bad('disclosure.mode must be "public-record" or "query-only"');
  if (d.visibility === 'restricted' && disclosure.mode !== 'query-only') bad('a restricted claim cannot be published as a public record');
  if (d.visibility === 'public' && disclosure.mode !== 'public-record') bad('a public claim is disclosed as a public record');
  if (disclosure.mode === 'query-only') {
    if (!Array.isArray(disclosure.requesters) || !disclosure.requesters.length) bad('query-only disclosure must name who may ask');
    disclosure.requesters.forEach(rule => parseRule(rule, fields));
    if (!Array.isArray(disclosure.purposes) || !disclosure.purposes.length) bad('query-only disclosure must state its purposes');
  }
  if (d.subjectAssurance !== undefined && d.subjectAssurance !== null) {
    if (!NSID.test(d.subjectAssurance.claimType || '')) bad('subjectAssurance needs a claimType');
    parseRule({ kind: 'attestation', claimType: d.subjectAssurance.claimType, where: d.subjectAssurance.where }, fields);
  }
  return d;
}

export function validateClaim(claim, descriptor) {
  return validate(claim, descriptor.claim);
}

// A binding never resolves to undefined. An unresolved binding is a policy
// error, not a silently permissive comparison.
export function resolveBinding(expression, context) {
  if (typeof expression !== 'string' || !expression.startsWith('$')) return expression;
  const [root, field] = expression.slice(1).split('.');
  if (root === 'subject' && field === undefined) {
    if (!context.subject) throw new Error(`Binding ${expression} has no value in this request`);
    return context.subject;
  }
  const value = root === 'request' && field ? Object.prototype.hasOwnProperty.call(context.request || {}, field) ? context.request[field] : undefined : undefined;
  if (value === undefined || value === null) throw new Error(`Binding ${expression} has no value in this request`);
  return value;
}

export function matchWhere(claim, where, context) {
  for (const [field, expected] of Object.entries(where || {})) {
    let value;
    try { value = resolveBinding(expected, context); }
    catch (error) { return { ok: false, reason: error.message }; }
    if (!Object.prototype.hasOwnProperty.call(claim || {}, field) || claim[field] !== value)
      return { ok: false, reason: `expected ${field} to be ${JSON.stringify(value)}` };
  }
  return { ok: true };
}

export const CLAIM_TYPE_ID = NSID;
