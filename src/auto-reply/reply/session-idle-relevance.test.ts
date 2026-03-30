import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { SessionInitResult } from "./session.js";

const state = vi.hoisted(() => ({
  runEmbeddedPiAgent: vi.fn(),
  updateSessionStore: vi.fn(),
  archiveSessionTranscripts: vi.fn(),
  clearBootstrapSnapshotOnSessionRollover: vi.fn(),
  resolveMemoryFlushPlan: vi.fn(),
  readSessionMessages: vi.fn(),
  initSessionState: vi.fn(),
  hasHooks: vi.fn(),
  runSessionStart: vi.fn(),
  runSessionEnd: vi.fn(),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (...args: unknown[]) => state.runEmbeddedPiAgent(...args),
}));

vi.mock("../../agents/bootstrap-cache.js", () => ({
  clearBootstrapSnapshotOnSessionRollover: (...args: unknown[]) =>
    state.clearBootstrapSnapshotOnSessionRollover(...args),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: () => ({ sandboxed: false, agentId: "main" }),
  resolveSandboxConfigForAgent: () => ({ workspaceAccess: "rw" }),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveSessionFilePath: () => `/tmp/openclaw-idle-reset-${Date.now()}.jsonl`,
  resolveSessionFilePathOptions: () => ({}),
  updateSessionStore: (...args: unknown[]) => state.updateSessionStore(...args),
}));

vi.mock("../../gateway/session-utils.fs.js", () => ({
  readSessionMessages: (...args: unknown[]) => state.readSessionMessages(...args),
}));

vi.mock("../../gateway/session-archive.runtime.js", () => ({
  archiveSessionTranscripts: (...args: unknown[]) => state.archiveSessionTranscripts(...args),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: state.hasHooks,
    runSessionStart: state.runSessionStart,
    runSessionEnd: state.runSessionEnd,
  }),
}));

vi.mock("../../plugins/memory-state.js", () => ({
  resolveMemoryFlushPlan: (...args: unknown[]) => state.resolveMemoryFlushPlan(...args),
}));

vi.mock("./agent-runner-utils.js", () => ({
  buildEmbeddedRunExecutionParams: () => ({
    embeddedContext: {},
    senderContext: {},
    runBaseParams: {},
  }),
}));

vi.mock("./session-hooks.js", () => ({
  buildSessionEndHookPayload: () => ({ event: {}, context: {} }),
  buildSessionStartHookPayload: () => ({ event: {}, context: {} }),
}));

vi.mock("./session.js", () => ({
  initSessionState: (...args: unknown[]) => state.initSessionState(...args),
}));

let maybeHandleIdleRelevanceCheck: typeof import("./session-idle-relevance.js").maybeHandleIdleRelevanceCheck;

function createSessionState(overrides?: Partial<SessionInitResult>): SessionInitResult {
  const staleEntry: SessionEntry = {
    sessionId: "sess-old",
    sessionFile: "/tmp/sess-old.jsonl",
    updatedAt: 1_000,
    systemSent: true,
  };
  return {
    sessionCtx: {
      BodyStripped: "new topic",
      SessionId: "sess-old",
      SessionKey: "agent:main:telegram:direct:123",
    },
    sessionEntry: staleEntry,
    previousSessionEntry: undefined,
    sessionStore: {
      "agent:main:telegram:direct:123": staleEntry,
    },
    sessionKey: "agent:main:telegram:direct:123",
    sessionId: "sess-old",
    isNewSession: false,
    resetTriggered: false,
    systemSent: true,
    abortedLastRun: false,
    storePath: "/tmp/sessions.json",
    sessionScope: "per-sender",
    groupResolution: undefined,
    isGroup: false,
    bodyStripped: undefined,
    triggerBodyNormalized: "new topic",
    idleRelevanceCheckPending: true,
    idleRelevanceCheckPolicy: {
      enabled: true,
      prompt: 'Reply with exactly one word: "RELATED" or "UNRELATED".',
      systemPrompt: "Idle relevance check.",
      summaryPrompt: "Write durable notes to memory/YYYY-MM-DD.md and reply with NO_REPLY.",
      summarySystemPrompt: "Idle reset summary.",
    },
    staleSessionEntry: staleEntry,
    staleSessionFreshness: {
      fresh: false,
      idleExpiresAt: 2_000,
      staleReason: "idle",
    },
    ...overrides,
  };
}

