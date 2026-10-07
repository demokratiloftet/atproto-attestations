export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function object(
  value: unknown,
  label = "value",
): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : "Operation failed";
}
