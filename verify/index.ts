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
// Verification for consuming applications. Depends on nothing in src/: an
// application that only checks claims never installs code that can issue one.
//
// Every check is reported separately so an application can explain a refusal
// instead of showing a single red cross. Anything unresolved is a refusal.
import { decodeCompact, verifyCompact } from "./jws.ts";
import { validateClaim, matchWhere } from "./claim-type.ts";
import { RECORD_TYPE } from "./record.ts";

const DEFAULT_SKEW = 60;
const DEFAULT_STATUS_AGE = 300;

export function parseRecord(input: unknown) {
  if (typeof input === "string") return { jws: input };
  if (!isObject(input))
    throw new Error(
      "An attestation record must be an object or a compact token",
    );
  if (input.$type !== undefined && input.$type !== RECORD_TYPE)
    throw new Error(
      `Not an attestation record: ${String(input.$type).slice(0, 64)}`,
    );
  if (typeof input.jws !== "string")
    throw new Error("The record has no signed attestation");
  return {
    jws: input.jws,
    view: isObject(input.view) ? input.view : undefined,
  };
}

function selectTrust(policy: TrustPolicy | undefined, payload: Payload) {
  if (!policy || !Array.isArray(policy.trust))
    throw new Error("A trust policy with a trust list is required");
  return policy.trust.find(
    (entry) =>
      entry.issuer === payload.iss &&
      (entry.claimTypes || []).some((pattern) =>
        matchPattern(pattern, payload.claimType),
      ),
  );
}

function matchPattern(pattern: string, claimType: string) {
  if (typeof pattern !== "string" || typeof claimType !== "string")
    return false;
  if (pattern === "*") return true;
  if (!pattern.endsWith("*")) return pattern === claimType;
  const prefix = pattern.slice(0, -1);
  // "no.nif.*" must not match "no.nifty.thing".
  return (
    claimType.startsWith(prefix) &&
    (prefix.endsWith(".") || claimType[prefix.length - 1] === ".")
  );
}

export async function verifyAttestation(
  input: unknown,
  options: VerifyOptions = {},
): Promise<Verification> {
  const checks: VerificationCheck[] = [];
  const add = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, detail });
    return ok;
  };
  const done = (reason: string): Verification =>
    reason === "active" && attestation
      ? { valid: true, reason: "active", checks, attestation }
      : { valid: false, reason, checks, attestation: attestation ?? null };
  let attestation: Attestation | undefined;

  let jws, view;
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
    v: 1,
    id: raw.id,
    iss: raw.iss,
    sub: raw.sub,
    claimType: raw.claimType,
    claim: raw.claim,
    iat: raw.iat,
    exp: raw.exp,
    status: raw.status,
    demo: raw.demo === true,
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
      `No trust entry accepts ${payload.claimType} from ${payload.iss}`,
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
      /no usable key/i.test(message(error))
        ? "unknown-key"
        : "invalid-signature",
    );
  }
  add("signature", true, `signed by ${payload.iss}`);
  add("trust", true, `${payload.claimType} accepted from this issuer`);

  attestation = {
    id: payload.id,
    issuer: payload.iss,
    subject: payload.sub,
    claimType: payload.claimType,
    claim: payload.claim,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    statusUrl: payload.status,
    demo: payload.demo === true,
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
            subject: payload.sub,
            issuer: payload.iss,
            issuedAt: payload.iat,
            expiresAt: payload.exp,
          }[field],
    );
    if (mismatched.length) {
      add(
        "view",
        false,
        `Display fields disagree with the signed payload: ${mismatched.join(", ")}`,
      );
      return done("view-mismatch");
    }
    add("view", true);
  }

  const skew = (trustPolicy.maxClockSkewSeconds ?? DEFAULT_SKEW) * 1000;
  const issued = Date.parse(payload.iat),
    expires = Date.parse(payload.exp);
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
        `Published in ${repo || "an unknown repository"}, expected ${entry.repo}`,
      );
      return done("provenance");
    }
    add(
      "provenance",
      true,
      repo ? `published in ${repo}` : "no repository asserted",
    );
  }

  if (expect) {
    const mismatch = (["subject", "claimType"] as const).find(
      (field) =>
        expect[field] !== undefined && expect[field] !== attestation[field],
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
            : undefined,
      );
      return done("expectations");
    }
    add("expectations", true);
  }

  const required = trustPolicy.requireStatusCheck ?? true;
  if (required) {
    const result = await checkStatus(payload, {
      keys,
      fetchStatus,
      now,
      maxAge: (trustPolicy.maxStatusAgeSeconds ?? DEFAULT_STATUS_AGE) * 1000,
    });
    if (!add("status", result.ok, result.detail))
      return done(result.reason ?? "status-unavailable");
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
  }: { keys: Jwk[]; fetchStatus?: FetchStatus; now: number; maxAge: number },
): Promise<{ ok: boolean; reason?: string; detail: string }> {
  if (typeof payload.status !== "string")
    return {
      ok: false,
      reason: "status-unavailable",
      detail: "The attestation names no status endpoint",
    };
  // Status must live on the issuer's own origin: a claim cannot delegate its
  // own revocation to somewhere else.
  try {
    if (new URL(payload.status).origin !== new URL(payload.iss).origin)
      return {
        ok: false,
        reason: "status-unavailable",
        detail: "The status endpoint is not on the issuer origin",
      };
  } catch {
    return {
      ok: false,
      reason: "status-unavailable",
      detail: "The status endpoint is not a usable URL",
    };
  }
  if (typeof fetchStatus !== "function")
    return {
      ok: false,
      reason: "status-unavailable",
      detail:
        "This policy requires a status check, but no way to reach the issuer was provided",
    };

  let answer;
  try {
    answer = await fetchStatus(payload.status);
  } catch (error) {
    return {
      ok: false,
      reason: "status-unavailable",
      detail: `Could not reach the issuer: ${message(error)}`,
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
      keys,
    );
  } catch (error) {
    return {
      ok: false,
      reason: "status-unavailable",
      detail: `The status answer did not verify: ${message(error)}`,
    };
  }
  if (
    status.typ !== "status" ||
    status.id !== payload.id ||
    status.iss !== payload.iss
  )
    return {
      ok: false,
      reason: "status-unavailable",
      detail: "The status answer is about a different attestation",
    };
  const at = Date.parse(typeof status.at === "string" ? status.at : "");
  if (!Number.isFinite(at) || now - at > maxAge || at - now > maxAge)
    return {
      ok: false,
      reason: "status-stale",
      detail: `The status answer is from ${status.at}`,
    };
  if (status.status !== "active")
    return {
      ok: false,
      reason: status.status === "revoked" ? "revoked" : "status-unavailable",
      detail: `The issuer reports "${status.status}"`,
    };
  return { ok: true, detail: `confirmed active at ${status.at}` };
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
