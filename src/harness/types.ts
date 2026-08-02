import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type Status = "idle" | "running" | "stopping" | "stopped" | "exited" | "error" | "timed_out";

export const HARNESS_CAPABILITIES = [
  "start", "list", "status", "logs", "prompt", "steer", "follow_up",
  "control", "abort", "stop", "persisted_sessions",
] as const;
export type HarnessCapability = typeof HARNESS_CAPABILITIES[number];

export type Waiter = {
  resolve: (response: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export type Session = {
  id: string;
  harnessId: string;
  adapter: HarnessAdapter;
  cwd: string;
  title?: string;
  command: string[];
  process: ChildProcessWithoutNullStreams;
  status: Status;
  startedAt: number;
  updatedAt: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  output: string;
  events: unknown[];
  responseWaiters: Map<string, Waiter>;
  lifetimeTimer: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  state: Record<string, unknown>;
  negotiatedCapabilities?: HarnessCapability[];
  negotiatedControlCommands?: string[];
};

export type StartArgs = {
  cwd: string;
  prompt?: string;
  title?: string;
  model?: string;
  thinking?: string;
  continueRecent?: boolean;
  session?: string;
};

export interface HarnessAdapter {
  id: string;
  label: string;
  capabilities: HarnessCapability[];
  controlCommands?: readonly string[];
  note?: string;

  start(args: StartArgs): Promise<Session>;
  onMessage?(session: Session, message: unknown): void;
  prompt?(session: Session, message: string, streamingBehavior?: string): Promise<unknown>;
  steer?(session: Session, message: string): Promise<unknown>;
  followUp?(session: Session, message: string): Promise<unknown>;
  control?(session: Session, command: string, args: Record<string, unknown>): Promise<unknown>;
  abort?(session: Session): Promise<unknown>;
  close?(session: Session): Promise<unknown>;
  listPersisted?(limit: number): Promise<unknown[]>;
}

export function sessionCapabilities(session: Session): HarnessCapability[] {
  return session.negotiatedCapabilities ?? session.adapter.capabilities;
}

export function sessionControlCommands(session: Session): string[] {
  return session.negotiatedControlCommands ?? [...(session.adapter.controlCommands ?? [])];
}
