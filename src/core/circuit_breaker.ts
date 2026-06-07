/**
 * Circuit breaker pattern for fault tolerance
 */

export interface CircuitBreakerConfig {
  name: string;
  failureThreshold?: number;
  successThreshold?: number;
  resetTimeout?: number;
}

export type CircuitBreakerState = "closed" | "open" | "half_open";

/**
 * Circuit breaker implementation
 */
export class CircuitBreaker {
  private name: string;
  private state: CircuitBreakerState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private failureThreshold: number;
  private successThreshold: number;
  private resetTimeout: number;

  constructor(config: CircuitBreakerConfig) {
    this.name = config.name;
    this.failureThreshold = config.failureThreshold ?? 5;
    this.successThreshold = config.successThreshold ?? 3;
    this.resetTimeout = config.resetTimeout ?? 60000; // 60 seconds
  }

  /**
   * Check if execution is allowed
   */
  canExecute(): boolean {
    if (this.state === "closed") {
      return true;
    }

    if (this.state === "open") {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure > this.resetTimeout) {
        this.state = "half_open";
        this.successCount = 0;
        return true;
      }
      return false;
    }

    // half_open state allows attempts
    return true;
  }

  /**
   * Record a successful execution
   */
  recordSuccess(): void {
    this.failureCount = 0;

    if (this.state === "half_open") {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = "closed";
        this.successCount = 0;
      }
    }
  }

  /**
   * Record a failed execution
   */
  recordFailure(): void {
    this.lastFailureTime = Date.now();
    this.failureCount++;

    if (this.failureCount >= this.failureThreshold) {
      this.state = "open";
      this.failureCount = 0;
    }

    if (this.state === "half_open") {
      this.state = "open";
      this.failureCount = 0;
    }
  }

  /**
   * Get current state
   */
  getState(): CircuitBreakerState {
    return this.state;
  }

  /**
   * Reset the circuit breaker
   */
  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
  }
}

/**
 * Get or create a circuit breaker for a service
 */
const breakers = new Map<string, CircuitBreaker>();

export function getBreaker(name: string, config?: CircuitBreakerConfig): CircuitBreaker {
  if (!breakers.has(name)) {
    breakers.set(name, new CircuitBreaker(config ?? { name }));
  }
  return breakers.get(name)!;
}

export function clearBreakers(): void {
  breakers.clear();
}
