import { describe, expect, it } from "vitest";
import { validateJsonObjectAttribute } from "@langfuse/shared/src/server";
import { OtelIngestionProcessor } from "@langfuse/shared/src/server";

function makeSpan(spanId: string, attrs: Record<string, unknown> = {}): any {
  const attributes = Object.entries(attrs).map(([key, val]) => {
    if (typeof val === "string") return { key, value: { stringValue: val } };
    if (typeof val === "number") return { key, value: { intValue: val } };
    if (typeof val === "boolean") return { key, value: { boolValue: val } };
    return { key, value: {} };
  });
  return { spanId, attributes };
}

function wrapInResourceSpans(spans: any[]): any[] {
  return [{ scopeSpans: [{ spans }] }];
}

const processor = new OtelIngestionProcessor({ projectId: "test-project" });

describe("validateJsonObjectAttribute", () => {
  it("accepts valid JSON object string", () => {
    expect(
      validateJsonObjectAttribute('{"a": 1}', "test.attr", "span1"),
    ).toBeNull();
  });

  it("accepts null/undefined values", () => {
    expect(validateJsonObjectAttribute(null, "test.attr", "span1")).toBeNull();
    expect(
      validateJsonObjectAttribute(undefined, "test.attr", "span1"),
    ).toBeNull();
  });

  it("rejects non-string values", () => {
    const error = validateJsonObjectAttribute(42, "test.attr", "span1");
    expect(error).not.toBeNull();
    expect(error!.reason).toBe("not_a_string");
  });

  it("rejects oversized strings", () => {
    const large = '{"k":"' + "x".repeat(2048) + '"}';
    const error = validateJsonObjectAttribute(large, "test.attr", "span1");
    expect(error).not.toBeNull();
    expect(error!.reason).toBe("attribute_too_large");
  });

  it("rejects invalid JSON", () => {
    const error = validateJsonObjectAttribute("not-json", "test.attr", "span1");
    expect(error).not.toBeNull();
    expect(error!.reason).toBe("invalid_json");
  });

  it("rejects bare numbers", () => {
    const error = validateJsonObjectAttribute("115", "test.attr", "span1");
    expect(error).not.toBeNull();
    expect(error!.reason).toBe("not_an_object");
  });

  it("rejects arrays", () => {
    const error = validateJsonObjectAttribute("[1,2]", "test.attr", "span1");
    expect(error).not.toBeNull();
    expect(error!.reason).toBe("not_an_object");
  });
});

describe("OtelIngestionProcessor.validateResourceSpans", () => {
  it("accepts spans with valid object cost_details", () => {
    const spans = wrapInResourceSpans([
      makeSpan("span1", {
        "langfuse.observation.cost_details": '{"input": 0.01, "output": 0.02}',
      }),
    ]);
    expect(processor.validateResourceSpans(spans)).toBeNull();
  });

  it("accepts empty resourceSpans", () => {
    expect(processor.validateResourceSpans([])).toBeNull();
  });

  it("accepts spans with no attributes", () => {
    const spans = wrapInResourceSpans([{ spanId: "span1" }]);
    expect(processor.validateResourceSpans(spans)).toBeNull();
  });

  it("rejects bare number in cost_details (original bug scenario)", () => {
    const spans = wrapInResourceSpans([
      makeSpan("span1", {
        "langfuse.observation.cost_details": "115",
      }),
    ]);
    const error = processor.validateResourceSpans(spans);
    expect(error).not.toBeNull();
    expect(error!.reason).toBe("not_an_object");
    expect(error!.attribute).toBe("langfuse.observation.cost_details");
  });

  it("rejects bare number in usage_details", () => {
    const spans = wrapInResourceSpans([
      makeSpan("span1", {
        "langfuse.observation.usage_details": "42",
      }),
    ]);
    const error = processor.validateResourceSpans(spans);
    expect(error).not.toBeNull();
    expect(error!.attribute).toBe("langfuse.observation.usage_details");
  });

  it("rejects entire batch if any span is invalid", () => {
    const spans = wrapInResourceSpans([
      makeSpan("good-span", {
        "langfuse.observation.cost_details": '{"input": 0.01}',
      }),
      makeSpan("bad-span", {
        "langfuse.observation.cost_details": "115",
      }),
    ]);
    const error = processor.validateResourceSpans(spans);
    expect(error).not.toBeNull();
    expect(error!.spanId).toBe("bad-span");
  });

  it("rejects intValue cost_details (non-string OTEL type)", () => {
    // Raw KeyValue[] — bypass makeSpan to test intValue directly
    const spans = wrapInResourceSpans([
      {
        spanId: "span1",
        attributes: [
          {
            key: "langfuse.observation.cost_details",
            value: { intValue: 42 },
          },
        ],
      },
    ]);
    const error = processor.validateResourceSpans(spans);
    expect(error).not.toBeNull();
  });
});
