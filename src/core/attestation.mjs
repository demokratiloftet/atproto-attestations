// Builds the signed objects. The record published to a repository is a thin
// wrapper: the JWS carries every fact, and `view` exists only so a human
// browsing a repository can read it.
import { randomUUID } from 'node:crypto';
import { signCompact } from './sign.mjs';
import { RECORD_TYPE } from '../../verify/record.mjs';

export { RECORD_TYPE };
const DAY = 86400000;

export async function createAttestation({ signer, issuer, subject, claimType, claim, lifetimeDays, now = Date.now(), id = randomUUID(), demo = true }) {
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + lifetimeDays * DAY).toISOString();
  const payload = {
    v: 1, id, iss: issuer, sub: subject, claimType, claim,
    iat: issuedAt, exp: expiresAt, status: statusUrl(issuer, id), ...(demo ? { demo: true } : {}),
  };
  const jws = await signCompact(signer, payload);
  return {
    payload, jws,
    record: { $type: RECORD_TYPE, version: 1, jws, view: { claimType, subject, issuedAt, expiresAt, issuer, ...(demo ? { demo: true } : {}) } },
  };
}

// The status answer is signed too, so a revocation cannot be suppressed or
// faked by whoever sits between the application and the issuer.
export async function createStatus({ signer, issuer, id, state, now = Date.now() }) {
  const payload = { v: 1, typ: 'status', id, iss: issuer, status: state, at: new Date(now).toISOString() };
  return { payload, jws: await signCompact(signer, payload) };
}

export function statusUrl(issuer, id) {
  const base = new URL(issuer);
  return new URL(`/status/${encodeURIComponent(id)}`, base.origin).href;
}
