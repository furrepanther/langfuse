/** @jest-environment node */

import { randomUUID } from "node:crypto";
import {
  makeAPICall,
  makeZodVerifiedAPICall,
} from "@/src/__tests__/test-utils";
import {
  DeleteUnstableContinuousEvaluationResponse,
  GetUnstableContinuousEvaluationResponse,
  GetUnstableContinuousEvaluationsResponse,
  PatchUnstableContinuousEvaluationResponse,
  PostUnstableContinuousEvaluationResponse,
} from "@/src/features/public-api/types/unstable-continuous-evaluations";
import {
  DeleteUnstableEvaluatorResponse,
  GetUnstableEvaluatorResponse,
  GetUnstableEvaluatorsResponse,
  PatchUnstableEvaluatorResponse,
  PostUnstableEvaluatorResponse,
} from "@/src/features/public-api/types/unstable-evaluators";
import {
  createNumericEvalOutputDefinition,
  EvalTargetObject,
} from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
import {
  createBasicAuthHeader,
  createOrgProjectAndApiKey,
  getDisplaySecretKey,
  hashSecretKey,
} from "@langfuse/shared/src/server";
import { UnstablePublicApiErrorResponse } from "@/src/features/public-api/types/unstable-public-evals-contract";
import type { z } from "zod";

const __orgIds: string[] = [];

const numericOutputDefinition = createNumericEvalOutputDefinition({
  reasoningDescription: "Why the score was assigned",
  scoreDescription: "A score between 0 and 1",
});

const expectUnstableError = (
  response: Awaited<ReturnType<typeof makeAPICall>>,
  params: {
    status: number;
    code: z.infer<typeof UnstablePublicApiErrorResponse>["code"];
  },
) => {
  expect(response.status).toBe(params.status);
  const body = UnstablePublicApiErrorResponse.parse(response.body);
  expect(body.code).toBe(params.code);
  return body;
};

