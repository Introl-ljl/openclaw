import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { resolveSandboxConfigForAgent, resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { readSessionMessages } from "../../gateway/session-utils.fs.js";
import { logVerbose } from "../../globals.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveMemoryFlushPlan } from "../../plugins/memory-state.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { normalizeReasoningLevel, normalizeVerboseLevel } from "../thinking.js";
import { buildEmbeddedRunExecutionParams } from "./agent-runner-utils.js";
import { buildSessionEndHookPayload, buildSessionStartHookPayload } from "./session-hooks.js";
import { initSessionState, type SessionInitResult } from "./session.js";

const RELEVANCE_TRANSCRIPT_MAX_MESSAGES = 12;
const RELEVANCE_TRANSCRIPT_MAX_TOTAL_CHARS = 6_000;
const RELEVANCE_TRANSCRIPT_MAX_MESSAGE_CHARS = 600;
const RELEVANCE_TIMEOUT_MS = 60_000;
let sessionArchiveRuntimePromise: Promise<
  typeof import("../../gateway/session-archive.runtime.js")
> | null = null;

function loadSessionArchiveRuntime() {
  sessionArchiveRuntimePromise ??= import("../../gateway/session-archive.runtime.js");
  return sessionArchiveRuntimePromise;
}

function collectTextParts(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: string[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts;
}

function normalizeMessageText(content: unknown): string {
  const text = collectTextParts(content).join("\n").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length > RELEVANCE_TRANSCRIPT_MAX_MESSAGE_CHARS
    ? `${text.slice(0, RELEVANCE_TRANSCRIPT_MAX_MESSAGE_CHARS)}…`
    : text;
}

function buildTranscriptExcerpt(messages: unknown[]): string {
  const tail = messages.slice(-RELEVANCE_TRANSCRIPT_MAX_MESSAGES);
  const lines: string[] = [];
  let totalChars = 0;
  for (const entry of tail) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const roleRaw = (entry as { role?: unknown }).role;
    const role = typeof roleRaw === "string" ? roleRaw : "unknown";
    const text = normalizeMessageText((entry as { content?: unknown }).content);
    if (!text) {
      continue;
    }
    const line = `${role}: ${text}`;
    totalChars += line.length;
    if (totalChars > RELEVANCE_TRANSCRIPT_MAX_TOTAL_CHARS) {
      break;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function extractPayloadText(payloads: Array<{ text?: string }> | undefined): string {
  return (payloads ?? [])
    .map((payload) => payload.text?.trim())
    .filter((text): text is string => Boolean(text))
    .join("\n")
    .trim();
}

function parseRelevanceVerdict(text: string): "related" | "unrelated" | null {
  const normalized = text.trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  const firstToken = normalized.split(/\s+/)[0];
  if (firstToken === "RELATED") {
    return "related";
  }
  if (firstToken === "UNRELATED") {
    return "unrelated";
  }
  return null;
}

function resolveActiveModel(params: {
  sessionEntry: SessionEntry;
  provider: string;
  model: string;
}): { provider: string; model: string } {
  return {
    provider: params.sessionEntry.providerOverride?.trim() || params.provider,
    model: params.sessionEntry.modelOverride?.trim() || params.model,
  };
}

function buildRelevancePrompt(params: {
  prompt: string;
  previousExcerpt: string;
  newMessage: string;
}): string {
  return [
    params.prompt,
    "PREVIOUS CONVERSATION EXCERPT:",
    params.previousExcerpt || "(no usable prior transcript excerpt)",
    "",
    "NEW INBOUND MESSAGE:",
    params.newMessage || "(empty message)",
  ].join("\n");
}

function isWorkspaceWritable(params: { cfg: OpenClawConfig; sessionKey: string }): boolean {
  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  if (!runtime.sandboxed) {
    return true;
  }
  const sandboxCfg = resolveSandboxConfigForAgent(params.cfg, runtime.agentId);
  return sandboxCfg.workspaceAccess === "rw";
}

function formatDateStamp(nowMs: number, timezone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

async function runRelevanceProbe(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionCtx: TemplateContext;
  sessionEntry: SessionEntry;
  provider: string;
  model: string;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  timeoutMs: number;
  prompt: string;
  systemPrompt: string;
}): Promise<"related" | "unrelated"> {
  const runId = crypto.randomUUID();
  const tempSessionId = crypto.randomUUID();
  const tempSessionFile = path.join(os.tmpdir(), `openclaw-idle-relevance-${tempSessionId}.jsonl`);
  try {
    const run = {
      sessionId: tempSessionId,
      sessionKey: params.sessionKey,
      sessionFile: tempSessionFile,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      config: params.cfg,
      skillsSnapshot: params.sessionEntry.skillsSnapshot,
      ownerNumbers: [] as string[],
      inputProvenance: undefined,
      senderIsOwner: false,
      thinkLevel: "low" as const,
      verboseLevel: normalizeVerboseLevel(params.sessionEntry.verboseLevel),
      reasoningLevel: normalizeReasoningLevel(params.sessionEntry.reasoningLevel),
      execOverrides: undefined,
      bashElevated: undefined,
      timeoutMs: Math.min(params.timeoutMs, RELEVANCE_TIMEOUT_MS),
      blockReplyBreak: "message_end" as const,
      agentId: params.agentId,
      provider: params.provider,
      model: params.model,
    };
    const { embeddedContext, senderContext, runBaseParams } = buildEmbeddedRunExecutionParams({
      run,
      sessionCtx: params.sessionCtx,
      hasRepliedRef: undefined,
      provider: params.provider,
      model: params.model,
      runId,
    });
    const result = await runEmbeddedPiAgent({
      ...embeddedContext,
      ...senderContext,
      ...runBaseParams,
      disableMessageTool: true,
      trigger: "manual",
      prompt: params.prompt,
      extraSystemPrompt: params.systemPrompt,
    });
    const verdict = parseRelevanceVerdict(
      extractPayloadText(result.payloads as Array<{ text?: string }> | undefined),
    );
    if (verdict) {
      return verdict;
    }
    logVerbose(`idle relevance check returned malformed verdict for ${params.sessionKey}`);
    return "unrelated";
  } catch (err) {
    logVerbose(`idle relevance check failed for ${params.sessionKey}: ${String(err)}`);
    return "unrelated";
  } finally {
    try {
      await fs.promises.rm(tempSessionFile, { force: true });
    } catch {
      // Best-effort cleanup for ephemeral probe transcripts.
    }
  }
}

async function runIdleSummary(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionCtx: TemplateContext;
  staleSessionEntry: SessionEntry;
  storePath: string;
  provider: string;
  model: string;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  timeoutMs: number;
  prompt: string;
  systemPrompt: string;
}): Promise<void> {
  if (!isWorkspaceWritable({ cfg: params.cfg, sessionKey: params.sessionKey })) {
    logVerbose(`idle summary skipped for ${params.sessionKey}: workspace is read-only`);
    return;
  }

  const runId = crypto.randomUUID();
  const plan = resolveMemoryFlushPlan({ cfg: params.cfg, nowMs: Date.now() });
  const writePath = plan?.relativePath ?? `memory/${formatDateStamp(Date.now())}.md`;
  const run = {
    sessionId: params.staleSessionEntry.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: resolveSessionFilePath(
      params.staleSessionEntry.sessionId,
      params.staleSessionEntry.sessionFile
        ? { sessionFile: params.staleSessionEntry.sessionFile }
        : undefined,
      resolveSessionFilePathOptions({
        storePath: params.storePath,
        agentId: params.agentId,
      }),
    ),
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    config: params.cfg,
    skillsSnapshot: params.staleSessionEntry.skillsSnapshot,
    ownerNumbers: [] as string[],
    inputProvenance: undefined,
    senderIsOwner: false,
    thinkLevel: "low" as const,
    verboseLevel: normalizeVerboseLevel(params.staleSessionEntry.verboseLevel),
    reasoningLevel: normalizeReasoningLevel(params.staleSessionEntry.reasoningLevel),
    execOverrides: undefined,
    bashElevated: undefined,
    timeoutMs: params.timeoutMs,
    blockReplyBreak: "message_end" as const,
    agentId: params.agentId,
    provider: params.provider,
    model: params.model,
  };
  const { embeddedContext, senderContext, runBaseParams } = buildEmbeddedRunExecutionParams({
    run,
    sessionCtx: params.sessionCtx,
    hasRepliedRef: undefined,
    provider: params.provider,
    model: params.model,
    runId,
  });
  try {
    await runEmbeddedPiAgent({
      ...embeddedContext,
      ...senderContext,
      ...runBaseParams,
      trigger: "memory",
      memoryFlushWritePath: writePath,
      prompt: params.prompt.replaceAll("YYYY-MM-DD", path.basename(writePath, ".md")),
      extraSystemPrompt: params.systemPrompt.replaceAll(
        "YYYY-MM-DD",
        path.basename(writePath, ".md"),
      ),
    });
  } catch (err) {
    logVerbose(`idle summary failed for ${params.sessionKey}: ${String(err)}`);
  }
}

async function resetSessionAfterIdleTopicSwitch(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  staleSessionEntry: SessionEntry;
  storePath: string;
  agentId: string;
}): Promise<SessionEntry> {
  const nextSessionId = crypto.randomUUID();
  const nextSessionFile = resolveSessionFilePath(
    nextSessionId,
    params.staleSessionEntry.sessionFile
      ? { sessionFile: params.staleSessionEntry.sessionFile }
      : undefined,
    resolveSessionFilePathOptions({
      storePath: params.storePath,
      agentId: params.agentId,
    }),
  );
  const nextEntry: SessionEntry = {
    ...params.staleSessionEntry,
    sessionId: nextSessionId,
    sessionFile: nextSessionFile,
    updatedAt: Date.now(),
    systemSent: false,
    abortedLastRun: false,
    modelProvider: undefined,
    model: undefined,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalTokensFresh: true,
    estimatedCostUsd: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    contextTokens: undefined,
    systemPromptReport: undefined,
    compactionCount: 0,
    memoryFlushCompactionCount: undefined,
    memoryFlushAt: undefined,
    memoryFlushContextHash: undefined,
  };
  await updateSessionStore(params.storePath, (store) => {
    store[params.sessionKey] = nextEntry;
  });
  clearBootstrapSnapshotOnSessionRollover({
    sessionKey: params.sessionKey,
    previousSessionId: params.staleSessionEntry.sessionId,
  });
  const { archiveSessionTranscripts } = await loadSessionArchiveRuntime();
  archiveSessionTranscripts({
    sessionId: params.staleSessionEntry.sessionId,
    storePath: params.storePath,
    sessionFile: params.staleSessionEntry.sessionFile,
    agentId: params.agentId,
    reason: "reset",
  });
  fs.mkdirSync(path.dirname(nextSessionFile), { recursive: true });
  if (!fs.existsSync(nextSessionFile)) {
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: nextSessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(nextSessionFile, `${JSON.stringify(header)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("session_end")) {
    const payload = buildSessionEndHookPayload({
      sessionId: params.staleSessionEntry.sessionId,
      sessionKey: params.sessionKey,
      cfg: params.cfg,
    });
    void hookRunner.runSessionEnd(payload.event, payload.context).catch(() => {});
  }
  if (hookRunner?.hasHooks("session_start")) {
    const payload = buildSessionStartHookPayload({
      sessionId: nextSessionId,
      sessionKey: params.sessionKey,
      cfg: params.cfg,
      resumedFrom: params.staleSessionEntry.sessionId,
    });
    void hookRunner.runSessionStart(payload.event, payload.context).catch(() => {});
  }
  return nextEntry;
}

export async function maybeHandleIdleRelevanceCheck(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  commandAuthorized: boolean;
  sessionState: SessionInitResult;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  timeoutMs: number;
  provider: string;
  model: string;
}): Promise<SessionInitResult> {
  const { sessionState, cfg, ctx, commandAuthorized, agentId, agentDir, workspaceDir, timeoutMs } =
    params;
  if (
    !sessionState.idleRelevanceCheckPending ||
    !sessionState.idleRelevanceCheckPolicy ||
    !sessionState.staleSessionEntry ||
    !sessionState.sessionKey
  ) {
    return sessionState;
  }

  const activeModel = resolveActiveModel({
    sessionEntry: sessionState.staleSessionEntry,
    provider: params.provider,
    model: params.model,
  });
  const previousMessages = readSessionMessagesSafe({
    staleSessionEntry: sessionState.staleSessionEntry,
    storePath: sessionState.storePath,
  });
  const previousExcerpt = buildTranscriptExcerpt(previousMessages);
  const newMessage = sessionState.sessionCtx.BodyStripped?.trim() || ctx.Body?.trim() || "";
  const verdict = await runRelevanceProbe({
    cfg,
    sessionKey: sessionState.sessionKey,
    sessionCtx: sessionState.sessionCtx,
    sessionEntry: sessionState.staleSessionEntry,
    provider: activeModel.provider,
    model: activeModel.model,
    agentId,
    agentDir,
    workspaceDir,
    timeoutMs,
    prompt: buildRelevancePrompt({
      prompt: sessionState.idleRelevanceCheckPolicy.prompt,
      previousExcerpt,
      newMessage,
    }),
    systemPrompt: sessionState.idleRelevanceCheckPolicy.systemPrompt,
  });
  if (verdict === "related") {
    return {
      ...sessionState,
      idleRelevanceCheckPending: false,
      idleRelevanceCheckPolicy: undefined,
      staleSessionEntry: undefined,
      staleSessionFreshness: undefined,
    };
  }

  await runIdleSummary({
    cfg,
    sessionKey: sessionState.sessionKey,
    sessionCtx: sessionState.sessionCtx,
    staleSessionEntry: sessionState.staleSessionEntry,
    storePath: sessionState.storePath,
    provider: activeModel.provider,
    model: activeModel.model,
    agentId,
    agentDir,
    workspaceDir,
    timeoutMs,
    prompt: sessionState.idleRelevanceCheckPolicy.summaryPrompt,
    systemPrompt: sessionState.idleRelevanceCheckPolicy.summarySystemPrompt,
  });
  await resetSessionAfterIdleTopicSwitch({
    cfg,
    sessionKey: sessionState.sessionKey,
    staleSessionEntry: sessionState.staleSessionEntry,
    storePath: sessionState.storePath,
    agentId,
  });
  return await initSessionState({
    ctx,
    cfg,
    commandAuthorized,
  });
}

function readSessionMessagesSafe(params: {
  staleSessionEntry: SessionEntry;
  storePath: string;
}): unknown[] {
  try {
    return readSessionMessages(
      params.staleSessionEntry.sessionId,
      params.storePath,
      params.staleSessionEntry.sessionFile,
    );
  } catch {
    return [];
  }
}

export const __testing = {
  buildTranscriptExcerpt,
  parseRelevanceVerdict,
  normalizeMessageText,
};
