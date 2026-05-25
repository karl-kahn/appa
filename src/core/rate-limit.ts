// pattern: functional-core
// Sliding-window rate limiter for Claude spawn calls.

import type { SpawnUsage } from "./types.js";

export interface RateLimitState {
  timestamps: number[];
  hourlyLimit: number;
  dailyLimit: number;
}

export function createRateLimitState(hourly: number, daily: number): RateLimitState {
  return { timestamps: [], hourlyLimit: hourly, dailyLimit: daily };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function prune(state: RateLimitState, now: number): RateLimitState {
  const cutoff = now - DAY_MS;
  const kept = state.timestamps.filter((t) => t >= cutoff);
  return { ...state, timestamps: kept };
}

export function canSpawn(
  state: RateLimitState,
  now = Date.now(),
): {
  ok: boolean;
  state: RateLimitState;
  reason?: string;
} {
  const pruned = prune(state, now);
  const hourlyCount = pruned.timestamps.filter((t) => t >= now - HOUR_MS).length;
  if (hourlyCount >= pruned.hourlyLimit) {
    return { ok: false, state: pruned, reason: "hourly limit reached" };
  }
  if (pruned.timestamps.length >= pruned.dailyLimit) {
    return { ok: false, state: pruned, reason: "daily limit reached" };
  }
  return { ok: true, state: pruned };
}

export function recordSpawn(state: RateLimitState, now = Date.now()): RateLimitState {
  const pruned = prune(state, now);
  return { ...pruned, timestamps: [...pruned.timestamps, now] };
}

export function snapshot(state: RateLimitState, now = Date.now()): SpawnUsage {
  const pruned = prune(state, now);
  return {
    hourly: pruned.timestamps.filter((t) => t >= now - HOUR_MS).length,
    daily: pruned.timestamps.length,
    hourlyLimit: pruned.hourlyLimit,
    dailyLimit: pruned.dailyLimit,
    lastSpawnAt:
      pruned.timestamps.length === 0
        ? null
        : new Date(pruned.timestamps[pruned.timestamps.length - 1] ?? 0).toISOString(),
  };
}
