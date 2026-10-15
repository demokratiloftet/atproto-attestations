import type { Schema } from "./types.ts";
import { isObject, object } from "./values.ts";
// A deliberately small JSON Schema subset, sufficient for claim payloads and
// self-contained so that a consuming application installs no validator.
// Unknown keywords are refused when a schema is loaded, so a descriptor can
// never appear to constrain something this validator silently ignores.
const KEYWORDS = new Set([
  "type",
  "required",
  "properties",
  "additionalProperties",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "items",
  "minItems",
  "maxItems",
  "description",
]);
const TYPES = new Set([
  "object",
  "string",
  "integer",
  "number",
  "boolean",
  "array",
]);
const FORMATS: Record<string, (value: string) => boolean> = {
  datetime: (value) =>
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/u.test(value) &&
    Number.isFinite(Date.parse(value)),
  did: (value) => /^did:[a-z]+:[a-zA-Z0-9._:%-]{1,250}$/u.test(value),
  uri: (value) => {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  },
};

export function checkSchema(input: unknown, path = "claim"): Schema {
  const schema = object(input, `${path}: schema`);
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) {
      throw new Error(`${path}: unsupported schema keyword "${key}"`);
    }
  }
  if (
    schema.type !== undefined &&
    (typeof schema.type !== "string" || !TYPES.has(schema.type))
  ) {
    throw new Error(`${path}: unsupported type`);
  }
  if (
    schema.format !== undefined &&
    (typeof schema.format !== "string" ||
      !Object.hasOwn(FORMATS, schema.format))
  ) {
    throw new Error(`${path}: unsupported format`);
  }
  for (const key of ["pattern", "description"]) {
    if (schema[key] !== undefined && typeof schema[key] !== "string") {
      throw new Error(`${path}: ${key} must be a string`);
    }
  }
  if (typeof schema.pattern === "string") {
    new RegExp(schema.pattern, "u").test("");
  }
  for (const key of [
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
  ]) {
    const n = schema[key];
    if (
      n !== undefined &&
      (typeof n !== "number" ||
        !Number.isFinite(n) ||
        (key !== "minimum" &&
          key !== "maximum" &&
          (!Number.isInteger(n) || n < 0)))
    ) {
      throw new Error(`${path}: invalid ${key}`);
    }
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    throw new Error(`${path}: additionalProperties must be boolean`);
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      !schema.required.every((v) => typeof v === "string"))
  ) {
    throw new Error(`${path}: required must be an array of strings`);
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    throw new Error(`${path}: enum must be an array`);
  }
  if (schema.properties !== undefined) {
    for (const [name, child] of Object.entries(
      object(schema.properties, `${path}: properties`)
    )) {
      checkSchema(child, `${path}.${name}`);
    }
  }
  if (schema.items !== undefined) {
    checkSchema(schema.items, `${path}[]`);
  }
  // All supported fields have been checked above, recursively.
  return schema;
}

export function validate(
  value: unknown,
  schema: Schema,
  path = "claim"
): string[] {
  const errors: string[] = [];
  const add = (message: string) => errors.push(`${path}: ${message}`);
  const { type } = schema;
  if (type === "object") {
    if (!isObject(value)) {
      return [`${path}: expected an object`];
    }
    // Object.keys ignores an inherited __proto__, and own keys are checked like
    // any other property, so a polluted payload fails additionalProperties.
    const keys = Object.keys(value);
    for (const name of schema.required || []) {
      if (!keys.includes(name)) {
        add(`missing required property "${name}"`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const name of keys) {
        if (!Object.hasOwn(schema.properties || {}, name)) {
          add(`unexpected property "${name}"`);
        }
      }
    }
    for (const [name, child] of Object.entries(schema.properties || {})) {
      if (keys.includes(name)) {
        errors.push(...validate(value[name], child, `${path}.${name}`));
      }
    }
    return errors;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      return [`${path}: expected an array`];
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      add(`needs at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      add(`allows at most ${schema.maxItems} items`);
    }
    const { items } = schema;
    if (items) {
      for (const [index, item] of value.entries()) {
        errors.push(...validate(item, items, `${path}[${index}]`));
      }
    }
    return errors;
  }
  if (type === "string") {
    if (typeof value !== "string") {
      return [`${path}: expected a string`];
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      add(`is shorter than ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      add(`is longer than ${schema.maxLength} characters`);
    }
    if (
      schema.pattern !== undefined &&
      !new RegExp(schema.pattern, "u").test(value)
    ) {
      add("does not match the required pattern");
    }
    if (schema.format && !FORMATS[schema.format](value)) {
      add(`is not a valid ${schema.format}`);
    }
  } else if (type === "integer" || type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return [`${path}: expected a number`];
    }
    if (type === "integer" && !Number.isInteger(value)) {
      add("must be a whole number");
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      add(`is below the minimum of ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      add(`is above the maximum of ${schema.maximum}`);
    }
  } else if (type === "boolean" && typeof value !== "boolean") {
    return [`${path}: expected true or false`];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    add(
      `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`
    );
  }
  if (schema.const !== undefined && value !== schema.const) {
    add(`must be ${JSON.stringify(schema.const)}`);
  }
  return errors;
}
