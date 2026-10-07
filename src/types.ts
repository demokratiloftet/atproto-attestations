import type {
  Claim,
  Descriptor,
  Payload,
  Attestation,
  AttestationRecord,
  RequesterRule,
  TrustPolicy,
  Verification,
  FetchStatus,
  Jwk,
} from "../verify/types.ts";
import type { IssuerStore } from "./core/store.ts";
export interface Signer {
  kid: string;
  privateJwk: Jwk;
  publicJwk: Jwk;
  key: CryptoKey;
}
export interface Requester {
  did?: string;
  client?: string;
  attestations?: unknown[];
}
export interface Request {
  claimType: string;
  subject: string;
  request?: Claim;
  requester?: Requester;
  subjectAttestations?: unknown[];
}
export interface RevokeRequest {
  id?: string;
  claimType?: string;
  subject?: string;
  requester?: Requester;
}
export interface PolicyContext {
  requester?: Requester;
  subject: string;
  request?: Claim;
  trustPolicy: TrustPolicy;
  claimTypes: Record<string, Descriptor>;
  now?: number;
  fetchStatus?: FetchStatus;
}
export type Decision =
  | {
      allowed: true;
      rule: RequesterRule;
      reason: string;
      matched?: Attestation;
    }
  | { allowed: false; reason: string };
export interface Publication {
  uri?: string;
  cid?: string;
}
export interface Publisher {
  id?: string;
  publish(record: AttestationRecord): Promise<Publication>;
  remove(uri: string): Promise<unknown>;
  describe(): Promise<{ repo?: string; service?: string }>;
}
export interface AdapterRequest {
  claimType: string;
  subject: string;
  request: Claim;
  requester?: Requester;
  evidence?: Verification[];
}
export type AdapterAnswer =
  | { granted: false; reason: string }
  | { granted: true; claim: Claim; maxLifetimeDays?: number };
export interface Adapter {
  check(request: AdapterRequest): Promise<AdapterAnswer>;
}
export interface IssuerOptions {
  issuer: string;
  name: string;
  signer: Signer;
  store: IssuerStore;
  claimTypes: Record<string, Descriptor>;
  adapter: Adapter;
  publisher: Publisher;
  repo?: string;
  contact?: string;
  demo?: boolean;
  now?: () => number;
}
export interface AttestationOptions {
  signer: Signer;
  issuer: string;
  subject: string;
  claimType: string;
  claim: Claim;
  lifetimeDays: number;
  now?: number;
  id?: string;
  demo?: boolean;
}
export interface Minted {
  payload: Payload;
  jws: string;
  record: AttestationRecord;
}
export interface StoredAttestation {
  id: string;
  claimType: string;
  subject: string;
  claim: Claim;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string | null;
  visibility: "public" | "restricted";
  jws: string;
  uri?: string | null;
  cid?: string | null;
}
export interface AuditEntry {
  action: string;
  outcome: string;
  actor?: string;
  claimType?: string;
  subject?: string;
  detail?: string | null;
}
export interface Person {
  identity?: { assuranceLevel?: string; provider?: string; method?: string };
  clubs?: { orgId: string; orgName: string; role: string }[];
  licences?: {
    discipline: string;
    level: string;
    orgId?: string;
    expiresAt?: string;
  }[];
  attests?: { orgId: string }[];
}
export interface Client {
  id: string;
  token: string;
  scopes: string[];
}
