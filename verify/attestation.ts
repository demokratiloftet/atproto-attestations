import { validateClaim, matchWhere } from "./claim-type.ts";
// Verification for consuming applications. Depends on nothing in src/: an
// application that only checks claims never installs code that can issue one.
//
// Every check is reported separately so an application can explain a refusal
// instead of showing a single red cross. Anything unresolved is a refusal.
import { decodeCompact, verifyCompact } from "./jws.ts";
import { RECORD_TYPE } from "./record.ts";
import { parseTrustPolicy } from "./trust-policy.ts";
import type {
  Attestation,
  Jwk,
  Payload,
  TrustPolicy,
  VerifyOptions,
  Verification,
  VerificationCheck,
  FetchStatus,
} from "./types.ts";
import { isObject, message } from "./values.ts";

const DEFAULT_SKEW = 60;
const DEFAULT_STATUS_AGE = 300;

export function parseRecord(input: unknown) {
  if (typeof input === "string") {
    return { jws: input };
  }
  if (!isObject(input)) {
    throw new Error(
      "An attestation record must be an object or a compact token"
    );
  }
  if (input.$type !== undefined && input.$type !== RECORD_TYPE) {
    throw new Error(
      `Not an attestation record: ${JSON.stringify(input.$type).slice(0, 64)}`
    );
  }
  if (typeof input.jws !== "string") {
    throw new TypeError("The record has no signed attestation");
  }
  return {
    jws: input.jws,
    view: isObject(input.view) ? input.view : undefined,
  };
}

function selectTrust(policy: TrustPolicy | undefined, payload: Payload) {
  if (!policy || !Array.isArray(policy.trust)) {
    throw new Error("A trust policy with a trust list is required");
  }
  return policy.trust.find(
    (entry) =>
      entry.issuer === payload.iss &&
      (entry.claimTypes || []).some((pattern) =>
        matchPattern(pattern, payload.claimType)
      ) &&
      matchWhere(payload.claim, entry.where, {}).ok
  );
}

function matchPattern(pattern: string, claimType: string) {
  if (typeof pattern !== "string" || typeof claimType !== "string") {
    return false;
  }
  if (pattern === "*") {
    return true;
  }
  if (!pattern.endsWith("*")) {
    return pattern === claimType;
  }
  const prefix = pattern.slice(0, -1);
  // "no.nif.*" must not match "no.nifty.thing".
  return (
    claimType.startsWith(prefix) &&
    (prefix.endsWith(".") || claimType[prefix.length - 1] === ".")
  );
}

