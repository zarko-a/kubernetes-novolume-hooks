// Delays between polls while waiting for the job pod (or a container step's Job).
//
// Upstream doubled the delay from 1s up to 20s, so a pod that was Running at 16s was only
// noticed at 31s. Warm pods are Running in 5-8s, so poll often early and never wait more
// than 3s: one GET of a single pod per second per starting job is cheap for the API server.
export const POLL_INITIAL_MS = 1000
export const POLL_FACTOR = 1.15
export const POLL_MAX_MS = 3000

export class PollSchedule {
  private delayMs: number

  constructor(
    initialMs = POLL_INITIAL_MS,
    private readonly factor = POLL_FACTOR,
    private readonly maxMs = POLL_MAX_MS
  ) {
    this.delayMs = initialMs
  }

  // The delay before the next poll, in whole milliseconds.
  next(): number {
    const delay = Math.round(this.delayMs)
    this.delayMs = Math.min(this.delayMs * this.factor, this.maxMs)
    return delay
  }
}
