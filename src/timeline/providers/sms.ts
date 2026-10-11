import { describeScopeError, fetchMessages } from "../../ringcentral/messages.js";
import type { TimelineEvent, TimelineProvider, TimelineProviderResult } from "../types.js";

/**
 * SMS provider. Inert until the ReadMessages scope is enabled: a permission
 * error marks the source unavailable instead of failing the timeline.
 */

function preview(text: string | undefined): string {
  if (!text) return "(no text)";
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 77)}…` : collapsed;
}

export const smsProvider: TimelineProvider = {
  name: "sms",
  type: "sms",

  async fetch(query): Promise<TimelineProviderResult> {
    let fetched;
    try {
      fetched = await fetchMessages({
        messageType: "SMS",
        phoneNumber: query.phoneNumber,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        perPage: query.perPage,
      });
    } catch (error) {
      const hint = describeScopeError(error, "ReadMessages");
      if (hint) return { events: [], truncated: false, unavailable: hint };
      throw error;
    }

    const events: TimelineEvent[] = fetched.messages.map((message) => {
      const participant =
        message.direction === "Outbound" ? (message.to[0] ?? {}) : message.from;
      const who = participant.name ?? participant.number ?? "unknown";
      const preposition = message.direction === "Outbound" ? "to" : "from";

      return {
        timestamp: message.timestamp ?? "",
        type: "sms",
        direction: message.direction,
        participant,
        summary: `${message.direction ?? "SMS"} SMS ${preposition} ${who} — ${preview(
          message.subject,
        )}`,
        details: {
          messageId: message.id,
          text: message.subject,
          status: message.status,
          readStatus: message.readStatus,
          conversationId: message.conversationId,
          from: message.from,
          to: message.to,
        },
      };
    });

    return {
      events,
      truncated: fetched.truncated,
      stats: { pagesFetched: fetched.pagesFetched, messages: events.length },
    };
  },
};