describe("/api/public/unstable evals API", () => {
  let auth: string;
  let projectId: string;

  beforeEach(async () => {
    const result = await createOrgProjectAndApiKey();
    auth = result.auth;
    projectId = result.projectId;
    __orgIds.push(result.orgId);
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({
      where: {
        id: {
          in: __orgIds,
        },
      },
    });
  });

  it("supports evaluator CRUD without exposing version history", async () => {
    const created = await makeZodVerifiedAPICall(
      PostUnstableEvaluatorResponse,
      "POST",
      "/api/public/unstable/evaluators",
      {
        name: "Answer correctness",
        description: "Evaluates answer correctness",
        prompt: "Judge {{input}} against {{output}}",
        outputDefinition: numericOutputDefinition,
      },
      auth,
    );

    expect(created.body).toMatchObject({
      name: "Answer correctness",
      description: "Evaluates answer correctness",
      type: "llm_as_judge",
      variables: ["input", "output"],
      continuousEvaluationCount: 0,
    });

    const fetched = await makeZodVerifiedAPICall(
      GetUnstableEvaluatorResponse,
      "GET",
      `/api/public/unstable/evaluators/${created.body.id}`,
      undefined,
      auth,
    );

    expect(fetched.body).toMatchObject({
      id: created.body.id,
      name: "Answer correctness",
      prompt: "Judge {{input}} against {{output}}",
    });

    const updated = await makeZodVerifiedAPICall(
      PatchUnstableEvaluatorResponse,
      "PATCH",
      `/api/public/unstable/evaluators/${created.body.id}`,
      {
        name: "Updated answer correctness",
        description: null,
        prompt: "Judge {{input}} and score {{output}}",
      },
      auth,
    );

    expect(updated.body).toMatchObject({
      id: created.body.id,
      name: "Updated answer correctness",
      description: null,
      variables: ["input", "output"],
    });

    const listed = await makeZodVerifiedAPICall(
      GetUnstableEvaluatorsResponse,
      "GET",
      "/api/public/unstable/evaluators?page=1&limit=50",
      undefined,
      auth,
    );

    expect(listed.body.meta.totalItems).toBe(1);
    expect(listed.body.data[0]).toMatchObject({
      id: created.body.id,
      name: "Updated answer correctness",
    });

    const deleted = await makeZodVerifiedAPICall(
      DeleteUnstableEvaluatorResponse,
      "DELETE",
      `/api/public/unstable/evaluators/${created.body.id}`,
      undefined,
      auth,
    );

    expect(deleted.body).toEqual({
      message: "Evaluator successfully deleted",
    });

    const missing = await makeAPICall(
      "GET",
      `/api/public/unstable/evaluators/${created.body.id}`,
      undefined,
      auth,
    );

    expectUnstableError(missing, {
      status: 404,
      code: "resource_not_found",
    });
  });

  it("prevents deleting evaluators that are referenced by continuous evaluations", async () => {
    const evaluator = await makeZodVerifiedAPICall(
      PostUnstableEvaluatorResponse,
      "POST",
      "/api/public/unstable/evaluators",
      {
        name: "Groundedness",
        prompt: "Check {{input}} and {{output}}",
        outputDefinition: numericOutputDefinition,
      },
      auth,
    );

    await makeZodVerifiedAPICall(
      PostUnstableContinuousEvaluationResponse,
      "POST",
      "/api/public/unstable/continuous-evaluations",
      {
        name: "groundedness_score",
        evaluatorId: evaluator.body.id,
        target: "observation",
        enabled: true,
        sampling: 1,
        filter: [],
        mapping: [
          { variable: "input", source: "input" },
          { variable: "output", source: "output" },
        ],
      },
      auth,
    );

    const result = await makeAPICall(
      "DELETE",
      `/api/public/unstable/evaluators/${evaluator.body.id}`,
      undefined,
      auth,
    );

    const error = expectUnstableError(result, {
      status: 409,
      code: "evaluator_in_use",
    });
    expect(error).toMatchObject({
      message:
        "Evaluator cannot be deleted while continuous evaluations still reference it",
    });
  });

  it("supports continuous evaluation CRUD for observation targets", async () => {
    const evaluator = await makeZodVerifiedAPICall(
      PostUnstableEvaluatorResponse,
      "POST",
      "/api/public/unstable/evaluators",
      {
        name: "Answer relevance",
        prompt: "Compare {{input}} and {{output}}",
        outputDefinition: numericOutputDefinition,
      },
      auth,
    );

    const created = await makeZodVerifiedAPICall(
      PostUnstableContinuousEvaluationResponse,
      "POST",
      "/api/public/unstable/continuous-evaluations",
      {
        name: "answer_relevance",
        evaluatorId: evaluator.body.id,
        target: "observation",
        enabled: true,
        sampling: 0.5,
        filter: [
          {
            type: "stringOptions",
            column: "type",
            operator: "any of",
            value: ["GENERATION"],
          },
        ],
        mapping: [
          { variable: "input", source: "input" },
          { variable: "output", source: "output" },
        ],
      },
      auth,
    );

    expect(created.body).toMatchObject({
      name: "answer_relevance",
      evaluatorId: evaluator.body.id,
      target: "observation",
      enabled: true,
      status: "active",
      sampling: 0.5,
    });

    const stored = await prisma.jobConfiguration.findUnique({
      where: {
        id: created.body.id,
      },
    });

    expect(stored).toMatchObject({
      targetObject: EvalTargetObject.EVENT,
      scoreName: "answer_relevance",
    });

    const fetched = await makeZodVerifiedAPICall(
      GetUnstableContinuousEvaluationResponse,
      "GET",
      `/api/public/unstable/continuous-evaluations/${created.body.id}`,
      undefined,
      auth,
    );

    expect(fetched.body.filter).toEqual([
      {
        type: "stringOptions",
        column: "type",
        operator: "any of",
        value: ["GENERATION"],
      },
    ]);

    const updated = await makeZodVerifiedAPICall(
      PatchUnstableContinuousEvaluationResponse,
      "PATCH",
      `/api/public/unstable/continuous-evaluations/${created.body.id}`,
      {
        enabled: false,
        sampling: 1,
      },
      auth,
    );

    expect(updated.body).toMatchObject({
      id: created.body.id,
      enabled: false,
      status: "inactive",
      sampling: 1,
    });

    const listed = await makeZodVerifiedAPICall(
      GetUnstableContinuousEvaluationsResponse,
      "GET",
      "/api/public/unstable/continuous-evaluations?page=1&limit=50",
      undefined,
      auth,
    );

    expect(listed.body.meta.totalItems).toBe(1);
    expect(listed.body.data[0]).toMatchObject({
      id: created.body.id,
      name: "answer_relevance",
    });

    const deleted = await makeZodVerifiedAPICall(
      DeleteUnstableContinuousEvaluationResponse,
      "DELETE",
      `/api/public/unstable/continuous-evaluations/${created.body.id}`,
      undefined,
      auth,
    );

    expect(deleted.body).toEqual({
      message: "Continuous evaluation successfully deleted",
    });
  });

  it("allows expected_output mapping only for experiment targets", async () => {
    const evaluator = await makeZodVerifiedAPICall(
      PostUnstableEvaluatorResponse,
      "POST",
      "/api/public/unstable/evaluators",
      {
        name: "Expected output match",
        prompt: "Compare {{output}} to {{expected_output}}",
        outputDefinition: numericOutputDefinition,
      },
      auth,
    );

    const invalidObservation = await makeAPICall(
      "POST",
      "/api/public/unstable/continuous-evaluations",
      {
        name: "expected_output_match",
        evaluatorId: evaluator.body.id,
        target: "observation",
        enabled: true,
        sampling: 1,
        filter: [],
        mapping: [
          { variable: "output", source: "output" },
          { variable: "expected_output", source: "expected_output" },
        ],
      },
      auth,
    );

    const invalidObservationError = expectUnstableError(invalidObservation, {
      status: 400,
      code: "invalid_body",
    });
    expect(invalidObservationError.details).toBeDefined();

    const validExperiment = await makeZodVerifiedAPICall(
      PostUnstableContinuousEvaluationResponse,
      "POST",
      "/api/public/unstable/continuous-evaluations",
      {
        name: "expected_output_match",
        evaluatorId: evaluator.body.id,
        target: "experiment",
        enabled: true,
        sampling: 1,
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
      auth,
    );

    expect(validExperiment.body).toMatchObject({
      target: "experiment",
      mapping: [
        { variable: "output", source: "output" },
        { variable: "expected_output", source: "expected_output" },
      ],
      filter: [
        {
          type: "stringOptions",
          column: "datasetId",
          operator: "any of",
          value: ["dataset-1"],
        },
      ],
    });
  });

  it("supports full continuous evaluation lifecycle for experiment targets", async () => {
    const evaluator = await makeZodVerifiedAPICall(
      PostUnstableEvaluatorResponse,
      "POST",
      "/api/public/unstable/evaluators",
      {
        name: "Experiment output judge",
        prompt: "Compare {{output}} to {{expected_output}}",
        outputDefinition: numericOutputDefinition,
      },
      auth,
    );

    const created = await makeZodVerifiedAPICall(
      PostUnstableContinuousEvaluationResponse,
      "POST",
      "/api/public/unstable/continuous-evaluations",
      {
        name: "experiment_output_judge",
        evaluatorId: evaluator.body.id,
        target: "experiment",
        enabled: true,
        sampling: 1,
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
      auth,
    );

    expect(created.body).toMatchObject({
      target: "experiment",
      status: "active",
      mapping: [
        { variable: "output", source: "output" },
        { variable: "expected_output", source: "expected_output" },
      ],
    });

    const fetched = await makeZodVerifiedAPICall(
      GetUnstableContinuousEvaluationResponse,
      "GET",
      `/api/public/unstable/continuous-evaluations/${created.body.id}`,
      undefined,
      auth,
    );

    expect(fetched.body).toMatchObject({
      id: created.body.id,
      target: "experiment",
      filter: [
        {
          type: "stringOptions",
          column: "datasetId",
          operator: "any of",
          value: ["dataset-1"],
        },
      ],
    });

    const updated = await makeZodVerifiedAPICall(
      PatchUnstableContinuousEvaluationResponse,
      "PATCH",
      `/api/public/unstable/continuous-evaluations/${created.body.id}`,
      {
        target: "experiment",
        enabled: false,
        sampling: 0.25,
        filter: [
          {
            type: "stringOptions",
            column: "datasetId",
            operator: "any of",
            value: ["dataset-2"],
          },
        ],
        mapping: [
          { variable: "output", source: "output" },
          { variable: "expected_output", source: "expected_output" },
        ],
      },
      auth,
    );

    expect(updated.body).toMatchObject({
      id: created.body.id,
      target: "experiment",
      enabled: false,
      status: "inactive",
      sampling: 0.25,
      filter: [
        {
          type: "stringOptions",
          column: "datasetId",
          operator: "any of",
          value: ["dataset-2"],
        },
      ],
    });

    const listed = await makeZodVerifiedAPICall(
      GetUnstableContinuousEvaluationsResponse,
      "GET",
      "/api/public/unstable/continuous-evaluations?page=1&limit=50",
      undefined,
      auth,
    );

    expect(listed.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.body.id,
          target: "experiment",
          enabled: false,
        }),
      ]),
    );

    const deleted = await makeZodVerifiedAPICall(
      DeleteUnstableContinuousEvaluationResponse,
      "DELETE",
      `/api/public/unstable/continuous-evaluations/${created.body.id}`,
      undefined,
      auth,
    );

    expect(deleted.body).toEqual({
      message: "Continuous evaluation successfully deleted",
    });

    const missing = await makeAPICall(
      "GET",
      `/api/public/unstable/continuous-evaluations/${created.body.id}`,
      undefined,
      auth,
    );

    expectUnstableError(missing, {
      status: 404,
      code: "resource_not_found",
    });
  });

  it("does not expose internal templates that do not have a public evaluator id", async () => {
    await prisma.evalTemplate.create({
      data: {
        projectId,
        name: "Internal only evaluator",
        version: 1,
        prompt: "Internal {{input}}",
        vars: ["input"],
        outputDefinition: numericOutputDefinition,
      },
    });

    const listed = await makeZodVerifiedAPICall(
      GetUnstableEvaluatorsResponse,
      "GET",
      "/api/public/unstable/evaluators?page=1&limit=50",
      undefined,
      auth,
    );

    expect(listed.body.meta.totalItems).toBe(0);
    expect(listed.body.data).toEqual([]);
  });

  it("returns structured auth failures for unstable endpoints", async () => {
    const response = await makeAPICall(
      "GET",
      "/api/public/unstable/evaluators?page=1&limit=10",
      undefined,
      `Basic ${Buffer.from("pk-lf-invalid:sk-lf-invalid").toString("base64")}`,
    );

    const error = expectUnstableError(response, {
      status: 401,
      code: "authentication_failed",
    });

    expect(error.message).toContain(
      "Confirm that you've configured the correct host.",
    );
  });

  it("returns access_denied for authenticated organization keys on unstable project endpoints", async () => {
    const publicKey = `pk-lf-org-${randomUUID()}`;
    const secretKey = randomUUID();

    await prisma.apiKey.create({
      data: {
        id: randomUUID(),
        orgId: __orgIds[__orgIds.length - 1],
        publicKey,
        hashedSecretKey: await hashSecretKey(secretKey),
        displaySecretKey: getDisplaySecretKey(secretKey),
        scope: "ORGANIZATION",
      },
    });

    const response = await makeAPICall(
      "GET",
      "/api/public/unstable/evaluators?page=1&limit=10",
      undefined,
      createBasicAuthHeader(publicKey, secretKey),
    );

    const error = expectUnstableError(response, {
      status: 403,
      code: "access_denied",
    });

    expect(error.message).toContain("need to use basic auth with secret key");
  });

  it("returns invalid_body for malformed evaluator payloads", async () => {
    const response = await makeAPICall(
      "POST",
      "/api/public/unstable/evaluators",
      {
        name: "",
        prompt: "Judge {{input}}",
        outputDefinition: numericOutputDefinition,
      },
      auth,
    );

    const error = expectUnstableError(response, {
      status: 400,
      code: "invalid_body",
    });

    expect(error.details).toMatchObject({
      issues: expect.any(Array),
    });
  });

  it("returns detailed invalid_filter_value errors", async () => {
    const evaluator = await makeZodVerifiedAPICall(
      PostUnstableEvaluatorResponse,
      "POST",
      "/api/public/unstable/evaluators",
      {
        name: "Filter validation evaluator",
        prompt: "Judge {{input}}",
        outputDefinition: numericOutputDefinition,
      },
      auth,
    );

    const response = await makeAPICall(
      "POST",
      "/api/public/unstable/continuous-evaluations",
      {
        name: "bad_filter",
        evaluatorId: evaluator.body.id,
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
      auth,
    );

    const error = expectUnstableError(response, {
      status: 400,
      code: "invalid_filter_value",
    });

    expect(error.details).toMatchObject({
      field: "filter[0].value",
      column: "type",
      invalidValues: ["NOT_A_REAL_TYPE"],
    });
  });

  it("returns detailed invalid_json_path errors", async () => {
    const evaluator = await makeZodVerifiedAPICall(
      PostUnstableEvaluatorResponse,
      "POST",
      "/api/public/unstable/evaluators",
      {
        name: "JsonPath validation evaluator",
        prompt: "Judge {{input}}",
        outputDefinition: numericOutputDefinition,
      },
      auth,
    );

    const response = await makeAPICall(
      "POST",
      "/api/public/unstable/continuous-evaluations",
      {
        name: "bad_json_path",
        evaluatorId: evaluator.body.id,
        target: "observation",
        enabled: true,
        sampling: 1,
        filter: [],
        mapping: [{ variable: "input", source: "metadata", jsonPath: "$[" }],
      },
      auth,
    );

    const error = expectUnstableError(response, {
      status: 400,
      code: "invalid_json_path",
    });

    expect(error.details).toMatchObject({
      field: "mapping[0].jsonPath",
      variable: "input",
      value: "$[",
    });
  });

  it("returns detailed mapping coverage errors", async () => {
    const evaluator = await makeZodVerifiedAPICall(
      PostUnstableEvaluatorResponse,
      "POST",
      "/api/public/unstable/evaluators",
      {
        name: "Mapping validation evaluator",
        prompt: "Judge {{input}} and {{output}}",
        outputDefinition: numericOutputDefinition,
      },
      auth,
    );

    const missingResponse = await makeAPICall(
      "POST",
      "/api/public/unstable/continuous-evaluations",
      {
        name: "missing_mapping",
        evaluatorId: evaluator.body.id,
        target: "observation",
        enabled: true,
        sampling: 1,
        filter: [],
        mapping: [{ variable: "input", source: "input" }],
      },
      auth,
    );

    const missingError = expectUnstableError(missingResponse, {
      status: 400,
      code: "missing_variable_mapping",
    });

    expect(missingError.details).toMatchObject({
      field: "mapping",
      variables: ["output"],
    });

    const duplicateResponse = await makeAPICall(
      "POST",
      "/api/public/unstable/continuous-evaluations",
      {
        name: "duplicate_mapping",
        evaluatorId: evaluator.body.id,
        target: "observation",
        enabled: true,
        sampling: 1,
        filter: [],
        mapping: [
          { variable: "input", source: "input" },
          { variable: "input", source: "metadata" },
        ],
      },
      auth,
    );

    const duplicateError = expectUnstableError(duplicateResponse, {
      status: 400,
      code: "duplicate_variable_mapping",
    });

    expect(duplicateError.details).toMatchObject({
      field: "mapping",
      variable: "input",
    });
  });

  it("returns 422 when enabled evaluators cannot pass preflight", async () => {
    const response = await makeAPICall(
      "POST",
      "/api/public/unstable/evaluators",
      {
        name: "Broken evaluator",
        prompt: "Judge {{input}}",
        outputDefinition: numericOutputDefinition,
        modelConfig: {
          provider: "definitely-not-configured",
          model: "missing-model",
        },
      },
      auth,
    );

    const error = expectUnstableError(response, {
      status: 422,
      code: "evaluator_preflight_failed",
    });

    expect(error.details).toMatchObject({
      evaluatorName: "Broken evaluator",
      provider: "definitely-not-configured",
      model: "missing-model",
    });
  });
});
