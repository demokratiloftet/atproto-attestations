import { parseDescriptor } from "../../verify/claim-type.ts";
import type { Descriptor, Schema } from "../../verify/types.ts";
import { AFFILIATION, APPROVER, PERMISSION } from "./types.ts";

const string: Schema = { maxLength: 300, minLength: 1, type: "string" };
function descriptor(
  id: string,
  label: string,
  properties: Record<string, Schema>
): Descriptor {
  return parseDescriptor({
    claim: {
      additionalProperties: false,
      properties,
      required: Object.keys(properties),
      type: "object",
    },
    description:
      "Generisk, organisasjonsavgrenset attestasjon for den isolerte tilknytningspiloten.",
    disclosure: { mode: "public-record" },
    id,
    issuance: { requesters: [{ client: "approved-workflow", kind: "client" }] },
    label: { nb: label },
    maxLifetimeDays: 365,
    version: 1,
    visibility: "public",
  });
}
export const descriptors: Record<string, Descriptor> = {
  [AFFILIATION]: descriptor(AFFILIATION, "Bekreftet tilknytning", {
    expiresAt: { format: "datetime", type: "string" },
    organisationDid: string,
    proposalId: string,
    relationship: string,
    revision: { minimum: 1, type: "integer" },
    roleId: string,
    roleLabel: string,
    scope: string,
    validFrom: { format: "datetime", type: "string" },
    visibility: { enum: ["public", "private"], type: "string" },
  }),
  [APPROVER]: descriptor(APPROVER, "Organisasjonens godkjenner", {
    action: { const: "affiliations.review", type: "string" },
    organisationDid: string,
  }),
  [PERMISSION]: descriptor(PERMISSION, "Avgrenset fullmakt", {
    action: { const: "events.publish", type: "string" },
    organisationDid: string,
    proposalId: string,
    proposalRevision: { minimum: 1, type: "integer" },
    scope: string,
  }),
};
/** These policy bindings are shared by the workflow and consuming action. */
export const reviewRules = [
  {
    claimType: APPROVER,
    kind: "attestation" as const,
    where: {
      action: "affiliations.review",
      organisationDid: "$request.organisationDid",
    },
  },
];
export const publishRules = [
  {
    claimType: PERMISSION,
    kind: "attestation" as const,
    where: {
      action: "events.publish",
      organisationDid: "$request.organisationDid",
      scope: "$request.scope",
    },
  },
];
