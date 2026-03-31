import {
  EvalTargetObject,
  extractVariables,
  JobConfigState,
  observationVariableMappingList,
  PersistedEvalOutputDefinitionSchema,
  singleFilter,
  type ObservationVariableMapping,
} from "@langfuse/shared";
import { InternalServerError } from "@langfuse/shared";
import { logger } from "@langfuse/shared/src/server";
import { z } from "zod";
import {
  ExperimentContinuousEvaluationFilter,
  ObservationContinuousEvaluationFilter,
  type PublicContinuousEvaluationFilterType,
  type PublicContinuousEvaluationMappingType,
  type PublicContinuousEvaluationTargetType,
  type PublicEvaluatorModelConfigType,
} from "@/src/features/public-api/types/unstable-public-evals-contract";
import type {
  ApiContinuousEvaluationRecord,
  ApiEvaluatorRecord,
  StoredPublicContinuousEvaluationConfig,
  StoredPublicEvaluatorTemplate,
} from "./types";
import {
  validateContinuousEvaluationFilters,
  validateEvaluatorVariableMappings,
} from "./validation";

const PUBLIC_TARGET_TO_INTERNAL_TARGET_OBJECT: Record<
  PublicContinuousEvaluationTargetType,
  string
> = {
  observation: EvalTargetObject.EVENT,
  experiment: EvalTargetObject.EXPERIMENT,
};

const INTERNAL_TARGET_OBJECT_TO_PUBLIC_TARGET: Record<
  string,
  PublicContinuousEvaluationTargetType
> = {
  [EvalTargetObject.EVENT]: "observation",
  [EvalTargetObject.EXPERIMENT]: "experiment",
};

const PUBLIC_MAPPING_SOURCE_TO_INTERNAL_COLUMN: Record<
  PublicContinuousEvaluationMappingType["source"],
  ObservationVariableMapping["selectedColumnId"]
> = {
  input: "input",
  output: "output",
  metadata: "metadata",
  expected_output: "experimentItemExpectedOutput",
};

const INTERNAL_MAPPING_COLUMN_TO_PUBLIC_SOURCE: Record<
  string,
  PublicContinuousEvaluationMappingType["source"]
> = {
  input: "input",
  output: "output",
  metadata: "metadata",
  expected_output: "expected_output",
  expectedOutput: "expected_output",
  experiment_item_expected_output: "expected_output",
  experimentItemExpectedOutput: "expected_output",
};

function getPublicFilterArraySchema(
  target: PublicContinuousEvaluationTargetType,
) {
  return z.array(
    target === "observation"
      ? ObservationContinuousEvaluationFilter
      : ExperimentContinuousEvaluationFilter,
  );
}

export function toStoredModelConfig(
  modelConfig?: PublicEvaluatorModelConfigType | null,
) {
  if (!modelConfig) {
    return {
      provider: null,
      model: null,
      modelParams: undefined,
    };
  }

  return {
    provider: modelConfig.provider,
    model: modelConfig.model,
    modelParams: undefined,
  };
}

export function deriveEvaluatorVariables(
  template: Pick<StoredPublicEvaluatorTemplate, "vars" | "prompt">,
) {
  return template.vars.length > 0
    ? template.vars
    : extractVariables(template.prompt);
}

export function parseStoredOutputDefinition(
  template: Pick<StoredPublicEvaluatorTemplate, "outputDefinition">,
) {
  const parsed = PersistedEvalOutputDefinitionSchema.safeParse(
    template.outputDefinition,
  );

  if (!parsed.success) {
    logger.error(
      "Failed to parse unstable public evaluator output definition",
      {
        issues: parsed.error.issues,
        templateId: "id" in template ? template.id : undefined,
      },
    );
    throw new InternalServerError("Evaluator output definition is corrupted");
  }

  return parsed.data;
}

export function toApiModelConfig(
  template: Pick<
    StoredPublicEvaluatorTemplate,
    "provider" | "model" | "modelParams"
  >,
): PublicEvaluatorModelConfigType | null {
  if (!template.provider || !template.model) {
    return null;
  }

  return {
    provider: template.provider,
    model: template.model,
  };
}

function toApiContinuousEvaluationStatus(
  config: Pick<StoredPublicContinuousEvaluationConfig, "status" | "blockedAt">,
): ApiContinuousEvaluationRecord["status"] {
  if (config.status === JobConfigState.INACTIVE) {
    return "inactive";
  }

  if (config.blockedAt) {
    return "paused";
  }

  return "active";
}

function assertPublicTarget(
  targetObject: string,
): PublicContinuousEvaluationTargetType {
  const publicTarget = INTERNAL_TARGET_OBJECT_TO_PUBLIC_TARGET[targetObject];

  if (!publicTarget) {
    throw new InternalServerError("Continuous evaluation target is corrupted");
  }

  return publicTarget;
}

function toStoredFilter(
  filter: PublicContinuousEvaluationFilterType,
  target: PublicContinuousEvaluationTargetType,
): PublicContinuousEvaluationFilterType {
  if (target === "experiment" && filter.column === "datasetId") {
    return {
      ...filter,
      column: "experimentDatasetId",
    };
  }

  return filter;
}

