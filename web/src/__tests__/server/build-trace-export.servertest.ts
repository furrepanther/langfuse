import { LangfuseNotFoundError, UnauthorizedError } from "@langfuse/shared";
import {
  buildTraceExport,
  TraceDownloadTooLargeError,
  type TraceExportSession,
} from "@/src/features/traces/server/buildTraceExport";
import { TraceObservationsTooLargeError } from "@langfuse/shared/src/server";

const mockGetTraceById = jest.fn();
const mockQueryClickhouse = jest.fn();
const mockShouldSkipObservationsFinal = jest.fn();
const mockGetScoresAndCorrectionsForTraces = jest.fn();
const mockTraceSessionFindFirst = jest.fn();
const mockSendAdminAccessWebhook = jest.fn();

jest.mock("@langfuse/shared/src/server", () => {
  class MockTraceObservationsTooLargeError extends Error {}

  return {
    ...jest.requireActual("@langfuse/shared/src/server"),
    TraceObservationsTooLargeError: MockTraceObservationsTooLargeError,
    getTraceById: (...args: unknown[]) => mockGetTraceById(...args),
    queryClickhouse: (...args: unknown[]) => mockQueryClickhouse(...args),
    shouldSkipObservationsFinal: (...args: unknown[]) =>
      mockShouldSkipObservationsFinal(...args),
    getScoresAndCorrectionsForTraces: (...args: unknown[]) =>
      mockGetScoresAndCorrectionsForTraces(...args),
  };
});

jest.mock("@langfuse/shared/src/db", () => ({
  prisma: {
    traceSession: {
      findFirst: (...args: unknown[]) => mockTraceSessionFindFirst(...args),
    },
  },
}));

jest.mock("../../server/adminAccessWebhook", () => ({
  sendAdminAccessWebhook: (...args: unknown[]) =>
    mockSendAdminAccessWebhook(...args),
}));

const projectId = "project-1";
const traceId = "trace-1";

const makeSession = (overrides?: {
  admin?: boolean;
  projects?: Array<{ id: string }>;
}): TraceExportSession => ({
  user: {
    email: "test@example.com",
    admin: overrides?.admin ?? false,
    organizations: [
      {
        projects: overrides?.projects ?? [{ id: projectId }],
      },
    ],
  },
});

const trace = {
  id: traceId,
  name: "Trace 1",
  timestamp: new Date("2024-01-01T00:00:00.000Z"),
  environment: "default",
  tags: [],
  bookmarked: false,
  public: false,
  release: null,
  version: null,
  input: '{"prompt":"hello"}',
  output: '{"answer":"world"}',
  metadata: { foo: "bar" },
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  sessionId: null,
  userId: null,
  projectId,
};

const observation = {
  id: "obs-1",
  trace_id: traceId,
  project_id: projectId,
  environment: "default",
  type: "SPAN",
  start_time: "2024-01-01 00:00:01.000",
  end_time: "2024-01-01 00:00:02.000",
  name: "Observation 1",
  metadata: { key: "value" },
  parent_observation_id: null,
  level: "DEFAULT",
  status_message: null,
  version: null,
  created_at: "2024-01-01 00:00:01.000",
  updated_at: "2024-01-01 00:00:02.000",
  provided_model_name: null,
  internal_model_id: null,
  model_parameters: null,
  input: '{"input":"secret"}',
  output: '{"output":"secret"}',
  completion_start_time: null,
  prompt_id: null,
  prompt_name: null,
  prompt_version: null,
  usage_details: {},
  cost_details: {},
  provided_cost_details: {},
  provided_usage_details: {},
  total_cost: null,
  usage_pricing_tier_id: null,
  usage_pricing_tier_name: null,
  tool_definitions: null,
  tool_calls: null,
  tool_call_names: null,
  event_ts: "2024-01-01 00:00:02.000",
  is_deleted: 0,
};

const score = {
  id: "score-1",
  projectId,
  environment: "default",
  name: "politeness",
  value: 1,
  source: "EVAL",
  authorUserId: null,
  comment: "helpful",
  metadata: { target_trace_id: traceId },
  configId: null,
  queueId: null,
  executionTraceId: "exec-1",
  createdAt: new Date("2024-01-01T00:00:03.000Z"),
  updatedAt: new Date("2024-01-01T00:00:04.000Z"),
  timestamp: new Date("2024-01-01T00:00:05.000Z"),
  traceId,
  sessionId: null,
  datasetRunId: null,
  observationId: null,
  longStringValue: "",
  stringValue: null,
  dataType: "NUMERIC",
} as const;

