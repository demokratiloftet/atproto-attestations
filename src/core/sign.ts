// Signing lives with the issuer. Consuming applications install verify/ only,
// and therefore never hold code that can produce an attestation.
import { encode, ALGORITHM, TOKEN_TYPE } from "../../verify/jws.ts";
import type { Jwk } from "../../verify/types.ts";
import { object } from "../../verify/values.ts";
import type { Signer } from "../types.ts";

const KID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;

export async function generateKeyPair(kid: string): Promise<Signer> {
  if (!KID.test(kid || "")) {
    throw new Error("Key id must be 1-64 characters of [A-Za-z0-9._-]");
  }
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const privateJwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.privateKey)),
    alg: ALGORITHM,
    kid,
    use: "sig",
  };
  return {
    key: pair.privateKey,
    kid,
    privateJwk,
    publicJwk: publicPart(privateJwk),
  };
}

export function publicPart(jwk: Jwk): Jwk {
  return {
    alg: ALGORITHM,
    crv: jwk.crv,
    kid: jwk.kid,
    kty: jwk.kty,
    use: "sig",
    x: jwk.x,
    y: jwk.y,
  };
}

export async function importSigningKey(input: unknown): Promise<Signer> {
  const raw = object(input, "signing key");
  if (
    typeof raw.d !== "string" ||
    typeof raw.kid !== "string" ||
    raw.kty !== "EC" ||
    raw.crv !== "P-256" ||
    typeof raw.x !== "string" ||
    typeof raw.y !== "string"
  ) {
    throw new Error("A signing key must be a private P-256 JWK with a kid");
  }
  const privateJwk: Jwk & { kid: string } = {
    crv: raw.crv,
    d: raw.d,
    kid: raw.kid,
    kty: raw.kty,
    x: raw.x,
    y: raw.y,
  };
  if (!privateJwk.d) {
    throw new Error("A signing key must be a private JWK");
  }
  if (!KID.test(privateJwk.kid || "")) {
    throw new Error("Signing key is missing a usable kid");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    { ...privateJwk, ext: false, key_ops: ["sign"] },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  return {
    key,
    kid: privateJwk.kid,
    privateJwk,
    publicJwk: publicPart(privateJwk),
  };
}

export async function signCompact(signer: Signer, payload: unknown) {
  const key = signer.key ?? (await importSigningKey(signer.privateJwk)).key;
  const signing = `${encode({ alg: ALGORITHM, kid: signer.kid, typ: TOKEN_TYPE })}.${encode(payload)}`;
  const signature = await crypto.subtle.sign(
    { hash: "SHA-256", name: "ECDSA" },
    key,
    Buffer.from(signing)
  );
  return `${signing}.${Buffer.from(signature).toString("base64url")}`;
}
