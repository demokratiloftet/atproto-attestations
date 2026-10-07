import type { Descriptor, Claim, Payload } from "../../verify/types.ts";
import type {
  IssuerOptions,
  Request,
  RevokeRequest,
  Requester,
  Publication,
} from "../types.ts";
import { message } from "../../verify/values.ts";
// The issuer: descriptor, policy, adapter, signature, publication, status.
// Order matters and is deliberate. Nothing is signed before the requester is
// allowed, the subject is assured, and the adapter has agreed to the fact.
import { validateClaim, matchWhere } from "../../verify/claim-type.ts";
import { verifyAttestation } from "../../verify/index.ts";
import { createAttestation, createStatus, RECORD_TYPE } from "./attestation.ts";
import { evaluateRequester } from "./policy.ts";
import { issuerDocument, suggestedTrustPolicy } from "./keys.ts";

function refuse(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

export function createIssuer({
  issuer,
  name,
  signer,
  store,
  claimTypes,
  adapter,
  publisher,
  repo,
  contact,
  demo = false,
  now = Date.now,
}: IssuerOptions) {
  const trustPolicy = () =>
    suggestedTrustPolicy({ issuer, signer, claimTypes, repo });
  const self = () => ({ ...trustPolicy(), requireStatusCheck: false });
  const descriptorFor = (claimType: string) =>
    claimTypes[claimType] ||
    refuse(404, `Utstederen tilbyr ikke ${claimType}.`);
  const actorOf = (requester?: Requester) =>
    requester?.did ||
    (requester?.client && `client:${requester.client}`) ||
    "ukjent";

  // The issuer verifies presented evidence with the same library and the same
  // trust policy a consuming application would use. No internal shortcut.
  const verifyEvidence = (records: unknown[] | undefined, at: number) =>
    Promise.all(
      (records || []).slice(0, 10).map((record) =>
        verifyAttestation(record, {
          trustPolicy: self(),
          claimTypes,
          now: at,
        }),
      ),
    );

  async function assured(
    descriptor: Descriptor,
    subject: string,
    presented: unknown[] | undefined,
    at: number,
  ): Promise<{ ok: true; from?: string } | { ok: false; reason: string }> {
    const requirement = descriptor.subjectAssurance;
    if (!requirement) return { ok: true };
    const context = { request: {}, subject };
    const held = store
      .active(subject, requirement.claimType, new Date(at).toISOString())
      .filter((row) => matchWhere(row.claim, requirement.where, context).ok);
    if (held.length) return { ok: true, from: "issuer" };
    for (const result of await verifyEvidence(presented, at))
      if (
        result.valid &&
        result.attestation.claimType === requirement.claimType &&
        result.attestation.subject === subject &&
        matchWhere(result.attestation.claim, requirement.where, context).ok
      )
        return { ok: true, from: "presented" };
    return {
      ok: false,
      reason: `Kontoen mangler en gyldig ${requirement.claimType}${requirement.where ? ` (${JSON.stringify(requirement.where)})` : ""}. Koble identiteten din forst.`,
    };
  }

  async function issue({
    claimType,
    subject,
    request = {},
    requester = {},
    subjectAttestations,
  }: Request) {
    const at = now();
    const descriptor = descriptorFor(claimType);
    if (
      typeof subject !== "string" ||
      !/^did:[a-z]+:[a-zA-Z0-9._:%-]{1,250}$/.test(subject)
    )
      refuse(400, "Mangler en gyldig konto (DID) attestasjonen skal gjelde.");

    const evidence = await verifyEvidence(requester.attestations, at);
    const decision = await evaluateRequester(descriptor.issuance.requesters, {
      requester: { ...requester, attestations: requester.attestations },
      subject,
      request,
      trustPolicy: self(),
      claimTypes,
      now: at,
    });
    if (!decision.allowed) {
      audit("issue", "denied", {
        claimType,
        subject,
        requester,
        detail: decision.reason,
      });
      refuse(403, decision.reason);
    }

    const assurance = await assured(
      descriptor,
      subject,
      subjectAttestations,
      at,
    );
    if (!assurance.ok) {
      audit("issue", "denied", {
        claimType,
        subject,
        requester,
        detail: assurance.reason,
      });
      refuse(403, assurance.reason);
    }

    const answer = await adapter.check({
      claimType,
      subject,
      request,
      requester,
      evidence,
    });
    if (!answer?.granted) {
      audit("issue", "refused", {
        claimType,
        subject,
        requester,
        detail: answer?.reason,
      });
      refuse(422, answer?.reason || "Utstederen kan ikke bekrefte dette.");
    }

    const errors = validateClaim(answer.claim, descriptor);
    if (errors.length) {
      audit("issue", "error", {
        claimType,
        subject,
        requester,
        detail: errors.join("; "),
      });
      refuse(
        500,
        `Utstederen produserte en ugyldig attestasjon: ${errors.join("; ")}`,
      );
    }

    // An adapter may shorten a lifetime; it can never extend the claim type's.
    const lifetimeDays = Math.min(
      descriptor.maxLifetimeDays,
      answer.maxLifetimeDays ?? descriptor.maxLifetimeDays,
    );
    const { payload, jws, record } = await createAttestation({
      signer,
      issuer,
      subject,
      claimType,
      claim: answer.claim,
      lifetimeDays,
      now: at,
      demo,
    });

    store.put({
      id: payload.id,
      claimType,
      subject,
      claim: answer.claim,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
      visibility: descriptor.visibility,
      jws,
    });
    let location: Publication = {};
    if (descriptor.visibility === "public") {
      try {
        location = await publisher.publish(record);
        store.located(payload.id, location.uri, location.cid);
      } catch (error) {
        // The attestation exists and is revocable even if publication failed;
        // saying it was published when it was not would be worse.
        audit("publish", "error", {
          claimType,
          subject,
          requester,
          detail: message(error),
        });
        refuse(
          503,
          `Attestasjonen ble utstedt, men kunne ikke publiseres: ${message(error)}`,
        );
      }
    }
    audit("issue", "allowed", {
      claimType,
      subject,
      requester,
      detail: decision.reason,
    });
    return {
      attestation: view(payload),
      record,
      jws,
      uri: location.uri,
      cid: location.cid,
    };
  }

  // Answering a question about a restricted claim. The answer is the smallest
  // useful one, and the question itself is always recorded.
  async function query({
    claimType,
    subject,
    request = {},
    requester = {},
  }: Request) {
    const at = now();
    const descriptor = descriptorFor(claimType);
    if (descriptor.disclosure.mode !== "query-only")
      refuse(
        400,
        `${claimType} er et offentlig register. Les posten direkte i stedet.`,
      );

    const decision = await evaluateRequester(descriptor.disclosure.requesters, {
      requester,
      subject,
      request,
      trustPolicy: self(),
      claimTypes,
      now: at,
    });
    audit("query", decision.allowed ? "allowed" : "denied", {
      claimType,
      subject,
      requester,
      detail: decision.reason,
    });
    if (!decision.allowed) refuse(403, decision.reason);

    const context = { request, subject };
    const rows = store
      .bySubject(subject)
      .filter(
        (row) =>
          row.claimType === claimType &&
          matchWhere(row.claim, requestBinding(descriptor, request), context)
            .ok,
      );
    const live = rows.filter(
      (row) => !row.revokedAt && Date.parse(row.expiresAt) > at,
    );
    const answer = live.length
      ? "valid"
      : rows.some((row) => !row.revokedAt)
        ? "expired"
        : "none";
    return {
      answer,
      claimType,
      subject,
      checkedAt: new Date(at).toISOString(),
    };
  }

  // A query is scoped by the same fields the disclosure rule binds on, so an
  // authorised leader still only learns about their own club.
  function requestBinding(descriptor: Descriptor, request: Claim) {
    const bound: Claim = {};
    for (const rule of descriptor.disclosure.requesters || [])
      for (const expression of Object.values(rule.where || {}))
        if (
          typeof expression === "string" &&
          expression.startsWith("$request.")
        ) {
          const name = expression.slice("$request.".length);
          if (
            name in (descriptor.claim.properties || {}) &&
            request[name] !== undefined
          )
            bound[name] = request[name];
        }
    return bound;
  }

  async function revoke({
    id,
    claimType,
    subject,
    requester = {},
  }: RevokeRequest) {
    const at = now();
    if (!id && (!subject || !claimType))
      refuse(400, "Oppgi id eller subject og claimType.");
    const existing = id ? store.get(id) : undefined;
    const rows = id
      ? existing
        ? [existing]
        : []
      : subject && claimType
        ? store.active(subject, claimType, new Date(at).toISOString())
        : [];
    if (!rows.length)
      refuse(404, "Fant ingen gyldig attestasjon a trekke tilbake.");
    for (const row of rows) {
      const descriptor = claimTypes[row.claimType];
      const decision = await evaluateRequester(descriptor.issuance.requesters, {
        requester,
        subject: row.subject,
        request: row.claim,
        trustPolicy: self(),
        claimTypes,
        now: at,
      });
      if (!decision.allowed) {
        audit("revoke", "denied", {
          claimType: row.claimType,
          subject: row.subject,
          requester,
          detail: decision.reason,
        });
        refuse(403, decision.reason);
      }
      store.revoke(row.id, new Date(at).toISOString());
      if (row.uri) {
        try {
          await publisher.remove(row.uri);
        } catch (error) {
          audit("revoke", "error", {
            claimType: row.claimType,
            subject: row.subject,
            requester,
            detail: message(error),
          });
        }
      }
      audit("revoke", "allowed", {
        claimType: row.claimType,
        subject: row.subject,
        requester,
        detail: decision.reason,
      });
    }
    return { revoked: true, count: rows.length };
  }

  // Status is signed, so it cannot be faked or suppressed between the issuer
  // and the application. An unknown id is answered, not leaked as a 404.
  async function status(id: string) {
    const row = store.get(id);
    const state = !row
      ? "unknown"
      : row.revokedAt
        ? "revoked"
        : Date.parse(row.expiresAt) <= now()
          ? "expired"
          : "active";
    return createStatus({ signer, issuer, id: String(id), state, now: now() });
  }

  function audit(
    action: string,
    outcome: string,
    {
      claimType,
      subject,
      requester,
      detail,
    }: {
      claimType: string;
      subject: string;
      requester?: Requester;
      detail?: string;
    },
  ) {
    store.audit({
      action,
      outcome,
      actor: actorOf(requester),
      claimType,
      subject,
      detail: detail ? String(detail).slice(0, 500) : null,
    });
  }

  const view = (payload: Payload) => ({
    id: payload.id,
    claimType: payload.claimType,
    subject: payload.sub,
    claim: payload.claim,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    statusUrl: payload.status,
  });

  return {
    issue,
    query,
    revoke,
    status,
    trustPolicy,
    document: () =>
      issuerDocument({ issuer, name, signer, claimTypes, repo, contact, demo }),
    claimTypes: () => claimTypes,
    // Public claims only, with the signed record, so the holder can present one
    // as evidence when they ask the issuer something on their own authority.
    held: (subject: string) =>
      store
        .bySubject(subject)
        .filter((row) => claimTypes[row.claimType]?.visibility === "public")
        .map((row) => ({
          id: row.id,
          claimType: row.claimType,
          claim: row.claim,
          issuedAt: row.issuedAt,
          expiresAt: row.expiresAt,
          revokedAt: row.revokedAt,
          uri: row.uri,
          record: {
            $type: RECORD_TYPE,
            version: 1,
            jws: row.jws,
            view: {
              claimType: row.claimType,
              subject: row.subject,
              issuer,
              issuedAt: row.issuedAt,
              expiresAt: row.expiresAt,
              ...(demo ? { demo: true } : {}),
            },
          },
        })),
    audit: (limit?: number) => store.recentAudit(limit),
  };
}
