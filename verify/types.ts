import type { webcrypto } from "node:crypto";
/** Shared contracts contain no issuer implementation or secrets. */
export type Claim = Record<string, unknown>;
export interface Schema {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  enum?: unknown[];
  const?: unknown;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: "datetime" | "did" | "uri";
  minimum?: number;
  maximum?: number;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  description?: string;
}
export type RequesterRule =
  | { kind: "self"; where?: never }
  | { kind: "client"; client: string; where?: never }
  | { kind: "attestation"; claimType: string; where?: Claim };
export interface Descriptor {
  version: 1;
  id: string;
  label: Record<string, string> & { nb: string };
  description: string;
  visibility: "public" | "restricted";
  maxLifetimeDays: number;
  claim: Schema;
  issuance: { requesters: RequesterRule[] };
  disclosure: {
    mode: "public-record" | "query-only";
    requesters?: RequesterRule[];
    purposes?: string[];
  };
  subjectAssurance?: { claimType: string; where?: Claim } | null;
}
export interface BindingContext {
  subject?: string;
  request?: Claim;
}
export interface Jwk extends webcrypto.JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}
export interface TrustEntry {
  issuer: string;
  claimTypes: string[];
  /** Literal constraints on signed claims, e.g. the organisation represented. */
  where?: Claim;
  keys?: Jwk[];
  repo?: string;
}
export interface TrustPolicy {
  version?: number;
  trust: TrustEntry[];
  maxClockSkewSeconds?: number;
  requireStatusCheck?: boolean;
  maxStatusAgeSeconds?: number;
}
export interface Payload {
  v: 1;
  id: string;
  iss: string;
  sub: string;
  claimType: string;
  claim: Claim;
  iat: string;
  exp: string;
  status: string;
  demo?: boolean;
}
export interface Attestation {
  id: string;
  issuer: string;
  subject: string;
  claimType: string;
  claim: Claim;
  issuedAt: string;
  expiresAt: string;
  statusUrl: string;
  demo?: boolean;
}
export interface AttestationView {
  claimType: string;
  subject: string;
  issuer: string;
  issuedAt: string;
  expiresAt: string;
  demo?: boolean;
}
export interface AttestationRecord {
  $type: string;
  version: number;
  jws: string;
  view: AttestationView;
}
export interface Expectation {
  subject?: string;
  claimType?: string;
  claim?: Claim;
  request?: Claim;
}
export type FetchStatus = (url: string) => Promise<unknown>;
export interface VerifyOptions {
  trustPolicy?: TrustPolicy;
  claimTypes?: Record<string, Descriptor>;
  now?: number;
  expect?: Expectation;
  uri?: string;
  fetchStatus?: FetchStatus;
  keys?: Jwk[];
}
export interface VerificationCheck {
  name: string;
  ok: boolean;
  detail?: string;
}
export type Verification =
  | {
      valid: true;
      reason: "active";
      checks: VerificationCheck[];
      attestation: Attestation;
    }
  | {
      valid: false;
      reason: string;
      checks: VerificationCheck[];
      attestation: Attestation | null;
    };
export type Match = { ok: true } | { ok: false; reason: string };
