import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type {
  SessionConfig,
  SessionResetConfig,
  SessionResetRelevanceCheckConfig,
} from "../types.base.js";
import { DEFAULT_IDLE_MINUTES } from "./types.js";

export type SessionResetMode = "daily" | "idle";
export type SessionResetType = "direct" | "group" | "thread";

export type SessionResetPolicy = {
  mode: SessionResetMode;
  atHour: number;
  idleMinutes?: number;
  relevanceCheck?: Required<
    Pick<
      SessionResetRelevanceCheckConfig,
      "prompt" | "systemPrompt" | "summaryPrompt" | "summarySystemPrompt"
    >
  > & {
    enabled: boolean;
  };
};

export type SessionFreshness = {
  fresh: boolean;
  dailyResetAt?: number;
  idleExpiresAt?: number;
  staleReason?: SessionResetMode;
};

export const DEFAULT_RESET_MODE: SessionResetMode = "daily";
export const DEFAULT_RESET_AT_HOUR = 4;
const DEFAULT_RELEVANCE_CHECK_PROMPT = [
  "Classify whether the NEW inbound message should continue the PREVIOUS conversation after an idle gap.",
  'Reply with exactly one word: "RELATED" or "UNRELATED".',
  'Choose "RELATED" only when the new message clearly continues the same task, topic, or follow-up.',
  'Choose "UNRELATED" when it starts a new topic, asks for different work, or lacks a clear connection.',
  "Do not use tools. Do not add any explanation.",
].join(" ");
const DEFAULT_RELEVANCE_CHECK_SYSTEM_PROMPT = [
  "Idle-gap relevance check.",
  "You are making an internal routing decision before normal conversation resumes.",
  'Output must be exactly one token: "RELATED" or "UNRELATED".',
].join(" ");
const DEFAULT_RELEVANCE_SUMMARY_PROMPT = [
  "A new inbound message arrived after an idle gap and was judged unrelated to the prior conversation.",
  "Before resetting the conversation, append a concise factual summary of the prior conversation to memory/YYYY-MM-DD.md.",
  "Write only durable notes worth keeping for later recall.",
  "If there is nothing worth storing, reply with NO_REPLY.",
].join(" ");
const DEFAULT_RELEVANCE_SUMMARY_SYSTEM_PROMPT = [
  "Idle-gap pre-reset memory summary.",
  "The prior conversation is about to be reset because the new inbound message is unrelated.",
  "Store durable notes only in memory/YYYY-MM-DD.md and reply with NO_REPLY after writing.",
].join(" ");

const THREAD_SESSION_MARKERS = [":thread:", ":topic:"];
const GROUP_SESSION_MARKERS = [":group:", ":channel:"];

export function isThreadSessionKey(sessionKey?: string | null): boolean {
  const normalized = (sessionKey ?? "").toLowerCase();
  if (!normalized) {
    return false;
  }
  return THREAD_SESSION_MARKERS.some((marker) => normalized.includes(marker));
}

export function resolveSessionResetType(params: {
  sessionKey?: string | null;
  isGroup?: boolean;
  isThread?: boolean;
}): SessionResetType {
  if (params.isThread || isThreadSessionKey(params.sessionKey)) {
    return "thread";
  }
  if (params.isGroup) {
    return "group";
  }
  const normalized = (params.sessionKey ?? "").toLowerCase();
  if (GROUP_SESSION_MARKERS.some((marker) => normalized.includes(marker))) {
    return "group";
  }
  return "direct";
}

export function resolveThreadFlag(params: {
  sessionKey?: string | null;
  messageThreadId?: string | number | null;
  threadLabel?: string | null;
  threadStarterBody?: string | null;
  parentSessionKey?: string | null;
}): boolean {
  if (params.messageThreadId != null) {
    return true;
  }
  if (params.threadLabel?.trim()) {
    return true;
  }
  if (params.threadStarterBody?.trim()) {
    return true;
  }
  if (params.parentSessionKey?.trim()) {
    return true;
  }
  return isThreadSessionKey(params.sessionKey);
}

export function resolveDailyResetAtMs(now: number, atHour: number): number {
  const normalizedAtHour = normalizeResetAtHour(atHour);
  const resetAt = new Date(now);
  resetAt.setHours(normalizedAtHour, 0, 0, 0);
  if (now < resetAt.getTime()) {
    resetAt.setDate(resetAt.getDate() - 1);
  }
  return resetAt.getTime();
}

