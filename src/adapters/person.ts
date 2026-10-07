import { object } from "../../verify/values.ts";
import type { Person } from "../types.ts";
export function parsePerson(input: unknown): Person {
  const facts = object(input, "demo facts");
  const text = (row: Record<string, unknown>, key: string): string => {
    const value = row[key];
    if (typeof value !== "string")
      throw new Error(`Demo ${key} must be a string`);
    return value;
  };
  const optional = (row: Record<string, unknown>, key: string) =>
    row[key] === undefined ? undefined : text(row, key);
  function list<T>(
    value: unknown,
    parse: (row: Record<string, unknown>) => T,
  ): T[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error("Demo facts must use arrays");
    return value.map((item) => parse(object(item, "demo fact")));
  }
  const result: Person = {};
  if (facts.identity !== undefined) {
    const identity = object(facts.identity, "demo identity");
    result.identity = {
      assuranceLevel: optional(identity, "assuranceLevel"),
      provider: optional(identity, "provider"),
      method: optional(identity, "method"),
    };
  }
  if (facts.clubs !== undefined)
    result.clubs = list(facts.clubs, (row) => ({
      orgId: text(row, "orgId"),
      orgName: text(row, "orgName"),
      role: text(row, "role"),
    }));
  if (facts.licences !== undefined)
    result.licences = list(facts.licences, (row) => ({
      discipline: text(row, "discipline"),
      level: text(row, "level"),
      orgId: optional(row, "orgId"),
      expiresAt: optional(row, "expiresAt"),
    }));
  if (facts.attests !== undefined)
    result.attests = list(facts.attests, (row) => ({
      orgId: text(row, "orgId"),
    }));
  return result;
}