describe("maybeHandleIdleRelevanceCheck", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ maybeHandleIdleRelevanceCheck } = await import("./session-idle-relevance.js"));
    state.runEmbeddedPiAgent.mockReset();
    state.updateSessionStore.mockReset();
    state.archiveSessionTranscripts.mockReset();
    state.clearBootstrapSnapshotOnSessionRollover.mockReset();
    state.resolveMemoryFlushPlan.mockReset();
    state.readSessionMessages.mockReset();
    state.initSessionState.mockReset();
    state.hasHooks.mockReset();
    state.runSessionStart.mockReset();
    state.runSessionEnd.mockReset();
    state.resolveMemoryFlushPlan.mockReturnValue({
      relativePath: "memory/2026-01-18.md",
    });
    state.readSessionMessages.mockReturnValue([
      { role: "user", content: [{ type: "text", text: "old topic" }] },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
    ]);
    state.hasHooks.mockReturnValue(false);
    state.updateSessionStore.mockImplementation(async (_storePath, mutate) => {
      const store = {
        "agent:main:telegram:direct:123": {
          sessionId: "sess-old",
          sessionFile: "/tmp/sess-old.jsonl",
          updatedAt: 1_000,
          systemSent: true,
        },
      };
      return mutate(store);
    });
  });

  it("keeps the current session when the relevance probe returns RELATED", async () => {
    state.runEmbeddedPiAgent.mockResolvedValueOnce({
      payloads: [{ text: "RELATED" }],
    });

    const result = await maybeHandleIdleRelevanceCheck({
      cfg: {} as OpenClawConfig,
      ctx: { Body: "new topic", SessionKey: "agent:main:telegram:direct:123" },
      commandAuthorized: true,
      sessionState: createSessionState(),
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      timeoutMs: 120_000,
      provider: "openai",
      model: "gpt-5.4",
    });

    expect(result.sessionId).toBe("sess-old");
    expect(result.idleRelevanceCheckPending).toBe(false);
    expect(result.staleSessionEntry).toBeUndefined();
    expect(state.runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    expect(state.updateSessionStore).not.toHaveBeenCalled();
  });

  it("summarizes and resets the session when the relevance probe returns UNRELATED", async () => {
    state.runEmbeddedPiAgent
      .mockResolvedValueOnce({
        payloads: [{ text: "UNRELATED" }],
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "NO_REPLY" }],
      });
    state.initSessionState.mockResolvedValue({
      ...createSessionState({
        sessionId: "sess-new",
        sessionEntry: {
          sessionId: "sess-new",
          sessionFile: "/tmp/sess-new.jsonl",
          updatedAt: 2_000,
        },
        sessionCtx: {
          BodyStripped: "new topic",
          SessionId: "sess-new",
          SessionKey: "agent:main:telegram:direct:123",
        },
        isNewSession: false,
        idleRelevanceCheckPending: false,
        idleRelevanceCheckPolicy: undefined,
        staleSessionEntry: undefined,
        staleSessionFreshness: undefined,
      }),
    });

    const result = await maybeHandleIdleRelevanceCheck({
      cfg: {} as OpenClawConfig,
      ctx: { Body: "new topic", SessionKey: "agent:main:telegram:direct:123" },
      commandAuthorized: true,
      sessionState: createSessionState(),
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      timeoutMs: 120_000,
      provider: "openai",
      model: "gpt-5.4",
    });

    expect(state.runEmbeddedPiAgent).toHaveBeenCalledTimes(2);
    expect(state.updateSessionStore).toHaveBeenCalledTimes(1);
    expect(state.archiveSessionTranscripts).toHaveBeenCalledTimes(1);
    expect(state.initSessionState).toHaveBeenCalledTimes(1);
    expect(result.sessionId).toBe("sess-new");
  });
});