describe("buildTraceExport", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTraceById.mockResolvedValue(trace);
    mockQueryClickhouse
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([observation]);
    mockShouldSkipObservationsFinal.mockResolvedValue(false);
    mockGetScoresAndCorrectionsForTraces.mockResolvedValue([score]);
    mockTraceSessionFindFirst.mockResolvedValue(null);
  });

  it("returns scores and observations with stringified payload fields", async () => {
    const result = await buildTraceExport({
      traceId,
      projectId,
      session: makeSession(),
    });

    expect(mockQueryClickhouse).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("AND is_deleted = 0"),
        params: expect.objectContaining({
          traceId,
          projectId,
        }),
      }),
    );
    expect(mockGetScoresAndCorrectionsForTraces).toHaveBeenCalledWith({
      projectId,
      traceIds: [traceId],
      timestamp: trace.timestamp,
    });
    expect(result).toEqual({
      scores: [
        expect.objectContaining({
          id: "score-1",
          traceId,
          observationId: null,
          metadata: '{"target_trace_id":"trace-1"}',
          createdAt: "2024-01-01T00:00:03.000Z",
          updatedAt: "2024-01-01T00:00:04.000Z",
          timestamp: "2024-01-01T00:00:05.000Z",
        }),
      ],
      observations: [
        expect.objectContaining({
          id: "obs-1",
          type: "SPAN",
          name: "Observation 1",
          traceName: "Trace 1",
          userId: "",
          sessionId: "",
          startTime: "2024-01-01T00:00:01.000Z",
          endTime: "2024-01-01T00:00:02.000Z",
          input: '{"input":"secret"}',
          output: '{"output":"secret"}',
          metadata: '{"key":"value"}',
          tags: [],
          bookmarked: false,
          public: false,
        }),
      ],
    });
  });

  it("preserves parent observation ids in the raw export shape", async () => {
    mockQueryClickhouse
      .mockReset()
      .mockResolvedValueOnce([{ count: 3 }])
      .mockResolvedValueOnce([
        observation,
        {
          ...observation,
          id: "obs-2",
          name: "Observation 2",
          parent_observation_id: "obs-1",
        },
        {
          ...observation,
          id: "obs-3",
          name: null,
          type: "GENERATION",
          parent_observation_id: "obs-2",
        },
      ]);

    const result = await buildTraceExport({
      traceId,
      projectId,
      session: makeSession(),
    });

    expect(result.observations).toEqual([
      expect.objectContaining({ id: "obs-1", parentObservationId: null }),
      expect.objectContaining({ id: "obs-2", parentObservationId: "obs-1" }),
      expect.objectContaining({
        id: "obs-3",
        parentObservationId: "obs-2",
        name: null,
      }),
    ]);
  });

  it("omits IO, metadata, toolDefinitions, and toolCalls for large trace exports", async () => {
    mockQueryClickhouse
      .mockReset()
      .mockResolvedValueOnce([{ count: 350 }])
      .mockResolvedValueOnce(
        Array.from({ length: 350 }, (_, idx) => ({
          ...observation,
          id: `obs-${idx + 1}`,
        })),
      );

    const result = await buildTraceExport({
      traceId,
      projectId,
      session: makeSession(),
    });

    expect(result.observations).toHaveLength(350);
    expect(result.observations[0]).not.toHaveProperty("input");
    expect(result.observations[0]).not.toHaveProperty("output");
    expect(result.observations[0]).not.toHaveProperty("metadata");
    expect(result.observations[0]).not.toHaveProperty("toolDefinitions");
    expect(result.observations[0]).not.toHaveProperty("toolCalls");
    expect(result.observations[0]).toHaveProperty("toolCallNames");
  });

  it("does not return deleted observations", async () => {
    const result = await buildTraceExport({
      traceId,
      projectId,
      session: makeSession(),
    });

    expect(result.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "obs-1",
        }),
      ]),
    );
    expect(mockQueryClickhouse).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("AND is_deleted = 0"),
      }),
    );
  });

  it("throws a not-found error when the trace is missing", async () => {
    mockGetTraceById.mockResolvedValue(null);

    await expect(
      buildTraceExport({
        traceId,
        projectId,
        session: makeSession(),
      }),
    ).rejects.toBeInstanceOf(LangfuseNotFoundError);
  });

  it("throws an unauthorized error when the user cannot read the trace", async () => {
    await expect(
      buildTraceExport({
        traceId,
        projectId,
        session: makeSession({ projects: [{ id: "other-project" }] }),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("converts full-export size-limit failures into a client-safe error", async () => {
    const tooLargeError = new Error("Observations in trace are too large");
    Object.setPrototypeOf(
      tooLargeError,
      TraceObservationsTooLargeError.prototype,
    );

    mockQueryClickhouse
      .mockReset()
      .mockResolvedValueOnce([{ count: 1 }])
      .mockRejectedValueOnce(tooLargeError);

    await expect(
      buildTraceExport({
        traceId,
        projectId,
        session: makeSession(),
      }),
    ).rejects.toBeInstanceOf(TraceDownloadTooLargeError);
  });

  it("notifies on admin access", async () => {
    await buildTraceExport({
      traceId,
      projectId,
      session: makeSession({ admin: true, projects: [] }),
    });

    expect(mockSendAdminAccessWebhook).toHaveBeenCalledWith({
      email: "test@example.com",
      projectId,
    });
  });
});
