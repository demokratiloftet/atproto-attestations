import type { Jwk, TrustEntry, TrustPolicy } from "./types.ts";
import { object } from "./values.ts";
/** Validates operator configuration; discovery never adds trust entries. */
export function parseTrustPolicy(input: unknown): TrustPolicy {
  const policy = object(input, "trust policy");
  if (!Array.isArray(policy.trust)) {
    throw new TypeError("A trust policy with a trust list is required");
  }
  const trust: TrustEntry[] = policy.trust.map((inputEntry: unknown) => {
    const entry = object(inputEntry, "trust entry");
    if (
      typeof entry.issuer !== "string" ||
      !Array.isArray(entry.claimTypes) ||
      !entry.claimTypes.every((v) => typeof v === "string")
    ) {
      throw new Error("Trust entries must name an issuer and claim types");
    }
    if (entry.repo !== undefined && typeof entry.repo !== "string") {
      throw new Error("Trust repository must be a string");
    }
    let where: Record<string, unknown> | undefined;
    if (entry.where !== undefined) {
      where = object(entry.where, "trust constraints");
      for (const value of Object.values(where)) {
        if (
          !(typeof value === "string" && !value.startsWith("$")) &&
          typeof value !== "boolean" &&
          !(typeof value === "number" && Number.isFinite(value))
        ) {
          throw new Error("Trust constraints must be literal scalar values");
        }
      }
    }
    let keys: Jwk[] | undefined;
    if (entry.keys !== undefined) {
      if (!Array.isArray(entry.keys)) {
        throw new TypeError("Trust keys must be an array");
      }
      keys = entry.keys.map((value) => {
        const key = object(value, "trust key");
        for (const name of ["kty", "crv", "x", "y", "kid", "alg", "use", "d"]) {
          if (key[name] !== undefined && typeof key[name] !== "string") {
            throw new Error(`Invalid key ${name}`);
          }
        }
        // Only fields used by the verifier are retained. importVerifyKey refuses
        // private keys and algorithms/curves other than EC P-256 at verification.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Every retained field was checked as string or undefined above; crypto validates the key itself.
        return {
          alg: key.alg,
          crv: key.crv,
          d: key.d,
          kid: key.kid,
          kty: key.kty,
          use: key.use,
          x: key.x,
          y: key.y,
        } as Jwk;
      });
    }
    return {
      claimTypes: entry.claimTypes,
      issuer: entry.issuer,
      keys,
      repo: entry.repo,
      where,
    };
  });
  const duration = (name: string): number | undefined => {
    const value = policy[name];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    ) {
      throw new Error(`Invalid ${name}`);
    }
    return value;
  };
  if (
    policy.requireStatusCheck !== undefined &&
    typeof policy.requireStatusCheck !== "boolean"
  ) {
    throw new Error("requireStatusCheck must be boolean");
  }
  if (policy.version !== undefined && policy.version !== 1) {
    throw new Error("Unsupported trust policy version");
  }
  return {
    maxClockSkewSeconds: duration("maxClockSkewSeconds"),
    maxStatusAgeSeconds: duration("maxStatusAgeSeconds"),
    requireStatusCheck: policy.requireStatusCheck,
    trust,
    version: 1,
  };
}
