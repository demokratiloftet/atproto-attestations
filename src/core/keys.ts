import type { IssuerOptions } from "../types.ts";
import type { TrustPolicy } from "../../verify/types.ts";
// The signing key is the organisation's authority. It is generated once, kept
// private to the service, and never leaves it; only the public half is served.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPair, importSigningKey, publicPart } from "./sign.ts";

export async function loadSigner({
  directory,
  kid = "key-1",
  privateJwk,
}: {
  directory: string;
  kid?: string;
  privateJwk?: unknown;
}) {
  if (privateJwk)
    return importSigningKey(
      typeof privateJwk === "string" ? JSON.parse(privateJwk) : privateJwk,
    );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "signing-key.json");
  try {
    return await importSigningKey(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    const generated = await generateKeyPair(kid);
    writeFileSync(file, JSON.stringify(generated.privateJwk, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    return generated;
  }
}

// Served at /.well-known/attestation-issuer.json. A verifier that has not
// pinned keys finds them here; a verifier that has pinned them ignores it.
export function issuerDocument({
  issuer,
  name,
  signer,
  claimTypes,
  repo,
  contact,
  demo,
}: Pick<
  IssuerOptions,
  "issuer" | "name" | "signer" | "claimTypes" | "repo" | "contact" | "demo"
>) {
  return {
    version: 1,
    issuer,
    name,
    ...(demo ? { demo: true } : {}),
    ...(contact ? { contact } : {}),
    keys: [publicPart(signer.privateJwk)],
    ...(repo ? { atprotoRepo: repo } : {}),
    statusEndpoint: new URL("/status/", new URL(issuer).origin).href,
    queryEndpoint: new URL("/query", new URL(issuer).origin).href,
    claimTypes: Object.values(claimTypes).map((d) => ({
      id: d.id,
      label: d.label,
      visibility: d.visibility,
      description: d.description,
    })),
  };
}

// What a consuming application should put in its trust policy to accept us.
export function suggestedTrustPolicy({
  issuer,
  signer,
  claimTypes,
  repo,
}: Pick<
  IssuerOptions,
  "issuer" | "signer" | "claimTypes" | "repo"
>): TrustPolicy {
  return {
    version: 1,
    maxClockSkewSeconds: 60,
    requireStatusCheck: true,
    trust: [
      {
        claimTypes: Object.keys(claimTypes),
        issuer,
        keys: [publicPart(signer.privateJwk)],
        ...(repo ? { repo } : {}),
      },
    ],
  };
}
