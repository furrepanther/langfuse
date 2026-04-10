import { LangfuseNotFoundError, UnauthorizedError } from "@langfuse/shared";
import {
  buildTraceExport,
  type TraceExportSession,
} from "@/src/features/traces/server/buildTraceExport";

const mockGetTraceById = jest.fn();
const mockGetObservationsCountFromEventsTable = jest.fn();
const mockGetObservationsForTraceFromEventsTable = jest.fn();
const mockGetScoresAndCorrectionsForTraces = jest.fn();
const mockTraceSessionFindFirst = jest.fn();
const mockSendAdminAccessWebhook = jest.fn();

jest.mock("@langfuse/shared/src/server", () => ({
  ...jest.requireActual("@langfuse/shared/src/server"),
  getTraceById: (...args: unknown[]) => mockGetTraceById(...args),
  getObservationsCountFromEventsTable: (...args: unknown[]) =>
    mockGetObservationsCountFromEventsTable(...args),
  getObservationsForTraceFromEventsTable: (...args: unknown[]) =>
    mockGetObservationsForTraceFromEventsTable(...args),
  getScoresAndCorrectionsForTraces: (...args: unknown[]) =>
    mockGetScoresAndCorrectionsForTraces(...args),
}));

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
}): TraceExportSession =>
  ({
    user: {
      email: "test@example.com",
      admin: overrides?.admin ?? false,
      organizations: [
        {
          projects: overrides?.projects ?? [{ id: projectId }],
        },
      ],
    },
  }) as any;

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

const observationRecord = {
  id: "obs-1",
  traceId,
  projectId,
  userId: null,
  sessionId: null,
  environment: "default",
  type: "SPAN",
  startTime: new Date("2024-01-01T00:00:01.000Z"),
  endTime: new Date("2024-01-01T00:00:02.000Z"),
  name: "Observation 1",
  metadata: { key: "value" },
  parentObservationId: null,
  level: "DEFAULT",
  statusMessage: null,
  version: null,
  createdAt: new Date("2024-01-01T00:00:01.000Z"),
  updatedAt: new Date("2024-01-01T00:00:02.000Z"),
  model: null,
  internalModelId: null,
  modelParameters: null,
  input: '{"input":"secret"}',
  output: '{"output":"secret"}',
  completionStartTime: null,
  promptId: null,
  promptName: null,
  promptVersion: null,
  usageDetails: { input: 90, output: 45, total: 135 },
  costDetails: { total: 1.23 },
  providedCostDetails: { total: 1.5 },
  providedUsageDetails: { input: 100, output: 50, total: 150 },
  totalCost: null,
  usagePricingTierId: null,
  usagePricingTierName: null,
  toolDefinitions: null,
  toolCalls: null,
  toolCallNames: null,
} as any;

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
    mockGetObservationsCountFromEventsTable.mockResolvedValue(1);
    mockGetObservationsForTraceFromEventsTable.mockResolvedValue({
      observations: [observationRecord],
      totalCount: 1,
    });
    mockGetScoresAndCorrectionsForTraces.mockResolvedValue([score]);
    mockTraceSessionFindFirst.mockResolvedValue(null);
  });

  it("returns scores and observations with stringified payload fields", async () => {
    const result = await buildTraceExport({
      traceId,
      projectId,
      session: makeSession(),
    });

    expect(mockGetObservationsCountFromEventsTable).toHaveBeenCalledWith({
      projectId,
      filter: [
        { type: "string", operator: "=", column: "traceId", value: traceId },
      ],
    });
    expect(mockGetObservationsForTraceFromEventsTable).toHaveBeenCalledWith({
      traceId,
      projectId,
      selectIOAndMetadata: true,
      selectToolData: true,
    });
    expect(mockGetObservationsForTraceFromEventsTable).toHaveBeenCalledTimes(1);
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
          providedUsageDetails: { input: 100, output: 50, total: 150 },
          usageDetails: { input: 90, output: 45, total: 135 },
          costDetails: { total: 1.23 },
          providedCostDetails: { total: 1.5 },
          tags: [],
          bookmarked: false,
          public: false,
        }),
      ],
    });
  });

  it("preserves parent observation ids in the raw export shape", async () => {
    mockGetObservationsCountFromEventsTable.mockResolvedValue(3);
    mockGetObservationsForTraceFromEventsTable.mockResolvedValue({
      observations: [
        observationRecord,
        {
          ...observationRecord,
          id: "obs-2",
          name: "Observation 2",
          parentObservationId: "obs-1",
        },
        {
          ...observationRecord,
          id: "obs-3",
          name: null,
          type: "GENERATION",
          parentObservationId: "obs-2",
        },
      ],
      totalCount: 3,
    });

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
    mockGetObservationsCountFromEventsTable.mockResolvedValue(350);
    mockGetObservationsForTraceFromEventsTable.mockResolvedValue({
      observations: Array.from({ length: 350 }, (_, idx) => ({
        ...observationRecord,
        id: `obs-${idx + 1}`,
      })),
      totalCount: 350,
    });

    const result = await buildTraceExport({
      traceId,
      projectId,
      session: makeSession(),
    });

    expect(mockGetObservationsForTraceFromEventsTable).toHaveBeenCalledWith({
      traceId,
      projectId,
      selectIOAndMetadata: false,
      selectToolData: false,
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
