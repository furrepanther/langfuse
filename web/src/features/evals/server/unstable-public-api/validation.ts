import {
  experimentEvalFilterColumns,
  observationEvalFilterColumns,
} from "@langfuse/shared";
import { JSONPath } from "jsonpath-plus";
import type {
  PublicContinuousEvaluationFilterType,
  PublicContinuousEvaluationMappingType,
  PublicContinuousEvaluationTargetType,
} from "@/src/features/public-api/types/unstable-public-evals-contract";
import { getEvaluatorDefinitionPreflightError } from "@/src/features/evals/server/evaluator-preflight";
import { createUnstablePublicApiError } from "@/src/features/public-api/server/unstable-public-api-error-contract";
import type { PrismaClientLike } from "./types";
import { getPrismaClient } from "./queries";

const STATIC_FILTER_OPTIONS_BY_TARGET = {
  observation: new Map(
    observationEvalFilterColumns.flatMap((column) => {
      if (!("options" in column) || !Array.isArray(column.options)) {
        return [];
      }

      if (column.options.length === 0) {
        return [];
      }

      return [
        [
          column.id,
          new Set(column.options.map((option) => String(option.value))),
        ] as const,
      ];
    }),
  ),
  experiment: new Map(
    experimentEvalFilterColumns.flatMap((column) => {
      if (!("options" in column) || !Array.isArray(column.options)) {
        return [];
      }

      if (column.options.length === 0) {
        return [];
      }

      return [
        [
          column.id === "experimentDatasetId" ? "datasetId" : column.id,
          new Set(column.options.map((option) => String(option.value))),
        ] as const,
      ];
    }),
  ),
} as const satisfies Record<
  PublicContinuousEvaluationTargetType,
  Map<string, Set<string>>
>;

export function validateContinuousEvaluationFilters(params: {
  target: PublicContinuousEvaluationTargetType;
  filters: PublicContinuousEvaluationFilterType[];
}) {
  const knownOptionValues = STATIC_FILTER_OPTIONS_BY_TARGET[params.target];

  for (const [filterIndex, filter] of params.filters.entries()) {
    const allowedValues = knownOptionValues.get(filter.column);

    if (
      !allowedValues ||
      !("value" in filter) ||
      !Array.isArray(filter.value)
    ) {
      continue;
    }

    const invalidValues = filter.value.filter(
      (value) => !allowedValues.has(value),
    );

    if (invalidValues.length > 0) {
      throw createUnstablePublicApiError({
        httpCode: 400,
        code: "invalid_filter_value",
        message: `Filter column "${filter.column}" contains unsupported value(s): ${invalidValues.join(", ")}`,
        details: {
          field: `filter[${filterIndex}].value`,
          column: filter.column,
          invalidValues,
          allowedValues: Array.from(allowedValues),
        },
      });
    }
  }
}

