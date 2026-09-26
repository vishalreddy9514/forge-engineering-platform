/** A dependency the API needs in order to serve traffic. `check` rejects when it is unhealthy. */
export interface HealthIndicator {
  readonly name: string;
  check(): Promise<void>;
}

export const HEALTH_INDICATORS = Symbol('HEALTH_INDICATORS');
