import { randomUUID } from "node:crypto";

import type { Person, Organisation, Proposal, Terms } from "./types.ts";

export function refuse(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
function containsControlCharacter(value: string) {
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) < 32) {
      return true;
    }
  }
  return false;
}
export function text(
  input: Record<string, unknown>,
  key: string,
  max = 120
): string {
  const value = input[key];
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    containsControlCharacter(value)
  ) {
    refuse(`Ugyldig ${key}.`);
  }
  return value.trim();
}
export function parseTerms(
  input: Record<string, unknown>,
  people: Person[],
  orgs: Organisation[],
  now = Date.now()
): Terms {
  const allowed = new Set([
    "subject",
    "organisationDid",
    "relationship",
    "roleId",
    "roleLabel",
    "scope",
    "validFrom",
    "expiresAt",
    "visibility",
  ]);
  if (Object.keys(input).some((k) => !allowed.has(k))) {
    refuse("Ukjent felt i forslaget.");
  }
  const subject = text(input, "subject", 200);
  const organisationDid = text(input, "organisationDid", 200);
  if (!people.some((p) => p.did === subject)) {
    refuse("Personen må være registrert i piloten.");
  }
  const org = orgs.find((o) => o.did === organisationDid);
  if (!org) {
    refuse("Organisasjonen er ikke registrert.");
  }
  const relationship = text(input, "relationship");
  if (
    ![
      "employee",
      "contractor",
      "member",
      "volunteer",
      "electedRepresentative",
    ].includes(relationship)
  ) {
    refuse("Ukjent tilknytningstype.");
  }
  const roleId = text(input, "roleId");
  if (!/^[a-z][a-z0-9.-]{1,79}$/u.test(roleId)) {
    refuse("Rolle-ID må være en stabil kode.");
  }
  const roleLabel = text(input, "roleLabel");
  const scope = text(input, "scope");
  if (!org.scopes.includes(scope)) {
    refuse("Ukjent område for organisasjonen.");
  }
  const validFrom = text(input, "validFrom");
  const expiresAt = text(input, "expiresAt");
  const from = Date.parse(validFrom);
  const end = Date.parse(expiresAt);
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(end) ||
    end <= from ||
    end <= now ||
    end > now + 90 * 86_400_000 ||
    from < now - 86_400_000
  ) {
    refuse("Velg gyldige datoer, maksimalt 90 dager frem i tid.");
  }
  if (input.visibility !== "public" && input.visibility !== "private") {
    refuse("Velg synlighet.");
  }
  return {
    expiresAt: new Date(end).toISOString(),
    organisationDid,
    relationship,
    roleId,
    roleLabel,
    scope,
    subject,
    validFrom: new Date(from).toISOString(),
    visibility: input.visibility,
  };
}
export function newProposal(
  terms: Terms,
  actor: string,
  orgApprover: boolean,
  now = Date.now()
): Proposal {
  if (actor !== terms.subject && !orgApprover) {
    refuse("Du kan ikke foreslå på vegne av denne organisasjonen.", 403);
  }
  return {
    createdAt: new Date(now).toISOString(),
    createdBy: actor,
    id: randomUUID(),
    revision: 1,
    subjectApproved: actor === terms.subject,
    terms,
    ...(orgApprover && actor !== terms.subject
      ? { organisationApprovedBy: actor }
      : {}),
    state: "pending",
  };
}
export function currentRevision(p: Proposal, input: unknown) {
  if (input !== p.revision) {
    refuse("Forslaget er endret. Last inn på nytt før du godkjenner.", 409);
  }
}
export function live(p: Proposal, now = Date.now()) {
  return (
    p.state === "active" &&
    p.subjectApproved &&
    !!p.organisationApprovedBy &&
    Date.parse(p.terms.validFrom) <= now &&
    Date.parse(p.terms.expiresAt) > now
  );
}
