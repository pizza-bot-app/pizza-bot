/** The sandbox worker's wedge detector: a deadline that elapses only while resumed. */
export class Watchdog {
  private remainingMs: number;
  private startedAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    budgetMs: number,
    private readonly onExpire: () => void,
  ) {
    this.remainingMs = budgetMs;
  }

  resume(): void {
    if (this.timer !== undefined) return;
    this.startedAt = Date.now();
    this.timer = setTimeout(this.onExpire, this.remainingMs);
  }

  pause(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.remainingMs = Math.max(0, this.remainingMs - (Date.now() - this.startedAt));
  }
}
