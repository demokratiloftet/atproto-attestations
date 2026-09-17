// Who may ask. Two questions use this: who may request that a claim be issued,
// and who may learn that a restricted claim exists. Both are answered from the
// claim-type descriptor, and evidence is checked with the same verify library a
// consuming application uses — the issuer gives itself no shortcut.
import { verifyAttestation } from '../../verify/index.mjs';
import { matchWhere } from '../../verify/claim-type.mjs';

const MAX_EVIDENCE = 10;

export async function evaluateRequester(rules, context) {
  const { requester = {}, subject, request = {}, trustPolicy, claimTypes, now = Date.now() } = context;
  if (!Array.isArray(rules) || !rules.length) return deny('Ingen regel gir tilgang til denne forespørselen.');
  const reasons = [];

  for (const rule of rules) {
    if (rule.kind === 'self') {
      if (requester.did && requester.did === subject) return { allowed: true, rule, reason: 'Kontoen spør om seg selv.' };
      reasons.push('Du kan ikke be om dette på vegne av en annen konto.');
      continue;
    }
    if (rule.kind === 'client') {
      if (requester.client && requester.client === rule.client) return { allowed: true, rule, reason: `Klienten ${rule.client} er godkjent for denne forespørselen.` };
      reasons.push(`Denne forespørselen er forbeholdt klienten ${rule.client}.`);
      continue;
    }
    if (rule.kind !== 'attestation') { reasons.push('Ukjent regeltype.'); continue; }

    const evidence = (requester.attestations || []).slice(0, MAX_EVIDENCE);
    if (!requester.did) { reasons.push('Forespørselen mangler en konto som kan vise attestasjon.'); continue; }
    if (!evidence.length) { reasons.push(`Du må vise en gyldig ${rule.claimType} for å spørre om dette.`); continue; }

    let best = `Ingen av attestasjonene dine oppfyller ${rule.claimType}.`;
    for (const record of evidence) {
      // Depth 1 on purpose: presented evidence is verified in full, but the
      // attestations behind it are not chased, so a decision stays explainable.
      const result = await verifyAttestation(record, { trustPolicy, claimTypes, now, fetchStatus: context.fetchStatus });
      if (!result.valid) { best = `Attestasjonen kunne ikke bekreftes (${result.reason}).`; continue; }
      if (result.attestation.claimType !== rule.claimType) continue;
      if (result.attestation.subject !== requester.did) { best = 'Attestasjonen tilhører en annen konto enn kontoen som spør.'; continue; }
      const match = matchWhere(result.attestation.claim, rule.where, { request, subject });
      if (!match.ok) { best = `Attestasjonen gjelder ikke denne forespørselen: ${match.reason}.`; continue; }
      return { allowed: true, rule, matched: result.attestation, reason: `Bekreftet ${rule.claimType} for denne forespørselen.` };
    }
    reasons.push(best);
  }
  return deny(reasons.join(' '));
}

const deny = reason => ({ allowed: false, reason });
