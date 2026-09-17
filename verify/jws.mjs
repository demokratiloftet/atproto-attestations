// Compact JWS over ES256. The signed bytes are the only source of truth about
// an attestation: nothing outside this token is trusted, and no algorithm other
// than ES256 is accepted, so an "alg: none" token can never verify.
const ALG = 'ES256';
const TYP = 'attest+jws';
const PART = /^[A-Za-z0-9_-]*$/;
const fail = message => { throw new Error(message); };

export const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

export function decodeCompact(token) {
  if (typeof token !== 'string' || token.length > 16384) fail('Invalid token');
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every(p => PART.test(p)) || !parts[0] || !parts[1]) fail('Invalid token');
  const json = part => {
    let value;
    try { value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); }
    catch { fail('Invalid token encoding'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid token structure');
    return value;
  };
  return { header: json(parts[0]), payload: json(parts[1]), signing: `${parts[0]}.${parts[1]}`, signature: parts[2] };
}

export async function importVerifyKey(jwk) {
  if (jwk?.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') fail('Unsupported key');
  if (jwk.d) fail('Refusing to verify with a private key');
  return crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

// Returns the verified payload. Keys are matched by kid; a token whose kid is
// absent from the accepted set is rejected rather than tried against every key.
export async function verifyCompact(token, jwks) {
  const { header, payload, signing, signature } = decodeCompact(token);
  if (header.alg !== ALG) fail(`Unsupported signature algorithm: ${String(header.alg).slice(0, 32)}`);
  if (header.typ !== TYP) fail('Unexpected token type');
  if (header.crit) fail('Unsupported critical header');
  const candidates = (jwks || []).filter(jwk => jwk?.kid === header.kid);
  if (!candidates.length) fail(`No usable key for kid ${JSON.stringify(String(header.kid ?? '').slice(0, 64))}`);
  const bytes = Buffer.from(signature, 'base64url');
  for (const jwk of candidates) {
    const key = await importVerifyKey(jwk);
    if (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes, Buffer.from(signing)))
      return payload;
  }
  fail('Invalid signature');
}

// RFC 7638 thumbprint: identifies the key material, not the label put on it.
export async function thumbprint(jwk) {
  const digest = await crypto.subtle.digest('SHA-256', Buffer.from(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));
  return Buffer.from(digest).toString('base64url');
}

export const ALGORITHM = ALG;
export const TOKEN_TYPE = TYP;
