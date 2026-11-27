import type {
  AttestationRecord,
  Descriptor,
  TrustPolicy,
} from "../../verify/types.ts";

export const AFFILIATION = "no.demokratiloftet.affiliation";
export const ACCEPTANCE = "no.demokratiloftet.affiliation.acceptance";
export const PERMISSION = "no.demokratiloftet.permission";
export const APPROVER = "no.demokratiloftet.affiliation.approver";
export const EVENT = "no.demokratiloftet.pilot.event";
export const ACTION = "events.publish";
export interface Person {
  did: string;
  handle: string;
  name: string;
}
export interface Organisation {
  did: string;
  name: string;
  domain?: string;
  description: string;
  approvers: string[];
  issuerHandle: string;
  issuerPassword: string;
  scopes: string[];
}
export interface PilotConfig {
  origin: string;
  pds: string;
  pdsCanonical?: string;
  plc: string;
  dataDir: string;
  people: Person[];
  organisations: Organisation[];
  sandbox: true;
}
export interface Terms {
  subject: string;
  organisationDid: string;
  relationship: string;
  roleId: string;
  roleLabel: string;
  scope: string;
  validFrom: string;
  expiresAt: string;
  visibility: "public" | "private";
}
export interface Ref {
  uri: string;
  cid: string;
}
export interface Proposal {
  id: string;
  revision: number;
  terms: Terms;
  createdBy: string;
  createdAt: string;
  subjectApproved: boolean;
  organisationApprovedBy?: string;
  state: "pending" | "publishing" | "active" | "declined" | "revoked";
  record?: AttestationRecord;
  ref?: Ref;
  acceptance?: Record<string, unknown>;
  acceptanceRef?: Ref;
  error?: string;
}
export interface Grant {
  id: string;
  proposalId: string;
  proposalRevision: number;
  subject: string;
  organisationDid: string;
  action: string;
  scope: string;
  expiresAt: string;
  record: AttestationRecord;
  revoked: boolean;
}
export interface PublishedEvent {
  id: string;
  title: string;
  startsAt: string;
  actor: string;
  organisationDid: string;
  scope: string;
  grantId: string;
  createdAt: string;
  record: Record<string, unknown>;
  ref?: Ref;
  state: "publishing" | "published" | "cancelled";
}
export interface AcceptanceRecord {
  $type: typeof ACCEPTANCE;
  affiliation: Ref;
  subject: string;
  revision: number;
  createdAt: string;
}
export interface Repository {
  login(
    identifier: string,
    password: string,
  ): Promise<{ did: string; handle: string }>;
  put(
    did: string,
    collection: string,
    key: string,
    record: Record<string, unknown>,
  ): Promise<Ref>;
  read(ref: Ref): Promise<Record<string, unknown>>;
  remove(did: string, collection: string, key: string): Promise<void>;
}
export interface Policy {
  trustPolicy: TrustPolicy;
  claimTypes: Record<string, Descriptor>;
}
