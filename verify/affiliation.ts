import { verifyAttestation } from "./attestation.ts";
import type { VerifyOptions } from "./types.ts";
import { isObject } from "./values.ts";

export interface StrongRef {
  uri: string;
  cid: string;
}
/** The resolver must verify the repository commit signature and record inclusion,
 * and check the current record CID. Never implement it as unverified JSON fetch. */
export type AuthenticatedRecordResolver = (
  reference: StrongRef,
) => Promise<Record<string, unknown>>;
export async function verifyPublicAffiliation(
  input: unknown,
  affiliation: StrongRef,
  acceptance: StrongRef,
  options: VerifyOptions & {
    organisationDid: string;
    readRecord: AuthenticatedRecordResolver;
  },
) {
  const result = await verifyAttestation(input, {
    ...options,
    expect: {
      ...options.expect,
      claim: {
        ...options.expect?.claim,
        organisationDid: options.organisationDid,
        visibility: "public",
      },
      claimType: "no.demokratiloftet.affiliation",
    },
    uri: affiliation.uri,
  });
  if (!result.valid) {
    return result;
  }
  const fail = (reason: string) => ({
    attestation: result.attestation,
    checks: [
      ...result.checks,
      { detail: reason, name: "mutual-acceptance", ok: false },
    ],
    reason,
    valid: false as const,
  });
  const { claim } = result.attestation;
  const now = options.now ?? Date.now();
  if (
    typeof claim.validFrom !== "string" ||
    typeof claim.expiresAt !== "string" ||
    Date.parse(claim.validFrom) > now ||
    Date.parse(claim.expiresAt) <= now
  ) {
    return fail("affiliation-window");
  }
  if (
    !affiliation.uri.startsWith(
      `at://${options.organisationDid}/no.demokratiloftet.attestation/`,
    ) ||
    !acceptance.uri.startsWith(
      `at://${result.attestation.subject}/no.demokratiloftet.affiliation.acceptance/`,
    )
  ) {
    return fail("wrong-repository");
  }
  try {
    const [published, accepted] = await Promise.all([
      options.readRecord(affiliation),
      options.readRecord(acceptance),
    ]);
    if (!isObject(input) || published.jws !== input.jws) {
      return fail("changed-attestation");
    }
    if (
      accepted.$type !== "no.demokratiloftet.affiliation.acceptance" ||
      accepted.subject !== result.attestation.subject ||
      accepted.revision !== claim.revision ||
      !isObject(accepted.affiliation) ||
      accepted.affiliation.uri !== affiliation.uri ||
      accepted.affiliation.cid !== affiliation.cid
    ) {
      return fail("acceptance-mismatch");
    }
  } catch {
    return fail("repository-unavailable-or-changed");
  }
  return {
    ...result,
    checks: [
      ...result.checks,
      {
        detail: "Both repositories authenticate the same version.",
        name: "mutual-acceptance",
        ok: true,
      },
    ],
  };
}
