// Signing lives with the issuer. Consuming applications install verify/ only,
// and therefore never hold code that can produce an attestation.
import { encode, ALGORITHM, TOKEN_TYPE } from '../../verify/jws.mjs';

const KID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export async function generateKeyPair(kid) {
  if (!KID.test(kid || '')) throw new Error('Key id must be 1-64 characters of [A-Za-z0-9._-]');
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = { ...await crypto.subtle.exportKey('jwk', pair.privateKey), kid, alg: ALGORITHM, use: 'sig' };
  return { kid, privateJwk, publicJwk: publicPart(privateJwk), key: pair.privateKey };
}

export function publicPart(jwk) {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid: jwk.kid, alg: ALGORITHM, use: 'sig' };
}

export async function importSigningKey(privateJwk) {
  if (!privateJwk?.d) throw new Error('A signing key must be a private JWK');
  if (!KID.test(privateJwk.kid || '')) throw new Error('Signing key is missing a usable kid');
  const key = await crypto.subtle.importKey('jwk', { ...privateJwk, key_ops: ['sign'], ext: false }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return { kid: privateJwk.kid, privateJwk, publicJwk: publicPart(privateJwk), key };
}

export async function signCompact(signer, payload) {
  const key = signer.key ?? (await importSigningKey(signer.privateJwk)).key;
  const signing = `${encode({ alg: ALGORITHM, kid: signer.kid, typ: TOKEN_TYPE })}.${encode(payload)}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(signing));
  return `${signing}.${Buffer.from(signature).toString('base64url')}`;
}
