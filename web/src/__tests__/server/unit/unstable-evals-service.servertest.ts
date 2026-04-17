/** @jest-environment node */

const mockEvalTemplateCreate = jest.fn();
const mockEvalTemplateFindMany = jest.fn();
const mockJobConfigurationFindMany = jest.fn();
const mockJobConfigurationUpdate = jest.fn();

jest.mock(
  "../../../features/evals/server/unstable-public-api/validation",
  () => {
    const actual = jest.requireActual(
      "../../../features/evals/server/unstable-public-api/validation",
    );

    return {
      ...actual,
      assertEvaluatorDefinitionCanRunForPublicApi: jest.fn(),
    };
  },
);

jest.mock("../../../features/evals/server/unstable-public-api/queries", () => ({
  countActiveContinuousEvaluations: jest.fn(),
  findPublicEvaluatorTemplateOrThrow: jest.fn(),
  countContinuousEvaluationsForEvaluator: jest.fn(),
  countContinuousEvaluationsForEvaluatorIds: jest.fn(),
  listPublicEvaluatorTemplates: jest.fn(),
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
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code: string;
      clientVersion: string;

      constructor(
        message: string,
        {
          code,
          clientVersion,
        }: {
          code: string;
          clientVersion: string;
        },
      ) {
        super(message);
        this.code = code;
        this.clientVersion = clientVersion;
      }
    },
  },
  prisma: {
    $transaction: jest.fn(),
    jobConfiguration: {
      findFirst: jest.fn(),
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
import { createPublicEvaluator } from "@/src/features/evals/server/unstable-public-api/evaluator-service";
import * as queryModule from "@/src/features/evals/server/unstable-public-api/queries";
import * as validationModule from "@/src/features/evals/server/unstable-public-api/validation";

const numericOutputDefinition = createNumericEvalOutputDefinition({
  reasoningDescription: "Why the score was assigned",
  scoreDescription: "A score between 0 and 1",
});

const projectTemplate = {
  id: "tmpl_project_v2",
  projectId: "project_123",
  name: "Answer correctness",
  version: 2,
  prompt: "Judge {{input}}",
  partner: null,
  provider: null,
  model: null,
  modelParams: null,
  vars: ["input"],
  outputDefinition: numericOutputDefinition,
  createdAt: new Date("2026-03-30T08:00:00.000Z"),
  updatedAt: new Date("2026-03-30T08:00:00.000Z"),
};

const managedTemplate = {
  id: "tmpl_managed",
  projectId: null,
  name: "Answer correctness",
  version: 7,
  prompt: "Judge {{input}}",
  partner: "ragas",
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
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
};
const mockAssertEvaluatorDefinitionCanRunForPublicApi = jest.mocked(
  validationModule.assertEvaluatorDefinitionCanRunForPublicApi,
);
const mockLoadEvaluatorForContinuousEvaluation = jest.mocked(
  queryModule.loadEvaluatorForContinuousEvaluation,
);
const mockCountActiveContinuousEvaluations = jest.mocked(
  queryModule.countActiveContinuousEvaluations,
);
const mockFindPublicContinuousEvaluationOrThrow = jest.mocked(
  queryModule.findPublicContinuousEvaluationOrThrow,
);
const mockCountContinuousEvaluationsForEvaluator = jest.mocked(
  queryModule.countContinuousEvaluationsForEvaluator,
);

const createContinuousEvaluationRecord = (
  overrides?: Record<string, unknown>,
) =>
  ({
    id: "ceval_123",
    projectId: "project_123",
    evalTemplateId: "tmpl_project_v2",
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
      id: "tmpl_project_v2",
      projectId: "project_123",
      name: "Answer correctness",
      vars: ["input"],
      prompt: "Judge {{input}}",
    },
    ...overrides,
  }) as any;

describe("unstable public eval services", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCountActiveContinuousEvaluations.mockResolvedValue(0);
    mockCountContinuousEvaluationsForEvaluator.mockResolvedValue(0);

    mockedPrisma.$transaction.mockImplementation(async (callback) =>
      callback({
        evalTemplate: {
          create: mockEvalTemplateCreate,
          findMany: mockEvalTemplateFindMany,
        },
        jobConfiguration: {
          findMany: mockJobConfigurationFindMany,
          update: mockJobConfigurationUpdate,
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

  it("creates a new project-owned evaluator family at version 1", async () => {
    mockEvalTemplateFindMany.mockResolvedValueOnce([]);
    mockEvalTemplateCreate.mockResolvedValueOnce({
      ...projectTemplate,
      id: "tmpl_project_v1",
      version: 1,
      createdAt: new Date("2026-03-31T08:00:00.000Z"),
      updatedAt: new Date("2026-03-31T08:00:00.000Z"),
    });

    const result = await createPublicEvaluator({
      projectId: "project_123",
      input: {
        name: "Answer correctness",
        prompt: "Judge {{input}}",
        outputDefinition: numericOutputDefinition,
      },
    });

    expect(mockEvalTemplateFindMany).toHaveBeenCalledWith({
      where: {
        projectId: "project_123",
        name: "Answer correctness",
      },
      select: {
        id: true,
        version: true,
      },
      orderBy: [
        {
          version: "desc",
        },
        {
          createdAt: "desc",
        },
        {
          id: "desc",
        },
      ],
    });
    expect(mockEvalTemplateCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "project_123",
        name: "Answer correctness",
        version: 1,
      }),
    });
    expect(mockJobConfigurationFindMany).not.toHaveBeenCalled();
    expect(mockJobConfigurationUpdate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      id: "tmpl_project_v1",
      version: 1,
      scope: "project",
    });
  });

  it("creates a new evaluator version when the project name already exists", async () => {
    mockCountContinuousEvaluationsForEvaluator.mockResolvedValueOnce(2);
    mockEvalTemplateFindMany.mockResolvedValueOnce([
      {
        id: "tmpl_project_v2",
        version: 2,
      },
      {
        id: "tmpl_project_v1",
        version: 1,
      },
    ]);
    mockJobConfigurationFindMany.mockResolvedValueOnce([
      {
        id: "ceval_123",
        scoreName: "answer_quality",
        variableMapping: [
          {
            templateVariable: "input",
            selectedColumnId: "input",
            jsonSelector: null,
          },
        ],
      },
    ]);
    mockEvalTemplateCreate.mockResolvedValueOnce({
      ...projectTemplate,
      id: "tmpl_project_v3",
      version: 3,
    });

    const result = await createPublicEvaluator({
      projectId: "project_123",
      input: {
        name: "Answer correctness",
        prompt: "Judge {{input}}",
        outputDefinition: numericOutputDefinition,
      },
    });

    expect(mockEvalTemplateCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "project_123",
        name: "Answer correctness",
        version: 3,
      }),
    });
    expect(mockJobConfigurationFindMany).toHaveBeenCalledWith({
      where: {
        projectId: "project_123",
        evalTemplateId: {
          in: ["tmpl_project_v2", "tmpl_project_v1"],
        },
      },
      select: {
        id: true,
        scoreName: true,
        variableMapping: true,
      },
    });
    expect(mockJobConfigurationUpdate).toHaveBeenCalledWith({
      where: {
        id: "ceval_123",
        projectId: "project_123",
      },
      data: {
        evalTemplateId: "tmpl_project_v3",
        variableMapping: [
          {
            templateVariable: "input",
            selectedColumnId: "input",
            jsonSelector: null,
          },
        ],
      },
    });
    expect(result).toMatchObject({
      id: "tmpl_project_v3",
      version: 3,
      scope: "project",
      continuousEvaluationCount: 2,
    });
  });

  it("drops obsolete variable mappings when auto-upgrading linked continuous evaluations", async () => {
    mockEvalTemplateFindMany.mockResolvedValueOnce([
      {
        id: "tmpl_project_v2",
        version: 2,
      },
    ]);
    mockJobConfigurationFindMany.mockResolvedValueOnce([
      {
        id: "ceval_123",
        scoreName: "answer_quality",
        variableMapping: [
          {
            templateVariable: "input",
            selectedColumnId: "input",
            jsonSelector: null,
          },
          {
            templateVariable: "output",
            selectedColumnId: "output",
            jsonSelector: null,
          },
        ],
      },
    ]);
    mockEvalTemplateCreate.mockResolvedValueOnce({
      ...projectTemplate,
      id: "tmpl_project_v3",
      prompt: "Judge {{input}}",
      vars: ["input"],
      version: 3,
    });

    await createPublicEvaluator({
      projectId: "project_123",
      input: {
        name: "Answer correctness",
        prompt: "Judge {{input}}",
        outputDefinition: numericOutputDefinition,
      },
    });

    expect(mockJobConfigurationUpdate).toHaveBeenCalledWith({
      where: {
        id: "ceval_123",
        projectId: "project_123",
      },
      data: {
        evalTemplateId: "tmpl_project_v3",
        variableMapping: [
          {
            templateVariable: "input",
            selectedColumnId: "input",
            jsonSelector: null,
          },
        ],
      },
    });
  });

  it("rejects evaluator version creation when linked continuous evaluations need new mappings", async () => {
    mockEvalTemplateFindMany.mockResolvedValueOnce([
      {
        id: "tmpl_project_v2",
        version: 2,
      },
    ]);
    mockJobConfigurationFindMany.mockResolvedValueOnce([
      {
        id: "ceval_123",
        scoreName: "answer_quality",
        variableMapping: [
          {
            templateVariable: "input",
            selectedColumnId: "input",
            jsonSelector: null,
          },
        ],
      },
    ]);

    await expect(
      createPublicEvaluator({
        projectId: "project_123",
        input: {
          name: "Answer correctness",
          prompt: "Judge {{input}} against {{output}}",
          outputDefinition: numericOutputDefinition,
        },
      }),
    ).rejects.toThrow(
      'Creating a new evaluator version would invalidate the continuous evaluation "answer_quality"',
    );

    expect(mockEvalTemplateCreate).not.toHaveBeenCalled();
    expect(mockJobConfigurationUpdate).not.toHaveBeenCalled();
  });

  it("resolves an older evaluator version to the latest version when creating a continuous evaluation", async () => {
    mockLoadEvaluatorForContinuousEvaluation.mockResolvedValueOnce({
      template: {
        ...projectTemplate,
        id: "tmpl_project_v3",
        version: 3,
      },
    });
    mockedPrisma.jobConfiguration.create.mockResolvedValueOnce(
      createContinuousEvaluationRecord({
        evalTemplateId: "tmpl_project_v3",
        evalTemplate: {
          id: "tmpl_project_v3",
          projectId: "project_123",
          name: "Answer correctness",
          vars: ["input"],
          prompt: "Judge {{input}}",
        },
      }),
    );

    const result = await createPublicContinuousEvaluation({
      projectId: "project_123",
      input: {
        name: "answer_quality_latest",
        evaluator: {
          name: "Answer correctness",
          scope: "project",
        },
        target: "observation",
        enabled: true,
        sampling: 1,
        filter: [],
        mapping: [{ variable: "input", source: "input" }],
      },
    });

    expect(mockLoadEvaluatorForContinuousEvaluation).toHaveBeenCalledWith({
      projectId: "project_123",
      evaluator: {
        name: "Answer correctness",
        scope: "project",
      },
    });
    expect(mockedPrisma.jobConfiguration.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        evalTemplateId: "tmpl_project_v3",
      }),
      include: expect.any(Object),
    });
    expect(result).toMatchObject({
      evaluator: {
        id: "tmpl_project_v3",
        name: "Answer correctness",
        scope: "project",
      },
    });
  });

  it("rejects unrunnable enabled continuous evaluations before writing", async () => {
    mockLoadEvaluatorForContinuousEvaluation.mockResolvedValueOnce({
      template: projectTemplate,
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
          evaluator: {
            name: "Answer correctness",
            scope: "project",
          },
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

  it("returns a conflict when a continuous evaluation name already exists in the project", async () => {
    mockedPrisma.jobConfiguration.findFirst.mockResolvedValueOnce({
      id: "ceval_existing",
    });

    await expect(
      createPublicContinuousEvaluation({
        projectId: "project_123",
        input: {
          name: "answer_quality",
          evaluator: {
            name: "Answer correctness",
            scope: "project",
          },
          target: "observation",
          enabled: true,
          sampling: 1,
          filter: [],
          mapping: [{ variable: "input", source: "input" }],
        },
      }),
    ).rejects.toThrow(
      'A continuous evaluation named "answer_quality" already exists in this project.',
    );

    expect(mockLoadEvaluatorForContinuousEvaluation).not.toHaveBeenCalled();
    expect(mockedPrisma.jobConfiguration.create).not.toHaveBeenCalled();
  });

  it("rejects creating more than 50 active continuous evaluations", async () => {
    mockCountActiveContinuousEvaluations.mockResolvedValueOnce(50);

    await expect(
      createPublicContinuousEvaluation({
        projectId: "project_123",
        input: {
          name: "answer_quality",
          evaluator: {
            name: "Answer correctness",
            scope: "project",
          },
          target: "observation",
          enabled: true,
          sampling: 1,
          filter: [],
          mapping: [{ variable: "input", source: "input" }],
        },
      }),
    ).rejects.toThrow(
      "This project already has the maximum number of active continuous evaluations (50).",
    );

    expect(mockLoadEvaluatorForContinuousEvaluation).not.toHaveBeenCalled();
    expect(mockedPrisma.jobConfiguration.create).not.toHaveBeenCalled();
  });

  it("passes stored modelParams into create-time evaluator preflight", async () => {
    mockLoadEvaluatorForContinuousEvaluation.mockResolvedValueOnce({
      template: {
        ...projectTemplate,
        provider: "openai",
        model: "gpt-4.1-mini",
        modelParams: { temperature: 0.2 },
      },
    });
    mockedPrisma.jobConfiguration.create.mockResolvedValueOnce(
      createContinuousEvaluationRecord(),
    );

    await createPublicContinuousEvaluation({
      projectId: "project_123",
      input: {
        name: "answer_quality",
        evaluator: {
          name: "Answer correctness",
          scope: "project",
        },
        target: "observation",
        enabled: true,
        sampling: 1,
        filter: [],
        mapping: [{ variable: "input", source: "input" }],
      },
    });

    expect(
      mockAssertEvaluatorDefinitionCanRunForPublicApi,
    ).toHaveBeenCalledWith({
      projectId: "project_123",
      template: expect.objectContaining({
        name: "Answer correctness",
        provider: "openai",
        model: "gpt-4.1-mini",
        modelParams: { temperature: 0.2 },
      }),
    });
  });

  it("allows disabled continuous evaluations without preflight", async () => {
    mockLoadEvaluatorForContinuousEvaluation.mockResolvedValueOnce({
      template: projectTemplate,
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
        evaluator: {
          name: "Answer correctness",
          scope: "project",
        },
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
      evaluator: {
        id: "tmpl_project_v2",
        name: "Answer correctness",
        scope: "project",
      },
      enabled: false,
      status: "inactive",
    });
  });

  it("allows continuous evaluations to reference managed evaluators by exact template id", async () => {
    mockLoadEvaluatorForContinuousEvaluation.mockResolvedValueOnce({
      template: managedTemplate,
    });
    mockedPrisma.jobConfiguration.create.mockResolvedValueOnce(
      createContinuousEvaluationRecord({
        evalTemplateId: "tmpl_managed",
        evalTemplate: {
          id: "tmpl_managed",
          projectId: null,
          name: "Answer correctness",
          vars: ["input"],
          prompt: "Judge {{input}}",
        },
      }),
    );

    const result = await createPublicContinuousEvaluation({
      projectId: "project_123",
      input: {
        name: "managed_answer_quality",
        evaluator: {
          name: "Answer correctness",
          scope: "managed",
        },
        target: "observation",
        enabled: true,
        sampling: 1,
        filter: [],
        mapping: [{ variable: "input", source: "input" }],
      },
    });

    expect(mockedPrisma.jobConfiguration.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        evalTemplateId: "tmpl_managed",
      }),
      include: expect.any(Object),
    });
    expect(result).toMatchObject({
      evaluator: {
        id: "tmpl_managed",
        name: "Answer correctness",
        scope: "managed",
      },
      enabled: true,
      status: "active",
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
      template: projectTemplate,
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

  it("passes stored modelParams into update-time evaluator preflight", async () => {
    mockFindPublicContinuousEvaluationOrThrow.mockResolvedValueOnce(
      createContinuousEvaluationRecord(),
    );
    mockLoadEvaluatorForContinuousEvaluation.mockResolvedValueOnce({
      template: {
        ...projectTemplate,
        provider: "openai",
        model: "gpt-4.1-mini",
        modelParams: { temperature: 0.4 },
      },
    });
    mockedPrisma.jobConfiguration.update.mockResolvedValueOnce(
      createContinuousEvaluationRecord(),
    );

    await updatePublicContinuousEvaluation({
      projectId: "project_123",
      continuousEvaluationId: "ceval_123",
      input: {
        name: "renamed_answer_quality",
      },
    });

    expect(
      mockAssertEvaluatorDefinitionCanRunForPublicApi,
    ).toHaveBeenCalledWith({
      projectId: "project_123",
      template: expect.objectContaining({
        name: "Answer correctness",
        provider: "openai",
        model: "gpt-4.1-mini",
        modelParams: { temperature: 0.4 },
      }),
    });
  });

  it("rejects enabling a non-active continuous evaluation when the active limit is reached", async () => {
    mockFindPublicContinuousEvaluationOrThrow.mockResolvedValueOnce(
      createContinuousEvaluationRecord({
        status: JobConfigState.INACTIVE,
      }),
    );
    mockCountActiveContinuousEvaluations.mockResolvedValueOnce(50);

    await expect(
      updatePublicContinuousEvaluation({
        projectId: "project_123",
        continuousEvaluationId: "ceval_123",
        input: {
          enabled: true,
        },
      }),
    ).rejects.toThrow(
      "This project already has the maximum number of active continuous evaluations (50).",
    );

    expect(mockLoadEvaluatorForContinuousEvaluation).not.toHaveBeenCalled();
    expect(mockedPrisma.jobConfiguration.update).not.toHaveBeenCalled();
  });

  it("does not re-check the active limit for already-active continuous evaluations", async () => {
    mockFindPublicContinuousEvaluationOrThrow.mockResolvedValueOnce(
      createContinuousEvaluationRecord(),
    );
    mockLoadEvaluatorForContinuousEvaluation.mockResolvedValueOnce({
      template: projectTemplate,
    });
    mockedPrisma.jobConfiguration.update.mockResolvedValueOnce(
      createContinuousEvaluationRecord({
        scoreName: "renamed_answer_quality",
      }),
    );

    await updatePublicContinuousEvaluation({
      projectId: "project_123",
      continuousEvaluationId: "ceval_123",
      input: {
        name: "renamed_answer_quality",
      },
    });

    expect(mockCountActiveContinuousEvaluations).not.toHaveBeenCalled();
    expect(mockedPrisma.jobConfiguration.update).toHaveBeenCalled();
  });
});
