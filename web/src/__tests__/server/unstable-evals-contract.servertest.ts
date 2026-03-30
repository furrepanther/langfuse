/** @jest-environment node */

import {
  createNumericEvalOutputDefinition,
  EvalTargetObject,
  JobConfigState,
} from "@langfuse/shared";
import {
  toApiContinuousEvaluation,
  toApiEvaluator,
  toJobConfigurationInput,
} from "@/src/features/evals/server/unstable-public-api/adapters";
import { UnstablePublicApiError } from "@/src/features/public-api/server/unstable-public-api-errors";
import type {
  StoredPublicContinuousEvaluationConfig,
  StoredPublicEvaluatorTemplate,
} from "@/src/features/evals/server/unstable-public-api/types";
import {
  PatchUnstableContinuousEvaluationBody,
  PostUnstableContinuousEvaluationBody,
} from "@/src/features/public-api/types/unstable-continuous-evaluations";

const numericOutputDefinition = createNumericEvalOutputDefinition({
  reasoningDescription: "Why the score was assigned",
  scoreDescription: "A score between 0 and 1",
});

describe("unstable public eval contracts", () => {
  it("rejects observation continuous evaluations that use expected_output mappings", () => {
    const parsed = PostUnstableContinuousEvaluationBody.safeParse({
      name: "answer_quality",
      evaluatorId: "eval_123",
      target: "observation",
      enabled: true,
      sampling: 1,
      filter: [],
      mapping: [
        { variable: "output", source: "output" },
        { variable: "expected_output", source: "expected_output" },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects experiment filter updates unless target is provided", () => {
    const parsed = PatchUnstableContinuousEvaluationBody.safeParse({
      filter: [
        {
          type: "stringOptions",
          column: "datasetId",
          operator: "any of",
          value: ["dataset-1"],
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });
});

describe("unstable public eval adapters", () => {
  it("translates continuous evaluation writes into job configuration inputs", () => {
    const writeModel = toJobConfigurationInput({
      input: {
        name: "expected_output_match",
        target: "experiment",
        enabled: false,
        sampling: 0.25,
        filter: [
          {
            type: "stringOptions",
            column: "datasetId",
            operator: "any of",
            value: ["dataset-1"],
          },
        ],
        mapping: [
          { variable: "output", source: "output" },
          { variable: "expected_output", source: "expected_output" },
        ],
      },
      evaluatorVariables: ["output", "expected_output"],
    });

    expect(writeModel).toMatchObject({
      scoreName: "expected_output_match",
      targetObject: EvalTargetObject.EXPERIMENT,
      sampling: 0.25,
      status: JobConfigState.INACTIVE,
      filter: [
        {
          type: "stringOptions",
          column: "experimentDatasetId",
          operator: "any of",
          value: ["dataset-1"],
        },
      ],
      variableMapping: [
        {
          templateVariable: "output",
          selectedColumnId: "output",
          jsonSelector: null,
        },
        {
          templateVariable: "expected_output",
          selectedColumnId: "experimentItemExpectedOutput",
          jsonSelector: null,
        },
      ],
    });
  });

  it("rejects invalid static filter option values", () => {
    expect(() =>
      toJobConfigurationInput({
        input: {
          name: "answer_quality",
          target: "observation",
          enabled: true,
          sampling: 1,
          filter: [
            {
              type: "stringOptions",
              column: "type",
              operator: "any of",
              value: ["NOT_A_REAL_TYPE"],
            },
          ],
          mapping: [{ variable: "input", source: "input" }],
        },
        evaluatorVariables: ["input"],
      }),
    ).toThrow(UnstablePublicApiError);
  });

  it("rejects malformed jsonPath selectors", () => {
    expect(() =>
      toJobConfigurationInput({
        input: {
          name: "metadata_projection",
          target: "observation",
          enabled: true,
          sampling: 1,
          filter: [],
          mapping: [
            {
              variable: "input",
              source: "metadata",
              jsonPath: "$[",
            },
          ],
        },
        evaluatorVariables: ["input"],
      }),
    ).toThrow('invalid jsonPath "$["');
  });

  it("rejects missing evaluator variable mappings", () => {
    expect(() =>
      toJobConfigurationInput({
        input: {
          name: "answer_quality",
          target: "observation",
          enabled: true,
          sampling: 1,
          filter: [],
          mapping: [{ variable: "input", source: "input" }],
        },
        evaluatorVariables: ["input", "output"],
      }),
    ).toThrow("Missing mappings for evaluator variables: output");
  });

  it("rejects duplicate evaluator variable mappings", () => {
    expect(() =>
      toJobConfigurationInput({
        input: {
          name: "answer_quality",
          target: "observation",
          enabled: true,
          sampling: 1,
          filter: [],
          mapping: [
            { variable: "input", source: "input" },
            { variable: "input", source: "metadata" },
          ],
        },
        evaluatorVariables: ["input"],
      }),
    ).toThrow('Mapping variable "input" can only be mapped once');
  });

  it("translates stored continuous evaluations back into public API records", () => {
    const record = toApiContinuousEvaluation({
      id: "ceval_123",
      projectId: "project_123",
      evalTemplateId: "tmpl_2",
      scoreName: "expected_output_match",
      targetObject: EvalTargetObject.EXPERIMENT,
      filter: [
        {
          type: "stringOptions",
          column: "experimentDatasetId",
          operator: "any of",
          value: ["dataset-1"],
        },
      ],
      variableMapping: [
        {
          templateVariable: "expected_output",
          selectedColumnId: "experimentItemExpectedOutput",
          jsonSelector: null,
        },
      ],
      sampling:
        0.5 as unknown as StoredPublicContinuousEvaluationConfig["sampling"],
      status: JobConfigState.ACTIVE,
      blockedAt: null,
      blockReason: null,
      blockMessage: null,
      createdAt: new Date("2026-03-30T08:00:00.000Z"),
      updatedAt: new Date("2026-03-30T09:00:00.000Z"),
      evalTemplate: {
        id: "tmpl_2",
        projectId: "project_123",
        evaluatorId: "eval_123",
        name: "Expected output match",
        vars: ["expected_output"],
        prompt: "Compare {{expected_output}}",
      },
    } as StoredPublicContinuousEvaluationConfig);

    expect(record).toMatchObject({
      id: "ceval_123",
      name: "expected_output_match",
      evaluatorId: "eval_123",
      target: "experiment",
      enabled: true,
      status: "active",
      filter: [
        {
          type: "stringOptions",
          column: "datasetId",
          operator: "any of",
          value: ["dataset-1"],
        },
      ],
      mapping: [
        {
          variable: "expected_output",
          source: "expected_output",
        },
      ],
    });
  });

  it("builds evaluator responses from the latest template while keeping stable timestamps", () => {
    const evaluator = toApiEvaluator({
      templates: [
        {
          id: "tmpl_1",
          projectId: "project_123",
          evaluatorId: "eval_123",
          name: "Answer correctness",
          description: "v1",
          version: 1,
          prompt: "Judge {{input}}",
          provider: "openai",
          model: "gpt-4.1-mini",
          modelParams: null,
          vars: ["input"],
          outputDefinition: numericOutputDefinition,
          createdAt: new Date("2026-03-29T08:00:00.000Z"),
          updatedAt: new Date("2026-03-29T08:00:00.000Z"),
        },
        {
          id: "tmpl_2",
          projectId: "project_123",
          evaluatorId: "eval_123",
          name: "Answer correctness",
          description: "v2",
          version: 2,
          prompt: "Judge {{input}} against {{output}}",
          provider: "openai",
          model: "gpt-4.1-mini",
          modelParams: { temperature: 0 },
          vars: ["input", "output"],
          outputDefinition: numericOutputDefinition,
          createdAt: new Date("2026-03-29T08:00:00.000Z"),
          updatedAt: new Date("2026-03-30T08:00:00.000Z"),
        },
      ] as StoredPublicEvaluatorTemplate[],
      continuousEvaluationCount: 3,
    });

    expect(evaluator).toMatchObject({
      id: "eval_123",
      name: "Answer correctness",
      description: "v2",
      prompt: "Judge {{input}} against {{output}}",
      variables: ["input", "output"],
      continuousEvaluationCount: 3,
    });
    expect(evaluator.createdAt.toISOString()).toBe("2026-03-29T08:00:00.000Z");
    expect(evaluator.updatedAt.toISOString()).toBe("2026-03-30T08:00:00.000Z");
  });
});
