import { EvalTargetObject, LangfuseNotFoundError } from "@langfuse/shared";
import { Prisma, prisma } from "@langfuse/shared/src/db";
import type {
  ContinuousEvaluationEvaluatorFamilyReference,
  PrismaClientLike,
  StoredPublicContinuousEvaluationConfig,
  StoredPublicEvaluatorTemplate,
} from "./types";

export function getPrismaClient(client?: PrismaClientLike) {
  return client ?? prisma;
}

export async function findPublicEvaluatorTemplateOrThrow(params: {
  client?: PrismaClientLike;
  projectId: string;
  evaluatorId: string;
}) {
  const client = getPrismaClient(params.client);

  const template = await client.evalTemplate.findUnique({
    where: {
      id: params.evaluatorId,
    },
  });

  if (
    !template ||
    (template.projectId !== params.projectId && template.projectId !== null)
  ) {
    throw new LangfuseNotFoundError(
      "Evaluator not found within authorized project",
    );
  }

  return template as StoredPublicEvaluatorTemplate;
}

export async function findLatestPublicEvaluatorTemplateInFamilyOrThrow(params: {
  client?: PrismaClientLike;
  projectId: string;
  evaluator: ContinuousEvaluationEvaluatorFamilyReference;
}) {
  const client = getPrismaClient(params.client);
  const latestTemplate = await client.evalTemplate.findFirst({
    where: {
      name: params.evaluator.name,
      projectId: params.evaluator.scope === "project" ? params.projectId : null,
    },
    orderBy: {
      version: "desc",
    },
  });

  if (!latestTemplate) {
    throw new LangfuseNotFoundError(
      "Latest evaluator version not found within authorized project",
    );
  }

  return latestTemplate as StoredPublicEvaluatorTemplate;
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
      evalTemplateId: params.evaluatorId,
    },
  });
}

export async function countContinuousEvaluationsForEvaluatorIds(params: {
  client?: PrismaClientLike;
  projectId: string;
  evaluatorIds: string[];
}) {
  if (params.evaluatorIds.length === 0) {
    return {};
  }

  const client = getPrismaClient(params.client);
  const groups = await client.jobConfiguration.groupBy({
    by: ["evalTemplateId"],
    where: {
      projectId: params.projectId,
      targetObject: {
        in: [EvalTargetObject.EVENT, EvalTargetObject.EXPERIMENT],
      },
      evalTemplateId: {
        in: params.evaluatorIds,
      },
    },
    _count: {
      _all: true,
    },
  });

  return groups.reduce<Record<string, number>>((counts, group) => {
    if (!group.evalTemplateId) {
      return counts;
    }

    counts[group.evalTemplateId] = group._count._all;
    return counts;
  }, {});
}

export async function listPublicEvaluatorTemplates(params: {
  projectId: string;
  page: number;
  limit: number;
}) {
  const offset = (params.page - 1) * params.limit;
  const [evaluatorRows, totalItemsRes] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        WITH latest_templates AS (
          SELECT DISTINCT ON (project_id, name)
            id,
            project_id,
            name,
            updated_at
          FROM eval_templates
          WHERE project_id = ${params.projectId} OR project_id IS NULL
          ORDER BY project_id, name, version DESC
        )
        SELECT id
        FROM latest_templates
        ORDER BY
          CASE WHEN project_id IS NULL THEN 1 ELSE 0 END ASC,
          name ASC,
          updated_at DESC,
          id ASC
        LIMIT ${params.limit}
        OFFSET ${offset}
      `,
    ),
    prisma.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`
        SELECT COUNT(*) as count
        FROM (
          SELECT DISTINCT project_id, name
          FROM eval_templates
          WHERE project_id = ${params.projectId} OR project_id IS NULL
        ) latest_template_families
      `,
    ),
  ]);

  const totalItems =
    totalItemsRes[0] !== undefined ? Number(totalItemsRes[0].count) : 0;
  const templateIds = evaluatorRows.map((row) => row.id);

  if (templateIds.length === 0) {
    return {
      totalItems,
      templates: [],
    };
  }

  const templates = await prisma.evalTemplate.findMany({
    where: {
      id: {
        in: templateIds,
      },
    },
  });

  const templateById = new Map(
    templates.map((template) => [
      template.id,
      template as StoredPublicEvaluatorTemplate,
    ]),
  );

  return {
    totalItems,
    templates: templateIds
      .map((id) => templateById.get(id))
      .filter(
        (template): template is StoredPublicEvaluatorTemplate =>
          template !== undefined,
      ),
  };
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
          OR: [{ projectId: params.projectId }, { projectId: null }],
        },
      },
    },
    include: {
      evalTemplate: {
        select: {
          id: true,
          projectId: true,
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
  evaluator: ContinuousEvaluationEvaluatorFamilyReference;
}) {
  const template =
    await findLatestPublicEvaluatorTemplateInFamilyOrThrow(params);

  return {
    template,
  };
}

export async function countActivePublicApiContinuousEvaluations(params: {
  client?: PrismaClientLike;
  projectId: string;
}) {
  const client = getPrismaClient(params.client);
  const result = await client.$queryRaw<Array<{ count: bigint }>>(
    Prisma.sql`
      SELECT COUNT(DISTINCT jc.id) AS count
      FROM job_configurations jc
      INNER JOIN audit_logs al
        ON al.resource_id = jc.id
       AND al.resource_type = 'job'
       AND al.action = 'create'
       AND al.type = 'API_KEY'
       AND al.project_id = ${params.projectId}
      WHERE jc.project_id = ${params.projectId}
        AND jc.job_type = 'EVAL'
        AND jc.target_object IN ('event', 'experiment')
        AND jc.status = 'ACTIVE'
        AND jc.blocked_at IS NULL
    `,
  );

  return result[0] !== undefined ? Number(result[0].count) : 0;
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
            OR: [{ projectId: params.projectId }, { projectId: null }],
          },
        },
      },
      include: {
        evalTemplate: {
          select: {
            id: true,
            projectId: true,
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
            OR: [{ projectId: params.projectId }, { projectId: null }],
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
