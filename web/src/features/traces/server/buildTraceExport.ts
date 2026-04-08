import {
  LangfuseNotFoundError,
  BaseError,
  UnauthorizedError,
} from "@langfuse/shared";
import { type Session } from "next-auth";
import {
  getTraceById,
  queryClickhouse,
  shouldSkipObservationsFinal,
  convertDateToClickhouseDateTime,
  TRACE_TO_OBSERVATIONS_INTERVAL,
  getScoresAndCorrectionsForTraces,
  type ObservationRecordReadType,
  TraceObservationsTooLargeError,
} from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";
import { env } from "@langfuse/shared/src/env";
import { sendAdminAccessWebhook } from "@/src/server/adminAccessWebhook";
import { TRACE_DOWNLOAD_OMIT_LARGE_FIELDS_THRESHOLD } from "../shared/traceDownloadConfig";
import { toDomainArrayWithStringifiedMetadata } from "@/src/utils/clientSideDomainTypes";

export type TraceExportSession = Session & {
  user: NonNullable<Session["user"]> & {
    email: string;
    admin?: boolean;
    organizations: Array<{
      projects: Array<{
        id: string;
      }>;
    }>;
  };
};

export interface TraceExportObservation {
  id: string;
  traceId: string;
  userId: string;
  sessionId: string;
  projectId: string;
  startTime: string;
  endTime: string | null;
  parentObservationId: string | null;
  type: string;
  environment: string;
  name: string | null;
  traceName: string;
  statusMessage: string | null;
  version: string | null;
  createdAt: string;
  updatedAt: string;
  model: string | null;
  internalModelId: string | null;
  modelParameters: string | null;
  completionStartTime: string | null;
  promptId: string | null;
  promptName: string | null;
  promptVersion: number | null;
  latency: number | null;
  timeToFirstToken: number | null;
  usageDetails: Record<string, number>;
  costDetails: Record<string, number>;
  providedCostDetails: Record<string, number>;
  usagePricingTierId: string | null;
  usagePricingTierName: string | null;
  toolCallNames: string[];
  tags: string[];
  bookmarked: boolean;
  public: boolean;
  input?: string | null;
  output?: string | null;
  metadata?: string;
  toolDefinitions?: Record<string, string>;
  toolCalls?: string[];
}

export interface TraceExportScore {
  id: string;
  projectId: string;
  environment: string;
  name: string;
  value: number;
  source: string;
  authorUserId: string | null;
  comment: string | null;
  configId: string | null;
  queueId: string | null;
  executionTraceId: string | null;
  createdAt: string;
  updatedAt: string;
  timestamp: string;
  traceId: string | null;
  sessionId: string | null;
  datasetRunId: string | null;
  observationId: string | null;
  longStringValue: string;
  stringValue: string | null;
  dataType: string;
  metadata: string | null;
}

export interface TraceExportPayload {
  scores: TraceExportScore[];
  observations: TraceExportObservation[];
}

const clickhouseDateTimeToIso = (value: string | null | undefined) => {
  if (!value) {
    return null;
  }

  return value.replace(" ", "T") + "Z";
};

