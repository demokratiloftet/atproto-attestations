import type { Jwk, TrustEntry, TrustPolicy } from "./types.ts";
import { object } from "./values.ts";
/** Validates operator configuration; discovery never adds trust entries. */
export function parseTrustPolicy(input: unknown): TrustPolicy {
  const policy = object(input, "trust policy");
  if (!Array.isArray(policy.trust))
    throw new Error("A trust policy with a trust list is required");
  const trust: TrustEntry[] = policy.trust.map((value) => {
    const entry = object(value, "trust entry");
    if (
      typeof entry.issuer !== "string" ||
      !Array.isArray(entry.claimTypes) ||
      !entry.claimTypes.every((v) => typeof v === "string")
    )
      throw new Error("Trust entries must name an issuer and claim types");
    if (entry.repo !== undefined && typeof entry.repo !== "string")
      throw new Error("Trust repository must be a string");
    let keys: Jwk[] | undefined;
    if (entry.keys !== undefined) {
      if (!Array.isArray(entry.keys))
        throw new Error("Trust keys must be an array");
      keys = entry.keys.map((value) => {
        const key = object(value, "trust key");
        for (const name of ["kty", "crv", "x", "y", "kid", "alg", "use", "d"])
          if (key[name] !== undefined && typeof key[name] !== "string")
            throw new Error(`Invalid key ${name}`);
        // Only fields used by the verifier are retained. importVerifyKey refuses
        // private keys and algorithms/curves other than EC P-256 at verification.
        return {
          kty: key.kty,
          crv: key.crv,
          x: key.x,
          y: key.y,
          kid: key.kid,
          alg: key.alg,
          use: key.use,
          d: key.d,
        } as Jwk;
      });
    }
    return {
      issuer: entry.issuer,
      claimTypes: entry.claimTypes,
      repo: entry.repo,
      keys,
    };
  });
  const duration = (name: string): number | undefined => {
    const value = policy[name];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    )
      throw new Error(`Invalid ${name}`);
    return value;
  };
  if (
    policy.requireStatusCheck !== undefined &&
    typeof policy.requireStatusCheck !== "boolean"
  )
    throw new Error("requireStatusCheck must be boolean");
  if (policy.version !== undefined && policy.version !== 1)
    throw new Error("Unsupported trust policy version");
  return {
    version: 1,
    trust,
    requireStatusCheck: policy.requireStatusCheck,
    maxClockSkewSeconds: duration("maxClockSkewSeconds"),
    maxStatusAgeSeconds: duration("maxStatusAgeSeconds"),
  };
}
