import { matchWhere } from "../../verify/claim-type.ts";
import { verifyAttestation } from "../../verify/index.ts";
import type { RequesterRule } from "../../verify/types.ts";
import type { PolicyContext, Decision } from "../types.ts";

const MAX_EVIDENCE = 10;
function deny(reason: string): Decision {
  return { allowed: false, reason };
}
async function evaluateEvidence(
  rule: Extract<RequesterRule, { kind: "attestation" }>,
  context: PolicyContext,
): Promise<Decision> {
  const {
    requester = {},
    subject,
    request = {},
    trustPolicy,
    claimTypes,
    now = Date.now(),
  } = context;
  const evidence = (requester.attestations ?? []).slice(0, MAX_EVIDENCE);
  if (!requester.did) {
    return deny("Forespørselen mangler en konto som kan vise attestasjon.");
  }
  if (!evidence.length) {
    return deny(
      `Du må vise en gyldig ${rule.claimType} for å spørre om dette.`,
    );
  }
  let reason = `Ingen av attestasjonene dine oppfyller ${rule.claimType}.`;
  for (const record of evidence) {
    // One level of evidence, verified in full; no unbounded delegation chain.
    const result = await verifyAttestation(record, {
      claimTypes,
      fetchStatus: context.fetchStatus,
      now,
      trustPolicy,
    });
    if (!result.valid) {
      reason = `Attestasjonen kunne ikke bekreftes (${result.reason}).`;
      continue;
    }
    if (result.attestation.claimType !== rule.claimType) {
      continue;
    }
    if (result.attestation.subject !== requester.did) {
      reason = "Attestasjonen tilhører en annen konto enn kontoen som spør.";
      continue;
    }
    const match = matchWhere(result.attestation.claim, rule.where, {
      request,
      subject,
    });
    if (!match.ok) {
      reason = `Attestasjonen gjelder ikke denne forespørselen: ${match.reason}.`;
      continue;
    }
    return {
      allowed: true,
      matched: result.attestation,
      reason: `Bekreftet ${rule.claimType} for denne forespørselen.`,
      rule,
    };
  }
  return deny(reason);
}
/** Shared descriptor policy for issuance and restricted disclosure. */
export async function evaluateRequester(
  rules: RequesterRule[] | undefined,
  context: PolicyContext,
): Promise<Decision> {
  const { requester = {}, subject } = context;
  if (!Array.isArray(rules) || !rules.length) {
    return deny("Ingen regel gir tilgang til denne forespørselen.");
  }
  const reasons: string[] = [];
  for (const rule of rules) {
    if (rule.kind === "self") {
      if (requester.did && requester.did === subject) {
        return { allowed: true, reason: "Kontoen spør om seg selv.", rule };
      }
      reasons.push("Du kan ikke be om dette på vegne av en annen konto.");
      continue;
    }
    if (rule.kind === "client") {
      if (requester.client && requester.client === rule.client) {
        return {
          allowed: true,
          reason: `Klienten ${rule.client} er godkjent for denne forespørselen.`,
          rule,
        };
      }
      reasons.push(
        `Denne forespørselen er forbeholdt klienten ${rule.client}.`,
      );
      continue;
    }
    if (rule.kind !== "attestation") {
      reasons.push("Ukjent regeltype.");
      continue;
    }
    const decision = await evaluateEvidence(rule, context);
    if (decision.allowed) {
      return decision;
    }
    reasons.push(decision.reason);
  }
  return deny(reasons.join(" "));
}
