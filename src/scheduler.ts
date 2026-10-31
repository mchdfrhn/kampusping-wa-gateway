/** Clock and sleep, injected so retry and delay logic is tested without real waiting. */
export interface Scheduler {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))),
};