export async function verifyAttestation(
  input: unknown,
  options: VerifyOptions = {}
): Promise<Verification> {
  const checks: VerificationCheck[] = [];
  const add = (name: string, ok: boolean, detail?: string) => {
    checks.push({ detail, name, ok });
    return ok;
  };
  const done = (reason: string): Verification =>
    reason === "active" && attestation
      ? { attestation, checks, reason: "active", valid: true }
      : { attestation: attestation ?? null, checks, reason, valid: false };
  // oxlint-disable-next-line prefer-const -- done() may run before an attestation is decoded; const would create a temporal-dead-zone failure.
  let attestation: Attestation | undefined;
  let jws;
  let view;
  try {
    ({ jws, view } = parseRecord(input));
  } catch (error) {
    add("record", false, message(error));
    return done("malformed");
  }

  const {
    trustPolicy: inputPolicy,
    claimTypes,
    now = Date.now(),
    expect,
    uri,
    fetchStatus,
  } = options;
  let raw: Record<string, unknown>;
  try {
    raw = decodeCompact(jws).payload;
  } catch (error) {
    add("record", false, message(error));
    return done("malformed");
  }
  if (
    raw.v !== 1 ||
    typeof raw.id !== "string" ||
    typeof raw.iss !== "string" ||
    typeof raw.sub !== "string" ||
    typeof raw.claimType !== "string" ||
    typeof raw.iat !== "string" ||
    typeof raw.exp !== "string" ||
    typeof raw.status !== "string" ||
    !isObject(raw.claim)
  ) {
    add("record", false, "The signed payload is not an attestation");
    return done("malformed");
  }
  const payload: Payload = {
    claim: raw.claim,
    claimType: raw.claimType,
    demo: raw.demo === true,
    exp: raw.exp,
    iat: raw.iat,
    id: raw.id,
    iss: raw.iss,
    status: raw.status,
    sub: raw.sub,
    v: 1,
  };
  add("record", true);

  let trustPolicy: TrustPolicy;
  try {
    trustPolicy = parseTrustPolicy(inputPolicy);
  } catch (error) {
    add("trust", false, message(error));
    return done("no-trust-policy");
  }
  let entry;
  try {
    entry = selectTrust(trustPolicy, payload);
  } catch (error) {
    add("trust", false, message(error));
    return done("no-trust-policy");
  }
  if (!entry) {
    add(
      "trust",
      false,
      `No trust entry accepts ${payload.claimType} from ${payload.iss}`
    );
    return done("untrusted-issuer");
  }

  const keys = entry.keys || options.keys;
  if (!Array.isArray(keys) || !keys.length) {
    add("signature", false, "The trust entry pins no keys");
    return done("no-trusted-keys");
  }
  try {
    await verifyCompact(jws, keys);
  } catch (error) {
    add("signature", false, message(error));
    return done(
      /no usable key/iu.test(message(error))
        ? "unknown-key"
        : "invalid-signature"
    );
  }
  add("signature", true, `signed by ${payload.iss}`);
  add("trust", true, `${payload.claimType} accepted from this issuer`);

  attestation = {
    claim: payload.claim,
    claimType: payload.claimType,
    demo: payload.demo === true,
    expiresAt: payload.exp,
    id: payload.id,
    issuedAt: payload.iat,
    issuer: payload.iss,
    statusUrl: payload.status,
    subject: payload.sub,
  };

  const descriptor = (claimTypes || {})[payload.claimType];
  if (!descriptor) {
    add("schema", false, `No descriptor loaded for ${payload.claimType}`);
    return done("unknown-claim-type");
  }
  const errors = validateClaim(payload.claim, descriptor);
  if (errors.length) {
    add("schema", false, errors.join("; "));
    return done("schema");
  }
  add("schema", true, descriptor.label?.nb || payload.claimType);

  // The view is decoration. A disagreement means someone edited the record, so
  // it is reported as a failure even though the signature is intact.
  if (view) {
    const mismatched = (
      ["claimType", "subject", "issuer", "issuedAt", "expiresAt"] as const
    ).filter(
      (field) =>
        view[field] !== undefined &&
        view[field] !==
          {
            claimType: payload.claimType,
            expiresAt: payload.exp,
            issuedAt: payload.iat,
            issuer: payload.iss,
            subject: payload.sub,
          }[field]
    );
    if (mismatched.length) {
      add(
        "view",
        false,
        `Display fields disagree with the signed payload: ${mismatched.join(", ")}`
      );
      return done("view-mismatch");
    }
    add("view", true);
  }

  const skew = (trustPolicy.maxClockSkewSeconds ?? DEFAULT_SKEW) * 1000;
  const issued = Date.parse(payload.iat);
  const expires = Date.parse(payload.exp);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    expires <= issued
  ) {
    add("window", false, "The validity window is not usable");
    return done("invalid-window");
  }
  if (now + skew < issued) {
    add("window", false, `Not valid before ${payload.iat}`);
    return done("not-yet-valid");
  }
  if (now - skew >= expires) {
    add("window", false, `Expired ${payload.exp}`);
    return done("expired");
  }
  add("window", true, `valid until ${payload.exp}`);

  if (uri || entry.repo) {
    const repo =
      typeof uri === "string" && uri.startsWith("at://")
        ? uri.slice(5).split("/")[0]
        : undefined;
    if (entry.repo && repo !== entry.repo) {
      add(
        "provenance",
        false,
        `Published in ${repo || "an unknown repository"}, expected ${entry.repo}`
      );
      return done("provenance");
    }
    add(
      "provenance",
      true,
      repo ? `published in ${repo}` : "no repository asserted"
    );
  }

  if (expect) {
    const mismatch = (["subject", "claimType"] as const).find(
      (field) =>
        expect[field] !== undefined && expect[field] !== attestation[field]
    );
    const claimCheck = expect.claim
      ? matchWhere(payload.claim, expect.claim, {
          request: expect.request || {},
          subject: payload.sub,
        })
      : { ok: true as const };
    if (mismatch || !claimCheck.ok) {
      add(
        "expectations",
        false,
        mismatch
          ? `${mismatch} is not what the application asked about`
          : !claimCheck.ok
            ? claimCheck.reason
            : undefined
      );
      return done("expectations");
    }
    add("expectations", true);
  }

  const required = trustPolicy.requireStatusCheck ?? true;
  if (required) {
    const result = await checkStatus(payload, {
      fetchStatus,
      keys,
      maxAge: (trustPolicy.maxStatusAgeSeconds ?? DEFAULT_STATUS_AGE) * 1000,
      now,
    });
    if (!add("status", result.ok, result.detail)) {
      return done(result.reason ?? "status-unavailable");
    }
  }
  return done("active");
}

