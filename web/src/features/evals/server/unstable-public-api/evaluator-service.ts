import { randomUUID } from "node:crypto";
import {
  extractVariables,
  LangfuseNotFoundError,
  observationVariableMappingList,
} from "@langfuse/shared";
import { Prisma, prisma } from "@langfuse/shared/src/db";
import type {
  PatchUnstableEvaluatorBodyType,
  PostUnstableEvaluatorBodyType,
} from "@/src/features/public-api/types/unstable-evaluators";
import {
  parseStoredOutputDefinition,
  toApiEvaluator,
  toApiModelConfig,
  toStoredModelConfig,
} from "./adapters";
import {
  countContinuousEvaluationsForEvaluator,
  countContinuousEvaluationsForEvaluatorIds,
  findEvaluatorTemplateVersionsOrThrow,
  listPublicEvaluatorTemplateGroups,
} from "./queries";
import {
  assertEvaluatorDefinitionCanRunForPublicApi,
  assertEvaluatorNameIsAvailable,
} from "./validation";
import { createUnstablePublicApiError } from "@/src/features/public-api/server/unstable-public-api-error-contract";

async function loadLockedEvaluatorTemplatesOrThrow(params: {
  tx: Prisma.TransactionClient;
  projectId: string;
  evaluatorId: string;
}) {
  const lockedTemplateIds = await params.tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      SELECT id
      FROM eval_templates
      WHERE
        project_id = ${params.projectId}
        AND evaluator_id = ${params.evaluatorId}
      ORDER BY version ASC
      FOR UPDATE
    `,
  );

  if (lockedTemplateIds.length === 0) {
    throw new LangfuseNotFoundError(
      "Evaluator not found within authorized project",
    );
  }

  return params.tx.evalTemplate.findMany({
    where: {
      id: {
        in: lockedTemplateIds.map((row) => row.id),
      },
    },
    orderBy: {
      version: "asc",
    },
  });
}

function assertReferencedJobConfigurationsSupportVariables(params: {
  jobConfigurations: Array<{
    id: string;
    scoreName: string;
    variableMapping: unknown;
  }>;
  evaluatorVariables: string[];
}) {
  const evaluatorVariableSet = new Set(params.evaluatorVariables);

  for (const config of params.jobConfigurations) {
    const parsedMappings = observationVariableMappingList.safeParse(
      config.variableMapping,
    );

    if (!parsedMappings.success) {
      throw createUnstablePublicApiError({
        httpCode: 409,
        code: "conflict",
        message: `Evaluator cannot be updated because job configuration "${config.scoreName}" has corrupted variable mappings`,
      });
    }

    const mappedVariables = new Set<string>();
    const duplicateVariables = new Set<string>();

    for (const mapping of parsedMappings.data) {
      if (mappedVariables.has(mapping.templateVariable)) {
        duplicateVariables.add(mapping.templateVariable);
      }
      mappedVariables.add(mapping.templateVariable);
    }

    const unsupportedVariables = Array.from(mappedVariables).filter(
      (variable) => !evaluatorVariableSet.has(variable),
    );
    const missingVariables = params.evaluatorVariables.filter(
      (variable) => !mappedVariables.has(variable),
    );

    if (
      duplicateVariables.size > 0 ||
      unsupportedVariables.length > 0 ||
      missingVariables.length > 0
    ) {
      throw createUnstablePublicApiError({
        httpCode: 409,
        code: "conflict",
        message: `Evaluator cannot be updated because job configuration "${config.scoreName}" would have invalid variable mappings after this change`,
        details: {
          variables: Array.from(
            new Set([
              ...Array.from(duplicateVariables),
              ...unsupportedVariables,
              ...missingVariables,
            ]),
          ),
        },
      });
    }
  }
}

export async function listPublicEvaluators(params: {
  projectId: string;
  page: number;
  limit: number;
}) {
  const { groups, totalItems } =
    await listPublicEvaluatorTemplateGroups(params);
  const evaluatorIds = groups
    .map((group) => group[group.length - 1]?.evaluatorId)
    .filter((evaluatorId): evaluatorId is string => Boolean(evaluatorId));
  const continuousEvaluationCounts =
    await countContinuousEvaluationsForEvaluatorIds({
      projectId: params.projectId,
      evaluatorIds,
    });

  return {
    data: groups.map((templates) =>
      toApiEvaluator({
        templates,
        continuousEvaluationCount:
          continuousEvaluationCounts[
            templates[templates.length - 1]!.evaluatorId as string
          ] ?? 0,
      }),
    ),
    meta: {
      page: params.page,
      limit: params.limit,
      totalItems,
      totalPages: Math.ceil(totalItems / params.limit),
    },
  };
}

export async function getPublicEvaluator(params: {
  projectId: string;
  evaluatorId: string;
}) {
  const templates = await findEvaluatorTemplateVersionsOrThrow(params);
  const continuousEvaluationCount =
    await countContinuousEvaluationsForEvaluator(params);

  return toApiEvaluator({
    templates,
    continuousEvaluationCount,
  });
}

export async function createPublicEvaluator(params: {
  projectId: string;
  input: PostUnstableEvaluatorBodyType;
}) {
  await assertEvaluatorDefinitionCanRunForPublicApi({
    projectId: params.projectId,
    template: {
      name: params.input.name,
      provider: params.input.modelConfig?.provider ?? null,
      model: params.input.modelConfig?.model ?? null,
      modelParams: params.input.modelConfig?.modelParams,
      outputDefinition: params.input.outputDefinition,
    },
  });

  return prisma.$transaction(async (tx) => {
    await assertEvaluatorNameIsAvailable({
      client: tx,
      projectId: params.projectId,
      name: params.input.name,
    });

    const evaluatorId = randomUUID();
    const variables = extractVariables(params.input.prompt);
    const modelConfig = toStoredModelConfig(params.input.modelConfig);

    await tx.evalTemplate.create({
      data: {
        projectId: params.projectId,
        evaluatorId,
        name: params.input.name,
        description: params.input.description ?? null,
        version: 1,
        prompt: params.input.prompt,
        provider: modelConfig.provider,
        model: modelConfig.model,
        modelParams: modelConfig.modelParams,
        vars: variables,
        outputDefinition: params.input.outputDefinition,
      },
    });

    const templates = await findEvaluatorTemplateVersionsOrThrow({
      client: tx,
      projectId: params.projectId,
      evaluatorId,
    });

    return toApiEvaluator({
      templates,
      continuousEvaluationCount: 0,
    });
  });
}

export async function updatePublicEvaluator(params: {
  projectId: string;
  evaluatorId: string;
  input: PatchUnstableEvaluatorBodyType;
}) {
  const templates = await findEvaluatorTemplateVersionsOrThrow({
    projectId: params.projectId,
    evaluatorId: params.evaluatorId,
  });
  const latestTemplate = templates[templates.length - 1]!;
  const nextName = params.input.name ?? latestTemplate.name;
  const nextPrompt = params.input.prompt ?? latestTemplate.prompt;
  const requestedModelConfig =
    params.input.modelConfig === undefined
      ? toApiModelConfig(latestTemplate)
      : params.input.modelConfig;
  const nextModelConfig = toStoredModelConfig(requestedModelConfig);
  const nextOutputDefinition =
    params.input.outputDefinition ??
    parseStoredOutputDefinition(latestTemplate);

  await assertEvaluatorDefinitionCanRunForPublicApi({
    projectId: params.projectId,
    template: {
      name: nextName,
      provider: nextModelConfig.provider,
      model: nextModelConfig.model,
      modelParams: nextModelConfig.modelParams,
      outputDefinition: nextOutputDefinition,
    },
  });

  return prisma.$transaction(async (tx) => {
    const currentTemplates = await loadLockedEvaluatorTemplatesOrThrow({
      tx,
      projectId: params.projectId,
      evaluatorId: params.evaluatorId,
    });
    const currentLatestTemplate =
      currentTemplates[currentTemplates.length - 1]!;

    if (currentLatestTemplate.id !== latestTemplate.id) {
      throw createUnstablePublicApiError({
        httpCode: 409,
        code: "conflict",
        message: "Evaluator changed during update. Retry the request.",
      });
    }

    await assertEvaluatorNameIsAvailable({
      client: tx,
      projectId: params.projectId,
      name: nextName,
      evaluatorId: params.evaluatorId,
    });

    const nextVariables = extractVariables(nextPrompt);
    const referencedJobConfigurations = await tx.jobConfiguration.findMany({
      where: {
        projectId: params.projectId,
        evalTemplateId: {
          in: currentTemplates.map((template) => template.id),
        },
      },
      select: {
        id: true,
        scoreName: true,
        variableMapping: true,
      },
    });

    assertReferencedJobConfigurationsSupportVariables({
      jobConfigurations: referencedJobConfigurations,
      evaluatorVariables: nextVariables,
    });

    const createdTemplate = await tx.evalTemplate.create({
      data: {
        projectId: params.projectId,
        evaluatorId: params.evaluatorId,
        name: nextName,
        description:
          params.input.description !== undefined
            ? params.input.description
            : latestTemplate.description,
        version: currentLatestTemplate.version + 1,
        prompt: nextPrompt,
        provider: nextModelConfig.provider,
        model: nextModelConfig.model,
        modelParams: nextModelConfig.modelParams,
        vars: nextVariables,
        outputDefinition: nextOutputDefinition,
      },
    });

    await tx.jobConfiguration.updateMany({
      where: {
        projectId: params.projectId,
        evalTemplateId: {
          in: currentTemplates.map((template) => template.id),
        },
      },
      data: {
        evalTemplateId: createdTemplate.id,
      },
    });

    const continuousEvaluationCount =
      await countContinuousEvaluationsForEvaluator({
        client: tx,
        projectId: params.projectId,
        evaluatorId: params.evaluatorId,
      });

    return toApiEvaluator({
      templates: [...currentTemplates, createdTemplate],
      continuousEvaluationCount,
    });
  });
}

export async function deletePublicEvaluator(params: {
  projectId: string;
  evaluatorId: string;
}) {
  await prisma.$transaction(async (tx) => {
    const templates = await loadLockedEvaluatorTemplatesOrThrow({
      tx,
      projectId: params.projectId,
      evaluatorId: params.evaluatorId,
    });
    const referencingJobConfigurationCount = await tx.jobConfiguration.count({
      where: {
        projectId: params.projectId,
        evalTemplateId: {
          in: templates.map((template) => template.id),
        },
      },
    });

    if (referencingJobConfigurationCount > 0) {
      throw createUnstablePublicApiError({
        httpCode: 409,
        code: "evaluator_in_use",
        message:
          "Evaluator cannot be deleted while job configurations still reference it",
      });
    }

    await tx.evalTemplate.deleteMany({
      where: {
        id: {
          in: templates.map((template) => template.id),
        },
      },
    });
  });
}
