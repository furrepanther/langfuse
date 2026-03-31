import { extractVariables } from "@langfuse/shared";
import { Prisma, prisma } from "@langfuse/shared/src/db";
import type { PostUnstableEvaluatorBodyType } from "@/src/features/public-api/types/unstable-evaluators";
import { toApiEvaluator, toStoredModelConfig } from "./adapters";
import {
  countContinuousEvaluationsForEvaluator,
  countContinuousEvaluationsForEvaluatorIds,
  findPublicEvaluatorTemplateOrThrow,
  listPublicEvaluatorTemplates,
} from "./queries";
import { assertEvaluatorDefinitionCanRunForPublicApi } from "./validation";
import { createUnstablePublicApiError } from "@/src/features/public-api/server/unstable-public-api-error-contract";
import type { StoredPublicEvaluatorTemplate } from "./types";

export async function listPublicEvaluators(params: {
  projectId: string;
  page: number;
  limit: number;
}) {
  const { templates, totalItems } = await listPublicEvaluatorTemplates(params);
  const continuousEvaluationCounts =
    await countContinuousEvaluationsForEvaluatorIds({
      projectId: params.projectId,
      evaluatorIds: templates.map((template) => template.id),
    });

  return {
    data: templates.map((template) =>
      toApiEvaluator({
        template,
        continuousEvaluationCount: continuousEvaluationCounts[template.id] ?? 0,
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
  const template = await findPublicEvaluatorTemplateOrThrow(params);
  const continuousEvaluationCount =
    await countContinuousEvaluationsForEvaluator(params);

  return toApiEvaluator({
    template,
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
      outputDefinition: params.input.outputDefinition,
    },
  });

  try {
    const template = await prisma.$transaction(async (tx) => {
      const latestProjectTemplate = await tx.evalTemplate.findFirst({
        where: {
          projectId: params.projectId,
          name: params.input.name,
        },
        orderBy: {
          version: "desc",
        },
        select: {
          version: true,
        },
      });
      const modelConfig = toStoredModelConfig(params.input.modelConfig);

      return tx.evalTemplate.create({
        data: {
          projectId: params.projectId,
          name: params.input.name,
          version: (latestProjectTemplate?.version ?? 0) + 1,
          prompt: params.input.prompt,
          provider: modelConfig.provider,
          model: modelConfig.model,
          modelParams: modelConfig.modelParams,
          vars: extractVariables(params.input.prompt),
          outputDefinition: params.input.outputDefinition,
        },
      });
    });

    return toApiEvaluator({
      template: template as StoredPublicEvaluatorTemplate,
      continuousEvaluationCount: 0,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw createUnstablePublicApiError({
        httpCode: 409,
        code: "conflict",
        message:
          "Evaluator version changed during creation. Retry the request.",
      });
    }

    throw error;
  }
}
