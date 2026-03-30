import {
  arrayOptionsFilter,
  categoryOptionsFilter,
  nullFilter,
  numberFilter,
  numberObjectFilter,
  observationEvalFilterColumns,
  PersistedEvalOutputDefinitionSchema,
  publicApiPaginationZod,
  paginationMetaResponseZod,
  stringFilter,
  stringObjectFilter,
  stringOptionsFilter,
  timeFilter,
  experimentEvalFilterColumns,
  ZodModelConfig,
  booleanFilter,
} from "@langfuse/shared";
import { z } from "zod";

export const PublicEvaluatorType = z.literal("llm_as_judge");

export const UnstablePublicApiErrorCode = z.enum([
  "authentication_failed",
  "access_denied",
  "invalid_request",
  "invalid_query",
  "invalid_body",
  "invalid_filter_value",
  "invalid_json_path",
  "invalid_variable_mapping",
  "missing_variable_mapping",
  "duplicate_variable_mapping",
  "resource_not_found",
  "name_conflict",
  "evaluator_in_use",
  "evaluator_preflight_failed",
  "conflict",
  "unprocessable_content",
  "rate_limited",
  "method_not_allowed",
  "internal_error",
]);

export const UnstablePublicApiRateLimitDetails = z
  .object({
    retryAfterSeconds: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
    remaining: z.number().int().nonnegative().optional(),
    resetAt: z.string().optional(),
  })
  .strict();

export const UnstablePublicApiErrorResponse = z
  .object({
    message: z.string(),
    code: UnstablePublicApiErrorCode,
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  })
  .strict();

export const PublicEvaluatorModelConfig = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    modelParams: ZodModelConfig.nullish(),
  })
  .strict();

export const PublicContinuousEvaluationTarget = z.enum([
  "observation",
  "experiment",
]);

export const PublicContinuousEvaluationStatus = z.enum([
  "active",
  "inactive",
  "paused",
]);

export const ObservationContinuousEvaluationMappingSource = z.enum([
  "input",
  "output",
  "metadata",
]);

export const ExperimentContinuousEvaluationMappingSource = z.enum([
  "input",
  "output",
  "metadata",
  "expected_output",
]);

function createMappingSchema<
  TSource extends z.ZodType<
    "input" | "output" | "metadata" | "expected_output"
  >,
>(sourceSchema: TSource) {
  return z
    .object({
      variable: z.string().min(1),
      source: sourceSchema,
      jsonPath: z.string().min(1).optional(),
    })
    .strict();
}

export const ObservationContinuousEvaluationMapping = createMappingSchema(
  ObservationContinuousEvaluationMappingSource,
);

export const ExperimentContinuousEvaluationMapping = createMappingSchema(
  ExperimentContinuousEvaluationMappingSource,
);

export const PublicContinuousEvaluationMapping = z.union([
  ObservationContinuousEvaluationMapping,
  ExperimentContinuousEvaluationMapping,
]);

const filterSchemaFactories = {
  datetime: (columnId: string) =>
    timeFilter.safeExtend({ column: z.literal(columnId) }),
  string: (columnId: string) =>
    stringFilter.safeExtend({ column: z.literal(columnId) }),
  number: (columnId: string) =>
    numberFilter.safeExtend({ column: z.literal(columnId) }),
  stringOptions: (columnId: string) =>
    stringOptionsFilter.safeExtend({ column: z.literal(columnId) }),
  categoryOptions: (columnId: string) =>
    categoryOptionsFilter.safeExtend({ column: z.literal(columnId) }),
  arrayOptions: (columnId: string) =>
    arrayOptionsFilter.safeExtend({ column: z.literal(columnId) }),
  stringObject: (columnId: string) =>
    stringObjectFilter.safeExtend({ column: z.literal(columnId) }),
  numberObject: (columnId: string) =>
    numberObjectFilter.safeExtend({ column: z.literal(columnId) }),
  boolean: (columnId: string) =>
    booleanFilter.safeExtend({ column: z.literal(columnId) }),
  null: (columnId: string) =>
    nullFilter.safeExtend({ column: z.literal(columnId) }),
} as const;

type SupportedFilterFactory = keyof typeof filterSchemaFactories;

function createTargetFilterSchema(
  columns: Array<{ id: string; type: SupportedFilterFactory }>,
) {
  const schemas = columns.map((column) =>
    filterSchemaFactories[column.type](column.id),
  );

  if (schemas.length === 1) {
    return schemas[0]!;
  }

  return z.union(
    schemas as [
      (typeof schemas)[number],
      (typeof schemas)[number],
      ...Array<(typeof schemas)[number]>,
    ],
  );
}

export const OBSERVATION_CONTINUOUS_EVALUATION_FILTER_COLUMNS =
  observationEvalFilterColumns.map((column) => ({
    id: column.id,
    type: column.type as SupportedFilterFactory,
  }));

export const EXPERIMENT_CONTINUOUS_EVALUATION_FILTER_COLUMNS = [
  {
    id: "datasetId",
    type: experimentEvalFilterColumns[0]!.type as SupportedFilterFactory,
  },
];

export const ObservationContinuousEvaluationFilter = createTargetFilterSchema(
  OBSERVATION_CONTINUOUS_EVALUATION_FILTER_COLUMNS,
);

export const ExperimentContinuousEvaluationFilter = createTargetFilterSchema(
  EXPERIMENT_CONTINUOUS_EVALUATION_FILTER_COLUMNS,
);

export const PublicContinuousEvaluationFilter = z.union([
  ObservationContinuousEvaluationFilter,
  ExperimentContinuousEvaluationFilter,
]);

export type PublicEvaluatorModelConfigType = z.infer<
  typeof PublicEvaluatorModelConfig
>;
export type UnstablePublicApiErrorCodeType = z.infer<
  typeof UnstablePublicApiErrorCode
>;
export type PublicContinuousEvaluationTargetType = z.infer<
  typeof PublicContinuousEvaluationTarget
>;
export type PublicContinuousEvaluationStatusType = z.infer<
  typeof PublicContinuousEvaluationStatus
>;
export type PublicContinuousEvaluationMappingType = z.infer<
  typeof PublicContinuousEvaluationMapping
>;
export type PublicContinuousEvaluationFilterType = z.infer<
  typeof PublicContinuousEvaluationFilter
>;

export const UnstablePublicApiPaginationQuery = z
  .object({
    ...publicApiPaginationZod,
  })
  .strict();

export const UnstablePublicApiPaginationResponse = paginationMetaResponseZod;

export const PublicEvaluatorDefinitionInput = z
  .object({
    prompt: z.string().min(1),
    outputDefinition: PersistedEvalOutputDefinitionSchema,
    modelConfig: PublicEvaluatorModelConfig.nullable().optional(),
  })
  .strict();
