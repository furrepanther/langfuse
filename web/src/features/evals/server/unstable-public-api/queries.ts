import { EvalTargetObject, LangfuseNotFoundError } from "@langfuse/shared";
import { Prisma, prisma } from "@langfuse/shared/src/db";
import type {
  PrismaClientLike,
  StoredPublicContinuousEvaluationConfig,
  StoredPublicEvaluatorTemplate,
} from "./types";

export function getPrismaClient(client?: PrismaClientLike) {
  return client ?? prisma;
}

export async function findEvaluatorTemplateVersionsOrThrow(params: {
  client?: PrismaClientLike;
  projectId: string;
  evaluatorId: string;
}) {
  const client = getPrismaClient(params.client);

  const templates = await client.evalTemplate.findMany({
    where: {
      projectId: params.projectId,
      evaluatorId: params.evaluatorId,
    },
    orderBy: {
      version: "asc",
    },
  });

  if (templates.length === 0) {
    throw new LangfuseNotFoundError(
      "Evaluator not found within authorized project",
    );
  }

  return templates as StoredPublicEvaluatorTemplate[];
}

export async function findLatestEvaluatorTemplateOrThrow(params: {
  client?: PrismaClientLike;
  projectId: string;
  evaluatorId: string;
}) {
  const templates = await findEvaluatorTemplateVersionsOrThrow(params);
  return templates[templates.length - 1] as StoredPublicEvaluatorTemplate;
}

export async function countContinuousEvaluationsForEvaluator(params: {
  client?: PrismaClientLike;
  projectId: string;
  evaluatorId: string;
}) {
  const client = getPrismaClient(params.client);

  return client.jobConfiguration.count({
    where: {
      projectId: params.projectId,
      targetObject: {
        in: [EvalTargetObject.EVENT, EvalTargetObject.EXPERIMENT],
      },
      evalTemplate: {
        is: {
          projectId: params.projectId,
          evaluatorId: params.evaluatorId,
        },
      },
    },
  });
}

export async function findPublicContinuousEvaluationOrThrow(params: {
  client?: PrismaClientLike;
  projectId: string;
  continuousEvaluationId: string;
}) {
  const client = getPrismaClient(params.client);

  const config = await client.jobConfiguration.findFirst({
    where: {
      id: params.continuousEvaluationId,
      projectId: params.projectId,
      targetObject: {
        in: [EvalTargetObject.EVENT, EvalTargetObject.EXPERIMENT],
      },
      evalTemplate: {
        is: {
          projectId: params.projectId,
          evaluatorId: {
            not: null,
          },
        },
      },
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

  if (!config) {
    throw new LangfuseNotFoundError(
      "Continuous evaluation not found within authorized project",
    );
  }

  return config as StoredPublicContinuousEvaluationConfig;
}

export async function loadEvaluatorForContinuousEvaluation(params: {
  client?: PrismaClientLike;
  projectId: string;
  evaluatorId: string;
}) {
  const template = await findLatestEvaluatorTemplateOrThrow(params);

  return {
    template,
  };
}

export async function listPublicEvaluatorTemplateGroups(params: {
  projectId: string;
  page: number;
  limit: number;
}) {
  const offset = (params.page - 1) * params.limit;
  const [evaluatorRows, totalItemsRes] = await Promise.all([
    prisma.$queryRaw<Array<{ evaluatorId: string; latestUpdatedAt: Date }>>(
      Prisma.sql`
        SELECT
          evaluator_id as "evaluatorId",
          MAX(updated_at) as "latestUpdatedAt"
        FROM eval_templates
        WHERE
          project_id = ${params.projectId}
          AND evaluator_id IS NOT NULL
        GROUP BY evaluator_id
        ORDER BY MAX(updated_at) DESC, evaluator_id ASC
        LIMIT ${params.limit}
        OFFSET ${offset}
      `,
    ),
    prisma.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`
        SELECT
          COUNT(DISTINCT evaluator_id) as count
        FROM eval_templates
        WHERE
          project_id = ${params.projectId}
          AND evaluator_id IS NOT NULL
      `,
    ),
  ]);
  const totalItems =
    totalItemsRes[0] !== undefined ? Number(totalItemsRes[0].count) : 0;
  const evaluatorIds = evaluatorRows.map((row) => row.evaluatorId);

  if (evaluatorIds.length === 0) {
    return {
      totalItems,
      groups: [],
    };
  }

  const templates = await prisma.evalTemplate.findMany({
    where: {
      projectId: params.projectId,
      evaluatorId: {
        in: evaluatorIds,
      },
    },
    orderBy: [{ evaluatorId: "asc" }, { version: "asc" }],
  });

  const groupedTemplates = new Map<string, StoredPublicEvaluatorTemplate[]>();

  for (const template of templates) {
    if (!template.evaluatorId) {
      continue;
    }

    const existing = groupedTemplates.get(template.evaluatorId) ?? [];
    existing.push(template as StoredPublicEvaluatorTemplate);
    groupedTemplates.set(template.evaluatorId, existing);
  }

  const groups = evaluatorIds
    .map((evaluatorId) => groupedTemplates.get(evaluatorId) ?? [])
    .filter(
      (
        group,
      ): group is [
        StoredPublicEvaluatorTemplate,
        ...StoredPublicEvaluatorTemplate[],
      ] => group.length > 0,
    );

  return {
    totalItems,
    groups,
  };
}

export async function countContinuousEvaluationsForEvaluatorIds(params: {
  projectId: string;
  evaluatorIds: string[];
}) {
  if (params.evaluatorIds.length === 0) {
    return {};
  }

  const configs = await prisma.jobConfiguration.findMany({
    where: {
      projectId: params.projectId,
      targetObject: {
        in: [EvalTargetObject.EVENT, EvalTargetObject.EXPERIMENT],
      },
      evalTemplate: {
        is: {
          projectId: params.projectId,
          evaluatorId: {
            in: params.evaluatorIds,
          },
        },
      },
    },
    select: {
      evalTemplate: {
        select: {
          evaluatorId: true,
        },
      },
    },
  });

  return configs.reduce<Record<string, number>>((counts, config) => {
    const evaluatorId = config.evalTemplate?.evaluatorId;

    if (!evaluatorId) {
      return counts;
    }

    counts[evaluatorId] = (counts[evaluatorId] ?? 0) + 1;
    return counts;
  }, {});
}

export async function listPublicContinuousEvaluationConfigs(params: {
  projectId: string;
  page: number;
  limit: number;
}) {
  const [configs, totalItems] = await Promise.all([
    prisma.jobConfiguration.findMany({
      where: {
        projectId: params.projectId,
        targetObject: {
          in: [EvalTargetObject.EVENT, EvalTargetObject.EXPERIMENT],
        },
        evalTemplate: {
          is: {
            projectId: params.projectId,
            evaluatorId: {
              not: null,
            },
          },
        },
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
      orderBy: {
        createdAt: "desc",
      },
      take: params.limit,
      skip: (params.page - 1) * params.limit,
    }),
    prisma.jobConfiguration.count({
      where: {
        projectId: params.projectId,
        targetObject: {
          in: [EvalTargetObject.EVENT, EvalTargetObject.EXPERIMENT],
        },
        evalTemplate: {
          is: {
            projectId: params.projectId,
            evaluatorId: {
              not: null,
            },
          },
        },
      },
    }),
  ]);

  return {
    configs: configs as StoredPublicContinuousEvaluationConfig[],
    totalItems,
  };
}