const getDurationSeconds = (
  startTime: string | null,
  endTime: string | null,
): number | null => {
  if (!startTime || !endTime) {
    return null;
  }

  return (new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000;
};

const getMetadataPayloadSize = (metadata: Record<string, string>) =>
  Object.values(metadata).reduce(
    (size, value) => size + (typeof value === "string" ? value.length : 0),
    0,
  );

export interface BuildTraceExportParams {
  traceId: string;
  projectId: string;
  session: TraceExportSession;
}

export class TraceDownloadTooLargeError extends BaseError {
  constructor(message: string) {
    super("TraceDownloadTooLargeError", 422, message, true);
  }
}

const hasProjectAccess = (session: TraceExportSession, projectId: string) =>
  session.user.organizations.some((organization) =>
    organization.projects.some((project) => project.id === projectId),
  );

const getObservationRecordsForTrace = async (params: {
  traceId: string;
  projectId: string;
  timestamp: Date;
  omitLargeFields: boolean;
}) => {
  const { traceId, projectId, timestamp, omitLargeFields } = params;
  const skipDedup = await shouldSkipObservationsFinal(projectId);

  const query = `
  SELECT
    id,
    trace_id,
    project_id,
    type,
    parent_observation_id,
    environment,
    start_time,
    end_time,
    name,
    ${
      omitLargeFields
        ? "CAST(map(), 'Map(String, String)') AS metadata,"
        : "metadata,"
    }
    status_message,
    version,
    ${omitLargeFields ? "CAST(NULL, 'Nullable(String)') AS input," : "input,"}
    ${omitLargeFields ? "CAST(NULL, 'Nullable(String)') AS output," : "output,"}
    provided_model_name,
    internal_model_id,
    model_parameters,
    provided_usage_details,
    usage_details,
    provided_cost_details,
    cost_details,
    total_cost,
    usage_pricing_tier_id,
    usage_pricing_tier_name,
    completion_start_time,
    prompt_id,
    prompt_name,
    prompt_version,
    ${
      omitLargeFields
        ? "CAST(map(), 'Map(String, String)') AS tool_definitions,"
        : "tool_definitions,"
    }
    ${
      omitLargeFields
        ? "CAST([], 'Array(String)') AS tool_calls,"
        : "tool_calls,"
    }
    tool_call_names,
    created_at,
    updated_at,
    event_ts,
    is_deleted
  FROM observations
  WHERE trace_id = {traceId: String}
  AND project_id = {projectId: String}
  AND start_time >= {traceTimestamp: DateTime64(3)} - ${TRACE_TO_OBSERVATIONS_INTERVAL}
  AND is_deleted = 0
  ${skipDedup ? "" : "ORDER BY event_ts DESC"}
  ${skipDedup ? "" : "LIMIT 1 BY id, project_id"}`;

  const records = await queryClickhouse<ObservationRecordReadType>({
    query,
    params: {
      traceId,
      projectId,
      traceTimestamp: convertDateToClickhouseDateTime(timestamp),
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "list",
      projectId,
    },
    preferredClickhouseService: "ReadOnly",
  });

  let payloadSize = 0;

  for (const record of records) {
    for (const key of ["input", "output"] as const) {
      const value = record[key];

      if (value && typeof value === "string") {
        payloadSize += value.length;
      }
    }

    payloadSize += getMetadataPayloadSize(record.metadata ?? {});

    if (payloadSize >= env.LANGFUSE_API_TRACE_OBSERVATIONS_SIZE_LIMIT_BYTES) {
      throw new TraceObservationsTooLargeError(
        payloadSize,
        env.LANGFUSE_API_TRACE_OBSERVATIONS_SIZE_LIMIT_BYTES,
      );
    }
  }

  return records;
};

const getObservationRecordCountForTrace = async (params: {
  traceId: string;
  projectId: string;
  timestamp: Date;
}) => {
  const { traceId, projectId, timestamp } = params;
  const skipDedup = await shouldSkipObservationsFinal(projectId);

  const countExpression = skipDedup ? "count()" : "uniqExact(id)";
  const records = await queryClickhouse<{ count: number }>({
    query: `
      SELECT ${countExpression} AS count
      FROM observations
      WHERE trace_id = {traceId: String}
      AND project_id = {projectId: String}
      AND start_time >= {traceTimestamp: DateTime64(3)} - ${TRACE_TO_OBSERVATIONS_INTERVAL}
      AND is_deleted = 0
    `,
    params: {
      traceId,
      projectId,
      traceTimestamp: convertDateToClickhouseDateTime(timestamp),
    },
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "count",
      projectId,
    },
    preferredClickhouseService: "ReadOnly",
  });

  return records[0]?.count ?? 0;
};

async function getAuthorizedTrace(params: {
  traceId: string;
  projectId: string;
  session: TraceExportSession;
}) {
  const { traceId, projectId, session } = params;

  const clickhouseTrace = await getTraceById({
    traceId,
    projectId,
    renderingProps: {
      truncated: false,
      shouldJsonParse: false,
    },
    clickhouseFeatureTag: "tracing-download",
  });

  if (!clickhouseTrace) {
    throw new LangfuseNotFoundError("Trace not found");
  }

  const traceSession = clickhouseTrace.sessionId
    ? await prisma.traceSession.findFirst({
        where: {
          id: clickhouseTrace.sessionId,
          projectId,
        },
        select: {
          public: true,
        },
      })
    : null;

  const isSessionPublic = traceSession?.public === true;
  const isAdmin = session.user.admin === true;
  const canReadTrace =
    clickhouseTrace.public ||
    isSessionPublic ||
    isAdmin ||
    hasProjectAccess(session, projectId);

  if (!canReadTrace) {
    throw new UnauthorizedError(
      "User is not a member of this project and this trace is not public",
    );
  }

  if (isAdmin) {
    await sendAdminAccessWebhook({
      email: session.user.email,
      projectId,
    });
  }

  return clickhouseTrace;
}

