import { webcrypto } from "node:crypto";

import type { Jwk } from "./types.ts";
import { isObject, object } from "./values.ts";
// Compact JWS over ES256. The signed bytes are the only source of truth about
// an attestation: nothing outside this token is trusted, and no algorithm other
// than ES256 is accepted, so an "alg: none" token can never verify.
const ALG = "ES256";
const PART = /^[A-Za-z0-9_-]*$/u;
const TYP = "attest+jws";
function fail(message: string): never {
  throw new Error(message);
}

export const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export function decodeCompact(token: unknown) {
  if (typeof token !== "string" || token.length > 16_384) {
    fail("Invalid token");
  }
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    !parts.every((p) => PART.test(p)) ||
    !parts[0] ||
    !parts[1]
  ) {
    fail("Invalid token");
  }
  const json = (part: string): Record<string, unknown> => {
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));
    } catch {
      fail("Invalid token encoding");
    }
    if (!isObject(value)) {
      fail("Invalid token structure");
    }
    return value;
  };
  return {
    header: json(parts[0]),
    payload: json(parts[1]),
    signature: parts[2],
    signing: `${parts[0]}.${parts[1]}`,
  };
}

export async function importVerifyKey(
  input: unknown,
): Promise<webcrypto.CryptoKey> {
  const jwk = object(input, "key");
  if (
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" ||
    typeof jwk.y !== "string"
  ) {
    fail("Unsupported key");
  }
  if (jwk.d) {
    fail("Refusing to verify with a private key");
  }
  return webcrypto.subtle.importKey(
    "jwk",
    { crv: "P-256", ext: true, kty: "EC", x: jwk.x, y: jwk.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

// Returns the verified payload. Keys are matched by kid; a token whose kid is
// absent from the accepted set is rejected rather than tried against every key.
export async function verifyCompact(
  token: unknown,
  jwks: Jwk[],
): Promise<Record<string, unknown>> {
  const { header, payload, signing, signature } = decodeCompact(token);
  if (header.alg !== ALG) {
    fail(`Unsupported signature algorithm: ${String(header.alg).slice(0, 32)}`);
  }
  if (header.typ !== TYP) {
    fail("Unexpected token type");
  }
  if (header.crit) {
    fail("Unsupported critical header");
  }
  const candidates = (jwks || []).filter((jwk) => jwk?.kid === header.kid);
  if (!candidates.length) {
    fail(
      `No usable key for kid ${(JSON.stringify(header.kid) ?? "missing").slice(0, 64)}`,
    );
  }
  const bytes = Buffer.from(signature, "base64url");
  for (const jwk of candidates) {
    const key = await importVerifyKey(jwk);
    if (
      await webcrypto.subtle.verify(
        { hash: "SHA-256", name: "ECDSA" },
        key,
        bytes,
        Buffer.from(signing),
      )
    ) {
      return payload;
    }
  }
  fail("Invalid signature");
}

// RFC 7638 thumbprint: identifies the key material, not the label put on it.
export async function thumbprint(jwk: Jwk) {
  const digest = await webcrypto.subtle.digest(
    "SHA-256",
    Buffer.from(
      JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }),
    ),
  );
  return Buffer.from(digest).toString("base64url");
}

export const ALGORITHM = ALG;
export const TOKEN_TYPE = TYP;
