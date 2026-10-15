import type { Terms } from "../../src/pilot/types.ts";

interface ProposalFields {
  subject: string;
  roleLabel: string;
  relationship: string;
  scope: string;
  visibility: "public" | "private";
  duration: "7" | "30" | "90" | "keep";
}
interface ProposalContext {
  organisationDid: string;
  previous?: Terms;
  roles: Pick<Terms, "roleLabel" | "roleId">[];
}
const normaliseRole = (label: string) =>
  label.trim().normalize("NFC").toLocaleLowerCase("nb-NO");
async function roleCode(label: string, context: ProposalContext) {
  if (
    context.previous &&
    normaliseRole(label) === normaliseRole(context.previous.roleLabel)
  ) {
    return context.previous.roleId;
  }
  const matches = new Set(
    context.roles
      .filter((role) => normaliseRole(role.roleLabel) === normaliseRole(label))
      .map((role) => role.roleId)
  );
  if (matches.size === 1) {
    const [code] = matches;
    return code;
  }
  // A full digest avoids conflating different labels after removing accents or punctuation.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normaliseRole(label))
  );
  return `role.${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export async function proposalTerms(
  fields: ProposalFields,
  context: ProposalContext,
  now = Date.now()
): Promise<Terms> {
  const roleLabel = fields.roleLabel.trim();
  if (!roleLabel) {
    throw new Error("Enter a role.");
  }
  if (
    !["7", "30", "90", "keep"].includes(fields.duration) ||
    (fields.duration === "keep" && !context.previous)
  ) {
    throw new Error("Choose how long the affiliation should last.");
  }
  const validFrom = Math.max(
    now,
    Date.parse(context.previous?.validFrom ?? new Date(now).toISOString())
  );
  const expiresAt =
    fields.duration === "keep" && context.previous
      ? context.previous.expiresAt
      : new Date(now + Number(fields.duration) * 86_400_000).toISOString();
  if (Date.parse(expiresAt) <= validFrom) {
    throw new Error("Choose a duration that ends after the start date.");
  }
  return {
    expiresAt,
    organisationDid: context.organisationDid,
    relationship: fields.relationship,
    roleId: await roleCode(roleLabel, context),
    roleLabel,
    scope: fields.scope,
    subject: context.previous?.subject ?? fields.subject,
    validFrom: new Date(validFrom).toISOString(),
    visibility: fields.visibility,
  };
}