async function checkStatus(
  payload: Payload,
  {
    keys,
    fetchStatus,
    now,
    maxAge,
  }: { keys: Jwk[]; fetchStatus?: FetchStatus; now: number; maxAge: number }
): Promise<{ ok: boolean; reason?: string; detail: string }> {
  if (typeof payload.status !== "string") {
    return {
      detail: "The attestation names no status endpoint",
      ok: false,
      reason: "status-unavailable",
    };
  }
  // Status must live on the issuer's own origin: a claim cannot delegate its
  // own revocation to somewhere else.
  try {
    if (new URL(payload.status).origin !== new URL(payload.iss).origin) {
      return {
        detail: "The status endpoint is not on the issuer origin",
        ok: false,
        reason: "status-unavailable",
      };
    }
  } catch {
    return {
      detail: "The status endpoint is not a usable URL",
      ok: false,
      reason: "status-unavailable",
    };
  }
  if (typeof fetchStatus !== "function") {
    return {
      detail:
        "This policy requires a status check, but no way to reach the issuer was provided",
      ok: false,
      reason: "status-unavailable",
    };
  }

  let answer;
  try {
    answer = await fetchStatus(payload.status);
  } catch (error) {
    return {
      detail: `Could not reach the issuer: ${message(error)}`,
      ok: false,
      reason: "status-unavailable",
    };
  }

  let status;
  try {
    status = await verifyCompact(
      typeof answer === "string"
        ? answer
        : isObject(answer)
          ? answer.jws
          : undefined,
      keys
    );
  } catch (error) {
    return {
      detail: `The status answer did not verify: ${message(error)}`,
      ok: false,
      reason: "status-unavailable",
    };
  }
  if (
    status.typ !== "status" ||
    status.id !== payload.id ||
    status.iss !== payload.iss
  ) {
    return {
      detail: "The status answer is about a different attestation",
      ok: false,
      reason: "status-unavailable",
    };
  }
  const at = Date.parse(typeof status.at === "string" ? status.at : "");
  if (!Number.isFinite(at) || now - at > maxAge || at - now > maxAge) {
    return {
      detail: `The status answer is from ${JSON.stringify(status.at) ?? "missing"}`,
      ok: false,
      reason: "status-stale",
    };
  }
  if (status.status !== "active") {
    return {
      detail: `The issuer reports "${JSON.stringify(status.status) ?? "missing"}"`,
      ok: false,
      reason: status.status === "revoked" ? "revoked" : "status-unavailable",
    };
  }
  return {
    detail: `confirmed active at ${JSON.stringify(status.at) ?? "missing"}`,
    ok: true,
  };
}

export {
  parseDescriptor,
  validateClaim,
  matchWhere,
  resolveBinding,
} from "./claim-type.ts";
export { decodeCompact, verifyCompact, thumbprint } from "./jws.ts";
export { RECORD_TYPE } from "./record.ts";

export { parseTrustPolicy } from "./trust-policy.ts";
export type {
  Descriptor,
  Schema,
  Claim,
  TrustPolicy,
  VerifyOptions,
  Verification,
  Attestation,
  AttestationRecord,
} from "./types.ts";
