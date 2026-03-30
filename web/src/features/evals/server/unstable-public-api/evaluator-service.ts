import { randomUUID } from "node:crypto";
import { extractVariables } from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
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
  const nextModelConfig = toStoredModelConfig(
    params.input.modelConfig ?? toApiModelConfig(latestTemplate),
  );
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
    await assertEvaluatorNameIsAvailable({
      client: tx,
      projectId: params.projectId,
      name: nextName,
      evaluatorId: params.evaluatorId,
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
        version: latestTemplate.version + 1,
        prompt: nextPrompt,
        provider: nextModelConfig.provider,
        model: nextModelConfig.model,
        modelParams: nextModelConfig.modelParams,
        vars: extractVariables(nextPrompt),
        outputDefinition: nextOutputDefinition,
      },
    });

    await tx.jobConfiguration.updateMany({
      where: {
        projectId: params.projectId,
        evalTemplateId: {
          in: templates.map((template) => template.id),
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
      templates: [...templates, createdTemplate],
      continuousEvaluationCount,
    });
  });
}

export async function deletePublicEvaluator(params: {
  projectId: string;
  evaluatorId: string;
}) {
  const templates = await findEvaluatorTemplateVersionsOrThrow(params);
  const continuousEvaluationCount =
    await countContinuousEvaluationsForEvaluator(params);

  if (continuousEvaluationCount > 0) {
    throw createUnstablePublicApiError({
      httpCode: 409,
      code: "evaluator_in_use",
      message:
        "Evaluator cannot be deleted while continuous evaluations still reference it",
    });
  }

  await prisma.evalTemplate.deleteMany({
    where: {
      id: {
        in: templates.map((template) => template.id),
      },
    },
  });
}
