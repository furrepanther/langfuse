import { invalidateProjectEvalConfigCaches } from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";
import { JobConfigState } from "@langfuse/shared";
import type {
  PatchUnstableContinuousEvaluationBodyType,
  PostUnstableContinuousEvaluationBodyType,
} from "@/src/features/public-api/types/unstable-continuous-evaluations";
import {
  deriveEvaluatorVariables,
  toApiContinuousEvaluation,
  toJobConfigurationInput,
} from "./adapters";
import {
  findPublicContinuousEvaluationOrThrow,
  listPublicContinuousEvaluationConfigs,
  loadEvaluatorForContinuousEvaluation,
} from "./queries";
import { assertEvaluatorDefinitionCanRunForPublicApi } from "./validation";

export async function listPublicContinuousEvaluations(params: {
  projectId: string;
  page: number;
  limit: number;
}) {
  const { configs, totalItems } =
    await listPublicContinuousEvaluationConfigs(params);

  return {
    data: configs.map((config) => toApiContinuousEvaluation(config)),
    meta: {
      page: params.page,
      limit: params.limit,
      totalItems,
      totalPages: Math.ceil(totalItems / params.limit),
    },
  };
}

export async function getPublicContinuousEvaluation(params: {
  projectId: string;
  continuousEvaluationId: string;
}) {
  const config = await findPublicContinuousEvaluationOrThrow(params);
  return toApiContinuousEvaluation(config);
}

export async function createPublicContinuousEvaluation(params: {
  projectId: string;
  input: PostUnstableContinuousEvaluationBodyType;
}) {
  const { template } = await loadEvaluatorForContinuousEvaluation({
    projectId: params.projectId,
    evaluatorId: params.input.evaluatorId,
  });

  const data = toJobConfigurationInput({
    input: {
      name: params.input.name,
      target: params.input.target,
      enabled: params.input.enabled,
      sampling: params.input.sampling,
      filter: params.input.filter,
      mapping: params.input.mapping,
    },
    evaluatorVariables: deriveEvaluatorVariables(template),
  });

  if (data.status === JobConfigState.ACTIVE) {
    await assertEvaluatorDefinitionCanRunForPublicApi({
      projectId: params.projectId,
      template: {
        name: template.name,
        provider: template.provider,
        model: template.model,
        modelParams: template.modelParams,
        outputDefinition: template.outputDefinition,
      },
    });
  }

  const created = await prisma.jobConfiguration.create({
    data: {
      projectId: params.projectId,
      jobType: "EVAL",
      evalTemplateId: template.id,
      scoreName: data.scoreName,
      targetObject: data.targetObject,
      filter: data.filter,
      variableMapping: data.variableMapping,
      sampling: data.sampling,
      delay: 0,
      status: data.status,
      timeScope: ["NEW"],
    },
    include: {
      evalTemplate: {
        select: {
          id: true,
          projectId: true,
          evaluatorId: true,
          name: true,
          vars: true,
          prompt: true,
        },
      },
    },
  });

  if (created.status === JobConfigState.ACTIVE) {
    await invalidateProjectEvalConfigCaches(params.projectId);
  }

  return toApiContinuousEvaluation(created);
}

export async function updatePublicContinuousEvaluation(params: {
  projectId: string;
  continuousEvaluationId: string;
  input: PatchUnstableContinuousEvaluationBodyType;
}) {
  const existing = await findPublicContinuousEvaluationOrThrow({
    projectId: params.projectId,
    continuousEvaluationId: params.continuousEvaluationId,
  });
  const existingPublic = toApiContinuousEvaluation(existing);
  const nextEvaluatorId =
    params.input.evaluatorId ?? existingPublic.evaluatorId;
  const { template } = await loadEvaluatorForContinuousEvaluation({
    projectId: params.projectId,
    evaluatorId: nextEvaluatorId,
  });
  const nextTarget = params.input.target ?? existingPublic.target;
  const nextFilter =
    "filter" in params.input && params.input.filter !== undefined
      ? params.input.filter
      : existingPublic.filter;
  const nextMapping =
    "mapping" in params.input && params.input.mapping !== undefined
      ? params.input.mapping
      : existingPublic.mapping;

  const data = toJobConfigurationInput({
    input: {
      name: params.input.name ?? existingPublic.name,
      target: nextTarget,
      enabled: params.input.enabled ?? existingPublic.enabled,
      sampling: params.input.sampling ?? existingPublic.sampling,
      filter: nextFilter,
      mapping: nextMapping,
    },
    evaluatorVariables: deriveEvaluatorVariables(template),
  });
  const shouldResetBlockState = data.status === JobConfigState.ACTIVE;

  if (shouldResetBlockState) {
    await assertEvaluatorDefinitionCanRunForPublicApi({
      projectId: params.projectId,
      template: {
        name: template.name,
        provider: template.provider,
        model: template.model,
        modelParams: template.modelParams,
        outputDefinition: template.outputDefinition,
      },
    });
  }

  const updated = await prisma.jobConfiguration.update({
    where: {
      id: params.continuousEvaluationId,
      projectId: params.projectId,
    },
    data: {
      evalTemplateId: template.id,
      scoreName: data.scoreName,
      targetObject: data.targetObject,
      filter: data.filter,
      variableMapping: data.variableMapping,
      sampling: data.sampling,
      status: data.status,
      ...(shouldResetBlockState
        ? {
            blockedAt: null,
            blockReason: null,
            blockMessage: null,
          }
        : {}),
    },
    include: {
      evalTemplate: {
        select: {
          id: true,
          projectId: true,
          evaluatorId: true,
          name: true,
          vars: true,
          prompt: true,
        },
      },
    },
  });

  await invalidateProjectEvalConfigCaches(params.projectId);

  return toApiContinuousEvaluation(updated);
}

export async function deletePublicContinuousEvaluation(params: {
  projectId: string;
  continuousEvaluationId: string;
}) {
  const existing = await findPublicContinuousEvaluationOrThrow(params);

  await prisma.jobConfiguration.delete({
    where: {
      id: params.continuousEvaluationId,
      projectId: params.projectId,
    },
  });

  await invalidateProjectEvalConfigCaches(params.projectId);

  return existing;
}
