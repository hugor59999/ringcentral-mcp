/**
 * Normalized timeline model.
 *
 * Every source of contact history — calls today, SMS and voicemail once the
 * scopes are granted — is reduced to the same `TimelineEvent` shape so the
 * aggregation tool can merge them by time without knowing what they are.
 */

export type TimelineEventType = "call" | "sms" | "voicemail";

export interface TimelineParticipant {
  /** The other party's number, in whatever form RingCentral reports it. */
  number?: string;
  name?: string;
  extension?: string;
}

export interface TimelineEvent {
  /** ISO 8601. The sort key for the merged timeline. */
  timestamp: string;
  type: TimelineEventType;
  direction?: string;
  participant: TimelineParticipant;
  /** One-line, human-readable description of the event. */
  summary: string;
  /** Type-specific payload. Shape is owned by the provider. */
  details: Record<string, unknown>;
}

/** What every provider is handed. `phoneNumber` is already digits-only. */
export interface TimelineQuery {
  phoneNumber: string;
  dateFrom?: string;
  dateTo?: string;
  perPage: number;
}

export interface TimelineProviderResult {
  events: TimelineEvent[];
  /** True when the source had more data than the caps allowed. */
  truncated: boolean;
  /** Free-form counters for the response, e.g. pagesFetched. */
  stats?: Record<string, number>;
  /**
   * Set when the source exists but cannot be read yet — typically a scope that
   * is not enabled. The timeline still returns; this source is reported as
   * pending rather than failing the whole merge.
   */
  unavailable?: string;
}

export interface TimelineProvider {
  /** Stable identifier used in the response's `sources` block. */
  name: string;
  type: TimelineEventType;
  fetch: (query: TimelineQuery) => Promise<TimelineProviderResult>;
}