export function resolveSessionResetPolicy(params: {
  sessionCfg?: SessionConfig;
  resetType: SessionResetType;
  resetOverride?: SessionResetConfig;
}): SessionResetPolicy {
  const sessionCfg = params.sessionCfg;
  const baseReset = params.resetOverride ?? sessionCfg?.reset;
  // Backward compat: accept legacy "dm" key as alias for "direct"
  const typeReset = params.resetOverride
    ? undefined
    : (sessionCfg?.resetByType?.[params.resetType] ??
      (params.resetType === "direct"
        ? (sessionCfg?.resetByType as { dm?: SessionResetConfig } | undefined)?.dm
        : undefined));
  const hasExplicitReset = Boolean(baseReset || sessionCfg?.resetByType);
  const legacyIdleMinutes = params.resetOverride ? undefined : sessionCfg?.idleMinutes;
  const mode =
    typeReset?.mode ??
    baseReset?.mode ??
    (!hasExplicitReset && legacyIdleMinutes != null ? "idle" : DEFAULT_RESET_MODE);
  const atHour = normalizeResetAtHour(
    typeReset?.atHour ?? baseReset?.atHour ?? DEFAULT_RESET_AT_HOUR,
  );
  const idleMinutesRaw = typeReset?.idleMinutes ?? baseReset?.idleMinutes ?? legacyIdleMinutes;

  let idleMinutes: number | undefined;
  if (idleMinutesRaw != null) {
    const normalized = Math.floor(idleMinutesRaw);
    if (Number.isFinite(normalized)) {
      idleMinutes = Math.max(normalized, 0);
    }
  } else if (mode === "idle") {
    idleMinutes = DEFAULT_IDLE_MINUTES;
  }

  const mergedRelevanceCheck = typeReset?.relevanceCheck ?? baseReset?.relevanceCheck ?? undefined;
  const defaultRelevanceEnabled =
    mode === "idle" && (params.resetType === "direct" || params.resetType === "thread");
  const relevanceEnabled = mergedRelevanceCheck?.enabled ?? defaultRelevanceEnabled;

  return {
    mode,
    atHour,
    idleMinutes,
    relevanceCheck: {
      enabled: relevanceEnabled,
      prompt: mergedRelevanceCheck?.prompt?.trim() || DEFAULT_RELEVANCE_CHECK_PROMPT,
      systemPrompt:
        mergedRelevanceCheck?.systemPrompt?.trim() || DEFAULT_RELEVANCE_CHECK_SYSTEM_PROMPT,
      summaryPrompt:
        mergedRelevanceCheck?.summaryPrompt?.trim() || DEFAULT_RELEVANCE_SUMMARY_PROMPT,
      summarySystemPrompt:
        mergedRelevanceCheck?.summarySystemPrompt?.trim() ||
        DEFAULT_RELEVANCE_SUMMARY_SYSTEM_PROMPT,
    },
  };
}

export function resolveChannelResetConfig(params: {
  sessionCfg?: SessionConfig;
  channel?: string | null;
}): SessionResetConfig | undefined {
  const resetByChannel = params.sessionCfg?.resetByChannel;
  if (!resetByChannel) {
    return undefined;
  }
  const normalized = normalizeMessageChannel(params.channel);
  const fallback = params.channel?.trim().toLowerCase();
  const key = normalized ?? fallback;
  if (!key) {
    return undefined;
  }
  return resetByChannel[key] ?? resetByChannel[key.toLowerCase()];
}

export function evaluateSessionFreshness(params: {
  updatedAt: number;
  now: number;
  policy: SessionResetPolicy;
}): SessionFreshness {
  const dailyResetAt =
    params.policy.mode === "daily"
      ? resolveDailyResetAtMs(params.now, params.policy.atHour)
      : undefined;
  const idleExpiresAt =
    params.policy.idleMinutes != null && params.policy.idleMinutes > 0
      ? params.updatedAt + params.policy.idleMinutes * 60_000
      : undefined;
  const staleDaily = dailyResetAt != null && params.updatedAt < dailyResetAt;
  const staleIdle = idleExpiresAt != null && params.now > idleExpiresAt;
  return {
    fresh: !(staleDaily || staleIdle),
    dailyResetAt,
    idleExpiresAt,
    staleReason: staleDaily ? "daily" : staleIdle ? "idle" : undefined,
  };
}

function normalizeResetAtHour(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_RESET_AT_HOUR;
  }
  const normalized = Math.floor(value);
  if (!Number.isFinite(normalized)) {
    return DEFAULT_RESET_AT_HOUR;
  }
  if (normalized < 0) {
    return 0;
  }
  if (normalized > 23) {
    return 23;
  }
  return normalized;
}