function validateJsonPath(params: {
  jsonPath: string;
  variable: string;
  mappingIndex: number;
}) {
  const { jsonPath, variable, mappingIndex } = params;

  if (!jsonPath.startsWith("$")) {
    throw createUnstablePublicApiError({
      httpCode: 400,
      code: "invalid_json_path",
      message: `Mapping for variable "${variable}" has an invalid jsonPath "${jsonPath}". JSONPath expressions must start with "$".`,
      details: {
        field: `mapping[${mappingIndex}].jsonPath`,
        variable,
        value: jsonPath,
      },
    });
  }

  const delimiters: Record<string, string> = {
    "[": "]",
    "(": ")",
  };
  const closingDelimiters = new Set(Object.values(delimiters));
  const stack: string[] = [];
  let activeQuote: "'" | '"' | null = null;

  for (let i = 0; i < jsonPath.length; i++) {
    const char = jsonPath[i];
    const previousChar = i > 0 ? jsonPath[i - 1] : null;

    if ((char === "'" || char === '"') && previousChar !== "\\") {
      if (activeQuote === char) {
        activeQuote = null;
      } else if (!activeQuote) {
        activeQuote = char;
      }
      continue;
    }

    if (activeQuote) {
      continue;
    }

    if (char in delimiters) {
      stack.push(char);
      continue;
    }

    if (closingDelimiters.has(char)) {
      const openingDelimiter = stack.pop();

      if (!openingDelimiter || delimiters[openingDelimiter] !== char) {
        throw createUnstablePublicApiError({
          httpCode: 400,
          code: "invalid_json_path",
          message: `Mapping for variable "${variable}" has an invalid jsonPath "${jsonPath}". JSONPath delimiters are not balanced.`,
          details: {
            field: `mapping[${mappingIndex}].jsonPath`,
            variable,
            value: jsonPath,
          },
        });
      }
    }
  }

  if (activeQuote || stack.length > 0) {
    throw createUnstablePublicApiError({
      httpCode: 400,
      code: "invalid_json_path",
      message: `Mapping for variable "${variable}" has an invalid jsonPath "${jsonPath}". JSONPath delimiters are not balanced.`,
      details: {
        field: `mapping[${mappingIndex}].jsonPath`,
        variable,
        value: jsonPath,
      },
    });
  }

  try {
    JSONPath({
      path: jsonPath,
      json: {},
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw createUnstablePublicApiError({
      httpCode: 400,
      code: "invalid_json_path",
      message: `Mapping for variable "${variable}" has an invalid jsonPath "${jsonPath}". ${message}`,
      details: {
        field: `mapping[${mappingIndex}].jsonPath`,
        variable,
        value: jsonPath,
      },
    });
  }
}

export function validateEvaluatorVariableMappings(params: {
  mappings: PublicContinuousEvaluationMappingType[];
  variables: string[];
}) {
  const variableSet = new Set(params.variables);
  const mappedVariables = new Set<string>();

  for (const [mappingIndex, mapping] of params.mappings.entries()) {
    if (!variableSet.has(mapping.variable)) {
      throw createUnstablePublicApiError({
        httpCode: 400,
        code: "invalid_variable_mapping",
        message: `Mapping variable "${mapping.variable}" is not present in the evaluator prompt`,
        details: {
          field: `mapping[${mappingIndex}].variable`,
          variable: mapping.variable,
        },
      });
    }

    if (mappedVariables.has(mapping.variable)) {
      throw createUnstablePublicApiError({
        httpCode: 400,
        code: "duplicate_variable_mapping",
        message: `Mapping variable "${mapping.variable}" can only be mapped once`,
        details: {
          field: "mapping",
          variable: mapping.variable,
        },
      });
    }

    mappedVariables.add(mapping.variable);
  }

  const missingVariables = params.variables.filter(
    (variable) => !mappedVariables.has(variable),
  );

  if (missingVariables.length > 0) {
    throw createUnstablePublicApiError({
      httpCode: 400,
      code: "missing_variable_mapping",
      message: `Missing mappings for evaluator variables: ${missingVariables.join(", ")}`,
      details: {
        field: "mapping",
        variables: missingVariables,
      },
    });
  }

  for (const [mappingIndex, mapping] of params.mappings.entries()) {
    if (mapping.jsonPath) {
      validateJsonPath({
        jsonPath: mapping.jsonPath,
        variable: mapping.variable,
        mappingIndex,
      });
    }
  }
}

export async function assertEvaluatorNameIsAvailable(params: {
  client?: PrismaClientLike;
  projectId: string;
  name: string;
  evaluatorId?: string;
}) {
  const client = getPrismaClient(params.client);

  const conflictingTemplate = await client.evalTemplate.findFirst({
    where: params.evaluatorId
      ? {
          projectId: params.projectId,
          name: params.name,
          NOT: {
            evaluatorId: params.evaluatorId,
          },
        }
      : {
          projectId: params.projectId,
          name: params.name,
        },
    select: {
      id: true,
    },
  });

  if (conflictingTemplate) {
    throw createUnstablePublicApiError({
      httpCode: 409,
      code: "name_conflict",
      message: `An evaluator with name "${params.name}" already exists in this project`,
      details: {
        field: "name",
        value: params.name,
      },
    });
  }
}

export async function assertEvaluatorDefinitionCanRunForPublicApi(params: {
  projectId: string;
  template: {
    name: string;
    provider?: string | null;
    model?: string | null;
    modelParams?: unknown;
    outputDefinition: unknown;
  };
}) {
  const error = await getEvaluatorDefinitionPreflightError(params);

  if (error) {
    throw createUnstablePublicApiError({
      httpCode: 422,
      code: "evaluator_preflight_failed",
      message: error,
      details: {
        evaluatorName: params.template.name,
        provider: params.template.provider ?? null,
        model: params.template.model ?? null,
      },
    });
  }
}
