class RateLimiter {
  constructor() {
    this.baseDelay = 100;
    this.maxDelay = 5000;
    this.currentDelay = this.baseDelay;
  }

  async wait() {
    const jitter = Math.random() * 50; // 0-50ms jitter
    await new Promise(resolve => setTimeout(resolve, this.currentDelay + jitter));
  }

  hit429() {
    this.currentDelay = Math.min(this.currentDelay * 2, this.maxDelay);
  }

  reset() {
    this.currentDelay = this.baseDelay;
  }
}

export default RateLimiter;