function toApiFilter(
  filter: z.infer<typeof singleFilter>,
  target: PublicContinuousEvaluationTargetType,
): PublicContinuousEvaluationFilterType {
  if (target === "experiment" && filter.column === "experimentDatasetId") {
    return {
      ...filter,
      column: "datasetId",
    } as PublicContinuousEvaluationFilterType;
  }

  return filter as PublicContinuousEvaluationFilterType;
}

function toApiMappings(
  mappings: unknown,
): ApiContinuousEvaluationRecord["mapping"] {
  const parsed = observationVariableMappingList.safeParse(mappings);

  if (!parsed.success) {
    logger.error(
      "Failed to parse unstable public continuous evaluation mappings",
      {
        issues: parsed.error.issues,
      },
    );
    throw new InternalServerError("Continuous evaluation mapping is corrupted");
  }

  return parsed.data.map((mapping) => {
    const source =
      INTERNAL_MAPPING_COLUMN_TO_PUBLIC_SOURCE[mapping.selectedColumnId];

    if (!source) {
      throw new InternalServerError(
        "Continuous evaluation mapping is corrupted",
      );
    }

    return {
      variable: mapping.templateVariable,
      source,
      ...(mapping.jsonSelector ? { jsonPath: mapping.jsonSelector } : {}),
    };
  });
}

function toApiFilters(
  filters: unknown,
  target: PublicContinuousEvaluationTargetType,
): ApiContinuousEvaluationRecord["filter"] {
  const storedFilters = z.array(singleFilter).safeParse(filters);

  if (!storedFilters.success) {
    logger.error(
      "Failed to parse unstable public continuous evaluation filters",
      {
        issues: storedFilters.error.issues,
      },
    );
    throw new InternalServerError("Continuous evaluation filter is corrupted");
  }

  const publicFilters = storedFilters.data.map((filter) =>
    toApiFilter(filter, target),
  );
  const parsedPublicFilters =
    getPublicFilterArraySchema(target).safeParse(publicFilters);

  if (!parsedPublicFilters.success) {
    logger.error(
      "Failed to parse unstable public continuous evaluation filters",
      {
        issues: parsedPublicFilters.error.issues,
      },
    );
    throw new InternalServerError("Continuous evaluation filter is corrupted");
  }

  return parsedPublicFilters.data;
}

export function toApiEvaluator(params: {
  template: StoredPublicEvaluatorTemplate;
  continuousEvaluationCount: number;
}): ApiEvaluatorRecord {
  const template = params.template;

  return {
    id: template.id,
    name: template.name,
    version: template.version,
    scope: template.projectId === null ? "managed" : "project",
    type: "llm_as_judge",
    prompt: template.prompt,
    variables: deriveEvaluatorVariables(template),
    outputDefinition: parseStoredOutputDefinition(template),
    modelConfig: toApiModelConfig(template),
    continuousEvaluationCount: params.continuousEvaluationCount,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

export function toApiContinuousEvaluation(
  config: StoredPublicContinuousEvaluationConfig,
): ApiContinuousEvaluationRecord {
  if (!config.evalTemplate?.id) {
    throw new InternalServerError(
      "Continuous evaluation evaluator is corrupted",
    );
  }

  const target = assertPublicTarget(config.targetObject);

  return {
    id: config.id,
    name: config.scoreName,
    evaluatorId: config.evalTemplate.id,
    target,
    enabled: config.status === JobConfigState.ACTIVE,
    status: toApiContinuousEvaluationStatus(config),
    pausedReason: config.blockReason ?? null,
    pausedMessage: config.blockMessage ?? null,
    sampling: Number(config.sampling),
    filter: toApiFilters(config.filter, target),
    mapping: toApiMappings(config.variableMapping),
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

export function toJobConfigurationInput(params: {
  input: {
    name: string;
    target: PublicContinuousEvaluationTargetType;
    enabled: boolean;
    sampling: number;
    filter: PublicContinuousEvaluationFilterType[];
    mapping: PublicContinuousEvaluationMappingType[];
  };
  evaluatorVariables: string[];
}) {
  validateContinuousEvaluationFilters({
    target: params.input.target,
    filters: params.input.filter,
  });
  validateEvaluatorVariableMappings({
    mappings: params.input.mapping,
    variables: params.evaluatorVariables,
    target: params.input.target,
  });

  return {
    scoreName: params.input.name,
    targetObject: PUBLIC_TARGET_TO_INTERNAL_TARGET_OBJECT[params.input.target],
    filter: params.input.filter.map((filter) =>
      toStoredFilter(filter, params.input.target),
    ),
    variableMapping: observationVariableMappingList.parse(
      params.input.mapping.map((mapping) => ({
        templateVariable: mapping.variable,
        selectedColumnId:
          PUBLIC_MAPPING_SOURCE_TO_INTERNAL_COLUMN[mapping.source],
        jsonSelector: mapping.jsonPath ?? null,
      })),
    ),
    sampling: params.input.sampling,
    status: params.input.enabled
      ? JobConfigState.ACTIVE
      : JobConfigState.INACTIVE,
  };
}
