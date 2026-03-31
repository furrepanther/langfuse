/**
 * Returns true if the value is a plain object (not null, not an array).
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ResourceSpanValidationError {
  spanId: string;
  attribute: string;
  reason: string;
  message: string;
}

export const MAX_DETAILS_ATTRIBUTE_BYTES = 2048;

/**
 * Attributes that must be valid JSON objects when present on a span.
 */
export const JSON_OBJECT_ATTRIBUTES = [
  "langfuse.observation.cost_details",
  "langfuse.observation.usage_details",
] as const;

/**
 * Validates a single extracted attribute value that is expected to be a
 * JSON-encoded object. Returns an error descriptor or null if valid.
 */
export function validateJsonObjectAttribute(
  value: unknown,
  attribute: string,
  spanId: string,
): ResourceSpanValidationError | null {
  if (value === undefined || value === null) return null;

  // After extractSpanAttributes, the value is already converted via
  // convertValueToPlainJavascript. Non-string values (intValue, doubleValue,
  // boolValue) are already plain JS types — they can't be valid JSON objects.
  if (typeof value !== "string") {
    return {
      spanId,
      attribute,
      reason: "not_a_string",
      message: `Attribute ${attribute} must be a JSON-encoded string, got ${typeof value}`,
    };
  }

  if (Buffer.byteLength(value, "utf8") >= MAX_DETAILS_ATTRIBUTE_BYTES) {
    return {
      spanId,
      attribute,
      reason: "attribute_too_large",
      message: `Attribute ${attribute} exceeds maximum size of ${MAX_DETAILS_ATTRIBUTE_BYTES} bytes`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {
      spanId,
      attribute,
      reason: "invalid_json",
      message: `Attribute ${attribute} contains invalid JSON`,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      spanId,
      attribute,
      reason: "not_an_object",
      message: `Attribute ${attribute} must be a JSON object, got ${typeof parsed}`,
    };
  }

  return null;
}
