// Builds the signed objects. The record published to a repository is a thin
// wrapper: the JWS carries every fact, and `view` exists only so a human
// browsing a repository can read it.
import { randomUUID } from "node:crypto";

import { RECORD_TYPE } from "../../verify/record.ts";
import type { Payload } from "../../verify/types.ts";
import type { AttestationOptions, Minted, Signer } from "../types.ts";
import { signCompact } from "./sign.ts";

export { RECORD_TYPE } from "../../verify/record.ts";
const DAY = 86_400_000;

export async function createAttestation({
  signer,
  issuer,
  subject,
  claimType,
  claim,
  lifetimeDays,
  now = Date.now(),
  id = randomUUID(),
  demo = true,
}: AttestationOptions): Promise<Minted> {
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + lifetimeDays * DAY).toISOString();
  const payload: Payload = {
    claim,
    claimType,
    exp: expiresAt,
    iat: issuedAt,
    id,
    iss: issuer,
    status: statusUrl(issuer, id),
    sub: subject,
    v: 1,
    ...(demo ? { demo: true } : {}),
  };
  const jws = await signCompact(signer, payload);
  return {
    jws,
    payload,
    record: {
      $type: RECORD_TYPE,
      jws,
      version: 1,
      view: {
        claimType,
        expiresAt,
        issuedAt,
        issuer,
        subject,
        ...(demo ? { demo: true } : {}),
      },
    },
  };
}

// The status answer is signed too, so a revocation cannot be suppressed or
// faked by whoever sits between the application and the issuer.
export async function createStatus({
  signer,
  issuer,
  id,
  state,
  now = Date.now(),
}: {
  signer: Signer;
  issuer: string;
  id: string;
  state: string;
  now?: number;
}) {
  const payload = {
    at: new Date(now).toISOString(),
    id,
    iss: issuer,
    status: state,
    typ: "status",
    v: 1,
  };
  return { jws: await signCompact(signer, payload), payload };
}

export function statusUrl(issuer: string, id: string) {
  const base = new URL(issuer);
  return new URL(`/status/${encodeURIComponent(id)}`, base.origin).href;
}
