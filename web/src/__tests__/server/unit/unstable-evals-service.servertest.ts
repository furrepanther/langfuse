/** @jest-environment node */

const mockEvalTemplateCreate = jest.fn();
const mockJobConfigurationUpdateMany = jest.fn();

jest.mock(
  "../../../features/evals/server/unstable-public-api/validation",
  () => {
    const actual = jest.requireActual(
      "../../../features/evals/server/unstable-public-api/validation",
    );

    return {
      ...actual,
      assertEvaluatorDefinitionCanRunForPublicApi: jest.fn(),
      assertEvaluatorNameIsAvailable: jest.fn(),
    };
  },
);

jest.mock("../../../features/evals/server/unstable-public-api/queries", () => ({
  findEvaluatorTemplateVersionsOrThrow: jest.fn(),
  countContinuousEvaluationsForEvaluator: jest.fn(),
  loadEvaluatorForContinuousEvaluation: jest.fn(),
  findPublicContinuousEvaluationOrThrow: jest.fn(),
}));

jest.mock("@langfuse/shared/src/server", () => ({
  invalidateProjectEvalConfigCaches: jest.fn(),
  ClickHouseClientManager: {
    getInstance: () => ({
      closeAllConnections: jest.fn().mockResolvedValue(undefined),
    }),
  },
  logger: {
    debug: jest.fn(),
  },
  redis: {
    status: "end",
    disconnect: jest.fn(),
  },
}));

