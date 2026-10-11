/**
 * Builds a fully configured MCP server.
 *
 * A server instance binds to exactly one transport, so each transport needs
 * its own: one for stdio, and one per HTTP request in stateless mode. Tool
 * registration lives here so both paths expose an identical tool set.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";


import {
  deleteCallLogEntry,
  deleteCallLogEntryToolConfig,
  type DeleteCallLogEntryInput,
} from "./tools/delete_call_log_entry.js";
import { sendSms, sendSmsToolConfig, type SendSmsInput } from "./tools/send_sms.js";
import { sendMms, sendMmsToolConfig, type SendMmsInput } from "./tools/send_mms.js";
import {
  findMissedCalls,
  findMissedCallsToolConfig,
  type FindMissedCallsInput,
} from "./tools/find_missed_calls.js";
import {
  getVoicemail,
  getVoicemailToolConfig,
  type GetVoicemailInput,
} from "./tools/get_voicemail.js";
import {
  getSmsConversation,
  getSmsConversationToolConfig,
  type GetSmsConversationInput,
} from "./tools/get_sms_conversation.js";
import {
  getMessageStatus,
  getMessageStatusToolConfig,
  type GetMessageStatusInput,
} from "./tools/get_message_status.js";
import {
  detectFollowups,
  detectFollowupsToolConfig,
  type DetectFollowupsInput,
} from "./tools/detect_followups.js";
import {
  searchByPhoneNumber,
  searchByPhoneNumberToolConfig,
  type SearchByPhoneNumberInput,
} from "./tools/search_by_phone_number.js";
import {
  getCallRecording,
  getCallRecordingToolConfig,
  type GetCallRecordingInput,
} from "./tools/get_call_recording.js";
import {
  getCallHistory,
  getCallHistoryToolConfig,
  type GetCallHistoryInput,
} from "./tools/get_call_history.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "ringcentral-mcp",
    version: "0.1.0",
  });

  /** Wraps a tool handler so failures surface as MCP errors, not a dead server. */
  function jsonToolHandler<TInput, TResult>(
    name: string,
    run: (input: TInput) => Promise<TResult>,
  ) {
    return async (input: unknown) => {
      try {
        const result = await run(input as TInput);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // Every failure handed back to the model is logged here too. Until
        // this existed a tool could fail on every call — an expired token, a
        // missing scope — while the server logs stayed completely silent, so
        // the only trace was inside the assistant's reply.
        //
        // The message is the one we compose ourselves; it never carries a
        // credential. Arguments are deliberately not logged: they can contain
        // a customer's number or the body of a text message.
        console.error(`[tool] ${name} failed: ${message}`);

        return {
          isError: true,
          content: [{ type: "text" as const, text: `${name} failed: ${message}` }],
        };
      }
    };
  }

  server.registerTool(
    "get_call_history",
    getCallHistoryToolConfig,
    jsonToolHandler<GetCallHistoryInput, unknown>("get_call_history", getCallHistory),
  );

  server.registerTool(
    "get_call_recording",
    getCallRecordingToolConfig,
    jsonToolHandler<GetCallRecordingInput, unknown>("get_call_recording", getCallRecording),
  );

  server.registerTool(
    "search_by_phone_number",
    searchByPhoneNumberToolConfig,
    jsonToolHandler<SearchByPhoneNumberInput, unknown>(
      "search_by_phone_number",
      searchByPhoneNumber,
    ),
  );

  server.registerTool(
    "detect_followups",
    detectFollowupsToolConfig,
    jsonToolHandler<DetectFollowupsInput, unknown>("detect_followups", detectFollowups),
  );

  server.registerTool(
    "get_voicemail",
    getVoicemailToolConfig,
    jsonToolHandler<GetVoicemailInput, unknown>("get_voicemail", getVoicemail),
  );

  server.registerTool(
    "get_sms_conversation",
    getSmsConversationToolConfig,
    jsonToolHandler<GetSmsConversationInput, unknown>(
      "get_sms_conversation",
      getSmsConversation,
    ),
  );

  server.registerTool(
    "get_message_status",
    getMessageStatusToolConfig,
    jsonToolHandler<GetMessageStatusInput, unknown>("get_message_status", getMessageStatus),
  );

  server.registerTool(
    "find_missed_calls",
    findMissedCallsToolConfig,
    jsonToolHandler<FindMissedCallsInput, unknown>("find_missed_calls", findMissedCalls),
  );

  server.registerTool(
    "send_sms",
    sendSmsToolConfig,
    jsonToolHandler<SendSmsInput, unknown>("send_sms", sendSms),
  );

  server.registerTool(
    "send_mms",
    sendMmsToolConfig,
    jsonToolHandler<SendMmsInput, unknown>("send_mms", sendMms),
  );

  server.registerTool(
    "delete_call_log_entry",
    deleteCallLogEntryToolConfig,
    jsonToolHandler<DeleteCallLogEntryInput, unknown>(
      "delete_call_log_entry",
      deleteCallLogEntry,
    ),
  );

  return server;
}
