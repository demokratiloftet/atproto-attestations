import type {
  BindingContext,
  Claim,
  Descriptor,
  Match,
  RequesterRule,
} from "./types.ts";
import { isObject, object, message } from "./values.ts";
// A claim type is a declarative file. Adding one is a new descriptor, not new
// code, and the same descriptor drives issuance, disclosure and verification.
import { checkSchema, validate } from "./schema.ts";

// An NSID: lowercase reversed domain authority, then a name segment that may
// be camelCase, e.g. no.nif.instructorLicence.
const NSID =
  /^[a-z][a-z0-9]*(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+\.[a-zA-Z][a-zA-Z0-9]{0,62}$/;
function bad(message: string): never {
  throw new Error(`Claim type: ${message}`);
}

function parseRule(input: unknown, where?: string[]): RequesterRule {
  const rule = object(input, "requester rule");
  if (rule.kind === "self") return { kind: "self" };
  if (rule.kind === "client") {
    if (
      typeof rule.client !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,40}$/.test(rule.client)
    )
      bad("a client rule needs a client id");
    return { kind: "client", client: rule.client };
  }
  if (rule.kind !== "attestation")
    bad(`unknown requester rule kind "${String(rule.kind)}"`);
  if (typeof rule.claimType !== "string" || !NSID.test(rule.claimType))
    bad("an attestation rule needs a claimType");
  const conditions =
    rule.where === undefined ? undefined : object(rule.where, "where");
  for (const value of Object.values(conditions || {}))
    if (typeof value === "string" && value.startsWith("$"))
      checkBinding(value, where);
  return { kind: "attestation", claimType: rule.claimType, where: conditions };
}

function checkBinding(expression: string, allowed?: string[]) {
  const [root, ...rest] = expression.slice(1).split(".");
  if (root === "subject") {
    if (rest.length) bad(`unsupported binding ${expression}`);
    return;
  }
  if (
    root !== "request" ||
    rest.length !== 1 ||
    !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(rest[0])
  )
    bad(`unsupported binding ${expression}`);
  if (allowed && !allowed.includes(rest[0]))
    bad(`${expression} does not name a property of this claim`);
}

export function parseDescriptor(input: unknown): Descriptor {
  const d = object(input, "descriptor");
  if (d.version !== 1) bad("unsupported descriptor version");
  if (typeof d.id !== "string" || !NSID.test(d.id))
    bad(`"${String(d.id)}" is not a valid claim type id`);
  const label = object(d.label, "label");
  if (
    typeof label.nb !== "string" ||
    !label.nb ||
    !Object.values(label).every((v) => typeof v === "string")
  )
    bad("a Norwegian label is required");
  if (typeof d.description !== "string" || d.description.length < 10)
    bad("a description is required");
  if (d.visibility !== "public" && d.visibility !== "restricted")
    bad('visibility must be "public" or "restricted"');
  if (
    typeof d.maxLifetimeDays !== "number" ||
    !Number.isInteger(d.maxLifetimeDays) ||
    d.maxLifetimeDays < 1 ||
    d.maxLifetimeDays > 3650
  )
    bad("maxLifetimeDays must be 1-3650");
  const claim = checkSchema(d.claim);
  if (claim.type !== "object") bad("claim schema must describe an object");
  const fields = Object.keys(claim.properties || {});
  const issuance = object(d.issuance, "issuance");
  if (!Array.isArray(issuance.requesters) || !issuance.requesters.length)
    bad("issuance.requesters must list at least one rule");
  const requesters = issuance.requesters.map((rule) => parseRule(rule, fields));
  const disclosure = object(d.disclosure, "disclosure");
  if (disclosure.mode !== "public-record" && disclosure.mode !== "query-only")
    bad('disclosure.mode must be "public-record" or "query-only"');
  if (d.visibility === "restricted" && disclosure.mode !== "query-only")
    bad("a restricted claim cannot be published as a public record");
  if (d.visibility === "public" && disclosure.mode !== "public-record")
    bad("a public claim is disclosed as a public record");
  let disclosureRules: RequesterRule[] | undefined,
    purposes: string[] | undefined;
  if (disclosure.mode === "query-only") {
    if (!Array.isArray(disclosure.requesters) || !disclosure.requesters.length)
      bad("query-only disclosure must name who may ask");
    disclosureRules = disclosure.requesters.map((rule) =>
      parseRule(rule, fields),
    );
    if (
      !Array.isArray(disclosure.purposes) ||
      !disclosure.purposes.length ||
      !disclosure.purposes.every((v) => typeof v === "string" && v.length)
    )
      bad("query-only disclosure must state its purposes");
    purposes = disclosure.purposes;
  }
  let subjectAssurance: Descriptor["subjectAssurance"];
  if (d.subjectAssurance !== undefined && d.subjectAssurance !== null) {
    const requirement = object(d.subjectAssurance, "subjectAssurance");
    const rule = parseRule(
      {
        kind: "attestation",
        claimType: requirement.claimType,
        where: requirement.where,
      },
      fields,
    );
    if (rule.kind === "attestation")
      subjectAssurance = { claimType: rule.claimType, where: rule.where };
  }
  return {
    version: 1,
    id: d.id,
    label: label as Descriptor["label"],
    description: d.description,
    visibility: d.visibility,
    maxLifetimeDays: d.maxLifetimeDays,
    claim,
    issuance: { requesters },
    disclosure: {
      mode: disclosure.mode,
      requesters: disclosureRules,
      purposes,
    },
    subjectAssurance,
  };
}

export function validateClaim(claim: unknown, descriptor: Descriptor) {
  return validate(claim, descriptor.claim);
}

// A binding never resolves to undefined. An unresolved binding is a policy
// error, not a silently permissive comparison.
export function resolveBinding(expression: unknown, context: BindingContext) {
  if (typeof expression !== "string" || !expression.startsWith("$"))
    return expression;
  const [root, field] = expression.slice(1).split(".");
  if (root === "subject" && field === undefined) {
    if (!context.subject)
      throw new Error(`Binding ${expression} has no value in this request`);
    return context.subject;
  }
  const value =
    root === "request" && field
      ? Object.prototype.hasOwnProperty.call(context.request || {}, field)
        ? context.request?.[field]
        : undefined
      : undefined;
  if (value === undefined || value === null)
    throw new Error(`Binding ${expression} has no value in this request`);
  return value;
}

export function matchWhere(
  claim: unknown,
  where: Claim | undefined,
  context: BindingContext,
): Match {
  for (const [field, expected] of Object.entries(where || {})) {
    let value;
    try {
      value = resolveBinding(expected, context);
    } catch (error) {
      return { ok: false, reason: message(error) };
    }
    if (
      !isObject(claim) ||
      !Object.prototype.hasOwnProperty.call(claim, field) ||
      claim[field] !== value
    )
      return {
        ok: false,
        reason: `expected ${field} to be ${JSON.stringify(value)}`,
      };
  }
  return { ok: true };
}

export const CLAIM_TYPE_ID = NSID;
