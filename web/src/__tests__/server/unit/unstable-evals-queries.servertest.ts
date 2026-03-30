/** @jest-environment node */

jest.mock("@langfuse/shared/src/db", () => {
  return {
    Prisma: {
      sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
        strings,
        values,
      }),
    },
    prisma: {
      $queryRaw: jest.fn(),
      evalTemplate: {
        findMany: jest.fn(),
      },
      jobConfiguration: {
        findMany: jest.fn(),
      },
    },
  };
});

import { prisma } from "@langfuse/shared/src/db";
import {
  countContinuousEvaluationsForEvaluatorIds,
  listPublicEvaluatorTemplateGroups,
} from "@/src/features/evals/server/unstable-public-api/queries";

const mockQueryRaw = prisma.$queryRaw as jest.Mock;
const mockEvalTemplateFindMany = prisma.evalTemplate.findMany as jest.Mock;
const mockJobConfigurationFindMany = prisma.jobConfiguration
  .findMany as jest.Mock;

describe("unstable public eval queries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("paginates evaluator identities before loading template versions", async () => {
    mockQueryRaw
      .mockResolvedValueOnce([
        {
          evaluatorId: "eval_2",
          latestUpdatedAt: new Date("2026-03-30T10:00:00.000Z"),
        },
        {
          evaluatorId: "eval_1",
          latestUpdatedAt: new Date("2026-03-30T09:00:00.000Z"),
        },
      ])
      .mockResolvedValueOnce([{ count: 3n }]);
    mockEvalTemplateFindMany.mockResolvedValueOnce([
      {
        id: "tmpl_1",
        projectId: "project_123",
        evaluatorId: "eval_1",
        version: 1,
      },
      {
        id: "tmpl_2",
        projectId: "project_123",
        evaluatorId: "eval_1",
        version: 2,
      },
      {
        id: "tmpl_3",
        projectId: "project_123",
        evaluatorId: "eval_2",
        version: 1,
      },
    ]);

    const result = await listPublicEvaluatorTemplateGroups({
      projectId: "project_123",
      page: 2,
      limit: 2,
    });

    expect(mockQueryRaw).toHaveBeenCalledTimes(2);
    expect(mockEvalTemplateFindMany).toHaveBeenCalledWith({
      where: {
        projectId: "project_123",
        evaluatorId: {
          in: ["eval_2", "eval_1"],
        },
      },
      orderBy: [{ evaluatorId: "asc" }, { version: "asc" }],
    });
    expect(result.totalItems).toBe(3);
    expect(result.groups.map((group) => group[0]?.evaluatorId)).toEqual([
      "eval_2",
      "eval_1",
    ]);
    expect(result.groups[1]?.map((template) => template.version)).toEqual([
      1, 2,
    ]);
  });

  it("skips the count query lookup when no evaluator ids are requested", async () => {
    const result = await countContinuousEvaluationsForEvaluatorIds({
      projectId: "project_123",
      evaluatorIds: [],
    });

    expect(result).toEqual({});
    expect(mockJobConfigurationFindMany).not.toHaveBeenCalled();
  });
});
