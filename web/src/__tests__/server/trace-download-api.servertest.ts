/** @jest-environment node */
import type { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import {
  BaseError,
  LangfuseNotFoundError,
  UnauthorizedError,
} from "@langfuse/shared";
import handler from "../../pages/api/traces/[traceId]/download";

const mockGetServerAuthSession = jest.fn();
const mockBuildTraceExport = jest.fn();

jest.mock("../../server/auth", () => ({
  getServerAuthSession: (...args: unknown[]) =>
    mockGetServerAuthSession(...args),
}));

jest.mock("../../features/traces/server/buildTraceExport", () => ({
  buildTraceExport: (...args: unknown[]) => mockBuildTraceExport(...args),
}));

const projectId = "project-1";

const createGetMocks = (query: Record<string, string | string[] | undefined>) =>
  createMocks<NextApiRequest, NextApiResponse>({
    method: "GET",
    query,
  });

describe("GET /api/traces/[traceId]/download", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetServerAuthSession.mockResolvedValue({
      user: {
        email: "test@example.com",
        admin: false,
        organizations: [{ projects: [{ id: projectId }] }],
      },
    });
    mockBuildTraceExport.mockResolvedValue({
      scores: [{ id: "score-1", traceId: "trace-1", observationId: null }],
      observations: [{ id: "obs-1", traceId: "trace-1" }],
    });
  });

  it("returns 401 when no session exists", async () => {
    mockGetServerAuthSession.mockResolvedValue(null);
    const { req, res } = createGetMocks({
      traceId: "trace-1",
      projectId,
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(401);
  });

  it("returns 400 for invalid params", async () => {
    const { req, res } = createGetMocks({
      traceId: "",
      projectId,
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
  });

  it("returns attachment headers and the log-view export payload", async () => {
    const { req, res } = createGetMocks({
      traceId: "trace-1",
      projectId,
    });

    await handler(req, res);

    expect(mockBuildTraceExport).toHaveBeenCalledWith({
      traceId: "trace-1",
      projectId,
      session: expect.any(Object),
    });
    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader("Content-Disposition")).toBe(
      'attachment; filename="trace-trace-1.json"',
    );
    expect(JSON.parse(res._getData())).toMatchObject({
      scores: [{ id: "score-1", traceId: "trace-1", observationId: null }],
      observations: [{ id: "obs-1", traceId: "trace-1" }],
    });
  });

  it("returns 404 when the trace does not exist", async () => {
    mockBuildTraceExport.mockRejectedValue(
      new LangfuseNotFoundError("Trace not found"),
    );
    const { req, res } = createGetMocks({
      traceId: "trace-1",
      projectId,
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(404);
  });

  it("returns 401 when the trace is unauthorized", async () => {
    mockBuildTraceExport.mockRejectedValue(
      new UnauthorizedError("Unauthorized"),
    );
    const { req, res } = createGetMocks({
      traceId: "trace-1",
      projectId,
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(401);
  });

  it("returns a client-safe size-limit error for full exports", async () => {
    mockBuildTraceExport.mockRejectedValue(
      new BaseError(
        "TraceDownloadTooLargeError",
        422,
        "Observations in trace are too large",
        true,
      ),
    );
    const { req, res } = createGetMocks({
      traceId: "trace-1",
      projectId,
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(422);
    expect(JSON.parse(res._getData()).message).toContain(
      "Observations in trace are too large",
    );
  });
});
