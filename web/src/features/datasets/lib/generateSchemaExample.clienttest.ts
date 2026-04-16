jest.mock("json-schema-faker", () => ({ generateJson: jest.fn() }), {
  virtual: true,
});

import { generateSchemaExample } from "./generateSchemaExample";
import { generateJson } from "json-schema-faker";

const mockGenerateJson = generateJson as jest.MockedFunction<
  typeof generateJson
>;

describe("generateSchemaExample", () => {
  beforeEach(() => {
    mockGenerateJson.mockReset();
  });

  it("generates example for a simple object schema", async () => {
    mockGenerateJson.mockResolvedValue('{\n  "name": "test"\n}');

    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    const result = await generateSchemaExample(schema);
    expect(result).toBe('{\n  "name": "test"\n}');
    expect(mockGenerateJson).toHaveBeenCalledWith(schema, {
      alwaysFakeOptionals: true,
      useDefaultValue: true,
      useExamplesValue: true,
      pretty: true,
    });
  });

  it("returns empty string when generateJson throws", async () => {
    mockGenerateJson.mockRejectedValue(
      new Error("Cannot read properties of undefined (reading 'items')"),
    );

    const schema = {
      type: "object",
      properties: { structure: { type: "array" } },
    };
    const result = await generateSchemaExample(schema);
    expect(result).toBe("");
  });

  it("returns empty string for null schema without calling generateJson", async () => {
    expect(await generateSchemaExample(null)).toBe("");
    expect(mockGenerateJson).not.toHaveBeenCalled();
  });

  it("returns empty string for non-object schema without calling generateJson", async () => {
    expect(await generateSchemaExample("not an object")).toBe("");
    expect(mockGenerateJson).not.toHaveBeenCalled();
  });
});