jest.mock("@langfuse/shared/src/db", () => ({
  prisma: {
    $transaction: jest.fn(),
    jobConfiguration: {
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

import {
  createNumericEvalOutputDefinition,
  EvalTargetObject,
  JobConfigState,
} from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
import { createUnstablePublicApiError } from "@/src/features/public-api/server/unstable-public-api-error-contract";
import {
  createPublicContinuousEvaluation,
  updatePublicContinuousEvaluation,
} from "@/src/features/evals/server/unstable-public-api/continuous-evaluation-service";
import {
  createPublicEvaluator,
  updatePublicEvaluator,
} from "@/src/features/evals/server/unstable-public-api/evaluator-service";
import * as queryModule from "@/src/features/evals/server/unstable-public-api/queries";
import * as validationModule from "@/src/features/evals/server/unstable-public-api/validation";

const numericOutputDefinition = createNumericEvalOutputDefinition({
  reasoningDescription: "Why the score was assigned",
  scoreDescription: "A score between 0 and 1",
});

const evaluatorTemplate = {
  id: "tmpl_1",
  projectId: "project_123",
  evaluatorId: "eval_123",
  name: "Answer correctness",
  description: null,
  version: 1,
  prompt: "Judge {{input}}",
  provider: null,
  model: null,
  modelParams: null,
  vars: ["input"],
  outputDefinition: numericOutputDefinition,
  createdAt: new Date("2026-03-30T08:00:00.000Z"),
  updatedAt: new Date("2026-03-30T08:00:00.000Z"),
};

const mockedPrisma = prisma as unknown as {
  $transaction: jest.Mock;
  jobConfiguration: {
    create: jest.Mock;
    update: jest.Mock;
  };
};
const mockAssertEvaluatorDefinitionCanRunForPublicApi = jest.mocked(
  validationModule.assertEvaluatorDefinitionCanRunForPublicApi,
);
const _mockAssertEvaluatorNameIsAvailable = jest.mocked(
  validationModule.assertEvaluatorNameIsAvailable,
);
const _mockFindEvaluatorTemplateVersionsOrThrow = jest.mocked(
  queryModule.findEvaluatorTemplateVersionsOrThrow,
);
const mockCountContinuousEvaluationsForEvaluator = jest.mocked(
  queryModule.countContinuousEvaluationsForEvaluator,
);
const mockLoadEvaluatorForContinuousEvaluation = jest.mocked(
  queryModule.loadEvaluatorForContinuousEvaluation,
);
const mockFindPublicContinuousEvaluationOrThrow = jest.mocked(
  queryModule.findPublicContinuousEvaluationOrThrow,
);

const createContinuousEvaluationRecord = (
  overrides?: Record<string, unknown>,
) =>
  ({
    id: "ceval_123",
    projectId: "project_123",
    evalTemplateId: "tmpl_1",
    scoreName: "answer_quality",
    targetObject: EvalTargetObject.EVENT,
    filter: [],
    variableMapping: [
      {
        templateVariable: "input",
        selectedColumnId: "input",
        jsonSelector: null,
      },
    ],
    sampling: 1,
    status: JobConfigState.ACTIVE,
    blockedAt: null,
    blockReason: null,
    blockMessage: null,
    createdAt: new Date("2026-03-30T08:00:00.000Z"),
    updatedAt: new Date("2026-03-30T09:00:00.000Z"),
    evalTemplate: {
      id: "tmpl_1",
      projectId: "project_123",
      evaluatorId: "eval_123",
      name: "Answer correctness",
      vars: ["input"],
      prompt: "Judge {{input}}",
    },
    ...overrides,
  }) as any;

describe("unstable public eval services", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEvalTemplateCreate.mockReset();
    mockJobConfigurationUpdateMany.mockReset();

    mockedPrisma.$transaction.mockImplementation(async (callback) =>
      callback({
        evalTemplate: {
          create: mockEvalTemplateCreate,
        },
        jobConfiguration: {
          updateMany: mockJobConfigurationUpdateMany,
        },
      }),
    );
  });

  it("rejects unrunnable evaluator submissions before writing", async () => {
    mockAssertEvaluatorDefinitionCanRunForPublicApi.mockRejectedValueOnce(
      createUnstablePublicApiError({
        httpCode: 422,
        code: "evaluator_preflight_failed",
        message: "No valid LLM model found for evaluator",
      }),
    );

    await expect(
      createPublicEvaluator({
        projectId: "project_123",
        input: {
          name: "Answer correctness",
          prompt: "Judge {{input}}",
          outputDefinition: numericOutputDefinition,
        },
      }),
    ).rejects.toThrow("No valid LLM model found for evaluator");

    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockEvalTemplateCreate).not.toHaveBeenCalled();
  });

  it("rejects unrunnable enabled continuous evaluations before writing", async () => {
    mockLoadEvaluatorForContinuousEvaluation.mockResolvedValueOnce({
      template: evaluatorTemplate,
    });
    mockAssertEvaluatorDefinitionCanRunForPublicApi.mockRejectedValueOnce(
      createUnstablePublicApiError({
        httpCode: 422,
        code: "evaluator_preflight_failed",
        message: "Model configuration not valid for evaluator",
      }),
    );

    await expect(
      createPublicContinuousEvaluation({
        projectId: "project_123",
        input: {
          name: "answer_quality",
          evaluatorId: "eval_123",
          target: "observation",
          enabled: true,
          sampling: 1,
          filter: [],
          mapping: [{ variable: "input", source: "input" }],
        },
      }),
    ).rejects.toThrow("Model configuration not valid for evaluator");

    expect(mockedPrisma.jobConfiguration.create).not.toHaveBeenCalled();
  });

  it("allows disabled continuous evaluations without preflight", async () => {
    mockLoadEvaluatorForContinuousEvaluation.mockResolvedValueOnce({
      template: evaluatorTemplate,
    });
    mockedPrisma.jobConfiguration.create.mockResolvedValueOnce(
      createContinuousEvaluationRecord({
        status: JobConfigState.INACTIVE,
      }),
    );

    const result = await createPublicContinuousEvaluation({
      projectId: "project_123",
      input: {
        name: "answer_quality",
        evaluatorId: "eval_123",
        target: "observation",
        enabled: false,
        sampling: 1,
        filter: [],
        mapping: [{ variable: "input", source: "input" }],
      },
    });

    expect(
      mockAssertEvaluatorDefinitionCanRunForPublicApi,
    ).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      enabled: false,
      status: "inactive",
    });
  });

  it("preserves block metadata when updating without a fresh successful preflight", async () => {
    mockFindPublicContinuousEvaluationOrThrow.mockResolvedValueOnce(
      createContinuousEvaluationRecord({
        blockedAt: new Date("2026-03-30T10:00:00.000Z"),
        blockReason: "EVAL_MODEL_CONFIG_INVALID",
        blockMessage: "Evaluator paused",
      }),
    );
    mockLoadEvaluatorForContinuousEvaluation.mockResolvedValueOnce({
      template: evaluatorTemplate,
    });
    mockedPrisma.jobConfiguration.update.mockImplementationOnce(
      async ({ data }: any) =>
        createContinuousEvaluationRecord({
          status: data.status,
          sampling: data.sampling,
          filter: data.filter,
          variableMapping: data.variableMapping,
          blockedAt: new Date("2026-03-30T10:00:00.000Z"),
          blockReason: "EVAL_MODEL_CONFIG_INVALID",
          blockMessage: "Evaluator paused",
        }),
    );

    const result = await updatePublicContinuousEvaluation({
      projectId: "project_123",
      continuousEvaluationId: "ceval_123",
      input: {
        enabled: false,
      },
    });

    const updateArgs = mockedPrisma.jobConfiguration.update.mock.calls[0]?.[0];

    expect(
      mockAssertEvaluatorDefinitionCanRunForPublicApi,
    ).not.toHaveBeenCalled();
    expect(updateArgs?.data).not.toHaveProperty("blockedAt");
    expect(updateArgs?.data).not.toHaveProperty("blockReason");
    expect(updateArgs?.data).not.toHaveProperty("blockMessage");
    expect(result).toMatchObject({
      enabled: false,
      status: "inactive",
      pausedReason: "EVAL_MODEL_CONFIG_INVALID",
    });
  });

  it("clears block metadata after a fresh successful preflight on enabled updates", async () => {
    mockFindPublicContinuousEvaluationOrThrow.mockResolvedValueOnce(
      createContinuousEvaluationRecord({
        blockedAt: new Date("2026-03-30T10:00:00.000Z"),
        blockReason: "EVAL_MODEL_CONFIG_INVALID",
        blockMessage: "Evaluator paused",
      }),
    );
    mockLoadEvaluatorForContinuousEvaluation.mockResolvedValueOnce({
      template: evaluatorTemplate,
    });
    mockedPrisma.jobConfiguration.update.mockImplementationOnce(
      async ({ data }: any) =>
        createContinuousEvaluationRecord({
          status: data.status,
          sampling: data.sampling,
          filter: data.filter,
          variableMapping: data.variableMapping,
          blockedAt: data.blockedAt,
          blockReason: data.blockReason,
          blockMessage: data.blockMessage,
        }),
    );

    const result = await updatePublicContinuousEvaluation({
      projectId: "project_123",
      continuousEvaluationId: "ceval_123",
      input: {
        enabled: true,
      },
    });

    const updateArgs = mockedPrisma.jobConfiguration.update.mock.calls[0]?.[0];

    expect(
      mockAssertEvaluatorDefinitionCanRunForPublicApi,
    ).toHaveBeenCalledTimes(1);
    expect(updateArgs?.data).toMatchObject({
      blockedAt: null,
      blockReason: null,
      blockMessage: null,
    });
    expect(result).toMatchObject({
      enabled: true,
      status: "active",
      pausedReason: null,
    });
  });

  it("repoints all continuous evaluations when an evaluator is updated", async () => {
    const existingTemplates = [
      {
        ...evaluatorTemplate,
        id: "tmpl_1",
        version: 1,
        createdAt: new Date("2026-03-30T08:00:00.000Z"),
        updatedAt: new Date("2026-03-30T08:00:00.000Z"),
      },
      {
        ...evaluatorTemplate,
        id: "tmpl_2",
        version: 2,
        prompt: "Judge {{input}} in detail",
        createdAt: new Date("2026-03-30T08:00:00.000Z"),
        updatedAt: new Date("2026-03-30T09:00:00.000Z"),
      },
    ];
    const createdTemplate = {
      ...evaluatorTemplate,
      id: "tmpl_3",
      version: 3,
      name: "Answer correctness v3",
      description: "Latest version",
      prompt: "Judge {{input}} and explain {{output}}",
      vars: ["input", "output"],
      createdAt: new Date("2026-03-30T10:00:00.000Z"),
      updatedAt: new Date("2026-03-30T10:00:00.000Z"),
    };

    _mockFindEvaluatorTemplateVersionsOrThrow.mockResolvedValueOnce(
      existingTemplates as any,
    );
    mockCountContinuousEvaluationsForEvaluator.mockResolvedValueOnce(2);
    mockEvalTemplateCreate.mockResolvedValueOnce(createdTemplate);

    const result = await updatePublicEvaluator({
      projectId: "project_123",
      evaluatorId: "eval_123",
      input: {
        name: "Answer correctness v3",
        description: "Latest version",
        prompt: "Judge {{input}} and explain {{output}}",
      },
    });

    expect(
      mockAssertEvaluatorDefinitionCanRunForPublicApi,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_123",
        template: expect.objectContaining({
          name: "Answer correctness v3",
        }),
      }),
    );
    expect(mockEvalTemplateCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          evaluatorId: "eval_123",
          version: 3,
          prompt: "Judge {{input}} and explain {{output}}",
          vars: ["input", "output"],
        }),
      }),
    );
    expect(mockJobConfigurationUpdateMany).toHaveBeenCalledWith({
      where: {
        projectId: "project_123",
        evalTemplateId: {
          in: ["tmpl_1", "tmpl_2"],
        },
      },
      data: {
        evalTemplateId: "tmpl_3",
      },
    });
    expect(result).toMatchObject({
      id: "eval_123",
      name: "Answer correctness v3",
      prompt: "Judge {{input}} and explain {{output}}",
      variables: ["input", "output"],
      continuousEvaluationCount: 2,
    });
  });

  it("rejects enabled updates when evaluator preflight fails and does not persist changes", async () => {
    mockFindPublicContinuousEvaluationOrThrow.mockResolvedValueOnce(
      createContinuousEvaluationRecord({
        status: JobConfigState.INACTIVE,
      }),
    );
    mockLoadEvaluatorForContinuousEvaluation.mockResolvedValueOnce({
      template: evaluatorTemplate,
    });
    mockAssertEvaluatorDefinitionCanRunForPublicApi.mockRejectedValueOnce(
      createUnstablePublicApiError({
        httpCode: 422,
        code: "evaluator_preflight_failed",
        message: "Evaluator cannot run right now",
      }),
    );

    await expect(
      updatePublicContinuousEvaluation({
        projectId: "project_123",
        continuousEvaluationId: "ceval_123",
        input: {
          enabled: true,
        },
      }),
    ).rejects.toThrow("Evaluator cannot run right now");

    expect(mockedPrisma.jobConfiguration.update).not.toHaveBeenCalled();
  });
});
