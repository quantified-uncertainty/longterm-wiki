import { describe, expect, it } from 'vitest';
import {
  createIdleState,
  nextCycle,
  type IdleTrackerConfig,
} from './idle-tracker.ts';

const CONFIG: IdleTrackerConfig = {
  tripThreshold: 20,
  baseSleepSeconds: 30,
  maxSleepSeconds: 1800,
};

describe('idle-tracker', () => {
  it('starts at streak 0', () => {
    expect(createIdleState()).toEqual({ noOpStreak: 0 });
  });

  it('didWork keeps streak at 0 and uses base sleep', () => {
    const result = nextCycle(createIdleState(), true, CONFIG);
    expect(result.state.noOpStreak).toBe(0);
    expect(result.sleepSeconds).toBe(30);
    expect(result.justTripped).toBe(false);
  });

  it('no-op increments streak but keeps base sleep below threshold', () => {
    let state = createIdleState();
    for (let i = 1; i < 20; i++) {
      const r = nextCycle(state, false, CONFIG);
      expect(r.state.noOpStreak).toBe(i);
      expect(r.sleepSeconds).toBe(30);
      expect(r.justTripped).toBe(false);
      state = r.state;
    }
  });

  it('engages exactly once at the threshold', () => {
    let state = createIdleState();
    let trips = 0;
    for (let i = 1; i <= 25; i++) {
      const r = nextCycle(state, false, CONFIG);
      if (r.justTripped) trips++;
      state = r.state;
    }
    expect(trips).toBe(1);
  });

  it('justTripped fires on the K=20 boundary', () => {
    let state = createIdleState();
    let result;
    for (let i = 0; i < 20; i++) {
      result = nextCycle(state, false, CONFIG);
      state = result.state;
    }
    expect(result!.state.noOpStreak).toBe(20);
    expect(result!.justTripped).toBe(true);
    expect(result!.sleepSeconds).toBe(30); // base * 2^0
  });

  it('doubles sleep on each cycle past the threshold', () => {
    let state: { noOpStreak: number } = { noOpStreak: 20 };
    const sleeps: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = nextCycle(state, false, CONFIG);
      sleeps.push(r.sleepSeconds);
      state = r.state;
    }
    // streak=21,22,23,24,25 → overshoot=1,2,3,4,5 → sleep=60,120,240,480,960
    expect(sleeps).toEqual([60, 120, 240, 480, 960]);
  });

  it('caps sleep at maxSleepSeconds', () => {
    let state: { noOpStreak: number } = { noOpStreak: 25 };
    for (let i = 0; i < 10; i++) {
      const r = nextCycle(state, false, CONFIG);
      state = r.state;
      expect(r.sleepSeconds).toBeLessThanOrEqual(CONFIG.maxSleepSeconds);
    }
  });

  it('stays at max sleep deep into the streak', () => {
    let state: { noOpStreak: number } = { noOpStreak: 100 };
    const r = nextCycle(state, false, CONFIG);
    expect(r.sleepSeconds).toBe(CONFIG.maxSleepSeconds);
  });

  it('didWork after backoff resets streak and base sleep', () => {
    let state: { noOpStreak: number } = { noOpStreak: 30 };
    const r = nextCycle(state, true, CONFIG);
    expect(r.state.noOpStreak).toBe(0);
    expect(r.sleepSeconds).toBe(30);
    expect(r.justTripped).toBe(false);
  });

  it('justTripped does not re-fire after the boundary', () => {
    let state: { noOpStreak: number } = { noOpStreak: 20 };
    for (let i = 0; i < 5; i++) {
      const r = nextCycle(state, false, CONFIG);
      expect(r.justTripped).toBe(false);
      state = r.state;
    }
  });

  it('justTripped re-arms after a work cycle resets the streak', () => {
    let state: { noOpStreak: number } = { noOpStreak: 19 };
    const trip1 = nextCycle(state, false, CONFIG);
    expect(trip1.justTripped).toBe(true);
    const reset = nextCycle(trip1.state, true, CONFIG);
    expect(reset.state.noOpStreak).toBe(0);
    // Climb back up: now at streak 0, need 20 more no-ops to trip again.
    state = reset.state;
    for (let i = 0; i < 19; i++) state = nextCycle(state, false, CONFIG).state;
    const trip2 = nextCycle(state, false, CONFIG);
    expect(trip2.justTripped).toBe(true);
  });

  it('handles tripThreshold=1 (degenerate but valid)', () => {
    const cfg = { ...CONFIG, tripThreshold: 1 };
    const r = nextCycle(createIdleState(), false, cfg);
    expect(r.justTripped).toBe(true);
    expect(r.sleepSeconds).toBe(cfg.baseSleepSeconds);
  });

  it('handles base=max (no backoff possible)', () => {
    const cfg = { ...CONFIG, baseSleepSeconds: 60, maxSleepSeconds: 60 };
    let state: { noOpStreak: number } = { noOpStreak: 30 };
    const r = nextCycle(state, false, cfg);
    expect(r.sleepSeconds).toBe(60);
  });

  it('clamps to base when misconfigured base > max (defensive)', () => {
    // base=2400 > max=1800: cap would shorten the base interval, which
    // is wrong. The clamp keeps sleep >= base.
    const cfg = { ...CONFIG, baseSleepSeconds: 2400, maxSleepSeconds: 1800 };
    let state: { noOpStreak: number } = { noOpStreak: 30 };
    const r = nextCycle(state, false, cfg);
    expect(r.sleepSeconds).toBeGreaterThanOrEqual(cfg.baseSleepSeconds);
  });
});
