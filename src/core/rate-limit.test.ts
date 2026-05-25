import { describe, expect, it } from "vitest";
import { canSpawn, createRateLimitState, recordSpawn, snapshot } from "./rate-limit.js";

describe("rate-limit", () => {
  const now = Date.parse("2026-05-25T12:00:00Z");
  const hour = 60 * 60 * 1000;

  it("permits the first spawn", () => {
    const state = createRateLimitState(20, 100);
    expect(canSpawn(state, now).ok).toBe(true);
  });

  it("blocks at the hourly limit", () => {
    let state = createRateLimitState(2, 100);
    state = recordSpawn(state, now - 5 * 60 * 1000);
    state = recordSpawn(state, now - 1 * 60 * 1000);
    const result = canSpawn(state, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/hourly/);
  });

  it("blocks at the daily limit", () => {
    let state = createRateLimitState(100, 3);
    state = recordSpawn(state, now - 10 * hour);
    state = recordSpawn(state, now - 6 * hour);
    state = recordSpawn(state, now - 2 * hour);
    const result = canSpawn(state, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/daily/);
  });

  it("prunes events older than 24h from daily count", () => {
    let state = createRateLimitState(100, 3);
    state = recordSpawn(state, now - 25 * hour);
    state = recordSpawn(state, now - 23 * hour);
    state = recordSpawn(state, now - 1 * hour);
    expect(snapshot(state, now).daily).toBe(2);
    expect(canSpawn(state, now).ok).toBe(true);
  });

  it("reports a stable snapshot", () => {
    let state = createRateLimitState(20, 100);
    state = recordSpawn(state, now - 5 * 60 * 1000);
    const s = snapshot(state, now);
    expect(s.hourly).toBe(1);
    expect(s.daily).toBe(1);
    expect(s.hourlyLimit).toBe(20);
    expect(s.dailyLimit).toBe(100);
    expect(s.lastSpawnAt).toMatch(/2026-05-25/);
  });
});