export async function buildTraceExport({
  traceId,
  projectId,
  session,
}: BuildTraceExportParams): Promise<TraceExportPayload> {
  const trace = await getAuthorizedTrace({
    traceId,
    projectId,
    session,
  });

  const observationRecordCount = await getObservationRecordCountForTrace({
    traceId,
    projectId,
    timestamp: trace.timestamp,
  });
  const omitLargeFields =
    observationRecordCount >= TRACE_DOWNLOAD_OMIT_LARGE_FIELDS_THRESHOLD;

  let observationRecords: ObservationRecordReadType[];
  try {
    observationRecords = await getObservationRecordsForTrace({
      traceId,
      projectId,
      timestamp: trace.timestamp,
      omitLargeFields,
    });
  } catch (error) {
    if (error instanceof TraceObservationsTooLargeError) {
      throw new TraceDownloadTooLargeError(error.message);
    }

    throw error;
  }

  const scores = await getScoresAndCorrectionsForTraces({
    projectId,
    traceIds: [traceId],
    timestamp: trace.timestamp,
  });

  const serializedScores = toDomainArrayWithStringifiedMetadata(scores).map(
    (score) => ({
      ...score,
      stringValue: score.stringValue ?? null,
      metadata: score.metadata ?? null,
      createdAt: score.createdAt.toISOString(),
      updatedAt: score.updatedAt.toISOString(),
      timestamp: score.timestamp.toISOString(),
    }),
  );

  const observations = observationRecords.map((record) => {
    const startTime = clickhouseDateTimeToIso(record.start_time);
    const endTime = clickhouseDateTimeToIso(record.end_time);
    const completionStartTime = clickhouseDateTimeToIso(
      record.completion_start_time,
    );

    return {
      id: record.id,
      traceId: record.trace_id ?? traceId,
      userId: trace.userId ?? "",
      sessionId: trace.sessionId ?? "",
      projectId: record.project_id,
      startTime: startTime ?? "",
      endTime,
      parentObservationId: record.parent_observation_id ?? null,
      type: record.type,
      environment: record.environment,
      name: record.name ?? null,
      traceName: trace.name ?? "",
      statusMessage: record.status_message ?? null,
      version: record.version ?? null,
      createdAt: clickhouseDateTimeToIso(record.created_at) ?? "",
      updatedAt: clickhouseDateTimeToIso(record.updated_at) ?? "",
      model: record.provided_model_name ?? null,
      internalModelId: record.internal_model_id ?? null,
      modelParameters: record.model_parameters ?? null,
      completionStartTime,
      promptId: record.prompt_id ?? null,
      promptName: record.prompt_name ?? null,
      promptVersion: record.prompt_version ?? null,
      latency: getDurationSeconds(startTime, endTime),
      timeToFirstToken: getDurationSeconds(startTime, completionStartTime),
      usageDetails: record.usage_details ?? {},
      costDetails: record.cost_details ?? {},
      providedCostDetails: record.provided_cost_details ?? {},
      usagePricingTierId: record.usage_pricing_tier_id ?? null,
      usagePricingTierName: record.usage_pricing_tier_name ?? null,
      toolCallNames: record.tool_call_names ?? [],
      tags: trace.tags,
      bookmarked: trace.bookmarked,
      public: trace.public,
      ...(!omitLargeFields
        ? {
            toolDefinitions: record.tool_definitions ?? {},
            toolCalls: record.tool_calls ?? [],
            input: record.input ?? null,
            output: record.output ?? null,
            metadata: JSON.stringify(record.metadata ?? {}),
          }
        : {}),
    };
  });

  return {
    scores: serializedScores,
    observations,
  };
}
