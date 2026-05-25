// pattern: types-only

export type Role = "coach" | "member";

export interface TeamMember {
  id: string;
  name: string;
  role: Role;
  email?: string;
  [extra: string]: unknown;
}

export interface Team {
  members: TeamMember[];
  [extra: string]: unknown;
}

export interface SessionInfo {
  name: string;
  claudeSessionId: string | null;
  participantIds: string[];
  hasMessages: boolean;
  createdAt: string;
  lastUsedAt: string;
}

export interface ToolCall {
  tool: string;
  params: Record<string, unknown>;
}

export interface ToolMutation {
  tool: string;
  params: Record<string, unknown>;
  sessionName: string;
  at: string;
  /** Opaque undo data the tool handler returns to enable rollback. */
  undo?: unknown;
}

export interface TranscriptEntry {
  at: string;
  role: "user" | "assistant" | "tool" | "system";
  text?: string;
  toolCall?: ToolCall;
  toolResult?: unknown;
  participantIds?: string[];
}

export interface SpawnEvent {
  type: "text" | "tool_use" | "tool_result" | "done" | "error";
  text?: string;
  toolCall?: ToolCall;
  raw?: unknown;
  error?: string;
}

export interface SpawnLimits {
  hourly: number;
  daily: number;
}

export interface SpawnUsage {
  hourly: number;
  daily: number;
  hourlyLimit: number;
  dailyLimit: number;
  lastSpawnAt: string | null;
}
