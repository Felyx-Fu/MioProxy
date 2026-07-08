export interface RuntimePaths {
  profileDir: string;
  candidatePath: string;
  activePath: string;
  lastKnownGoodPath: string;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number }
) => Promise<CommandResult>;
