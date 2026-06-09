import { execFileSync } from "node:child_process";

const SECRET_TOKEN_PATTERN = /SECRET_[A-Z0-9_]+/gi;

export interface TerminalCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface TerminalCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  exit_code: number;
}

export class TerminalCommandError extends Error {
  readonly command: string;
  readonly args: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly exit_code: number;

  constructor(input: {
    message: string;
    command: string;
    args: readonly string[];
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }) {
    super(sanitizeTerminalText(input.message));
    this.name = "TerminalCommandError";
    this.command = sanitizeTerminalText(input.command);
    this.args = input.args.map((arg) => sanitizeTerminalText(arg));
    this.stdout = sanitizeTerminalText(input.stdout ?? "");
    this.stderr = sanitizeTerminalText(input.stderr ?? "");
    this.exitCode = input.exitCode ?? 1;
    this.exit_code = this.exitCode;
  }
}

export type TerminalCommandExecutor = (
  command: string,
  args: readonly string[],
  options?: TerminalCommandOptions & { shell: false }
) => TerminalCommandResult | Promise<TerminalCommandResult>;

export interface TerminalCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: TerminalCommandOptions
  ): TerminalCommandResult | Promise<TerminalCommandResult>;
}

export function runTerminalCommand(
  command: string,
  args: readonly string[],
  options: TerminalCommandOptions = {}
): TerminalCommandResult {
  try {
    const stdout = execFileSync(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      windowsHide: true
    });

    return {
      stdout: sanitizeTerminalText(stdout),
      stderr: "",
      exitCode: 0,
      exit_code: 0
    };
  } catch (error) {
    throw buildTerminalCommandError(command, args, error);
  }
}

export function createTerminalCommandRunner(options: {
  executor?: TerminalCommandExecutor;
} = {}): TerminalCommandRunner {
  return {
    run(command, args, commandOptions) {
      if (options.executor) {
        const result = options.executor(command, [...args], {
          ...commandOptions,
          shell: false
        });
        return normalizeMaybeAsyncResult(result);
      }

      return runTerminalCommand(command, args, commandOptions);
    }
  };
}

function normalizeMaybeAsyncResult(
  result: TerminalCommandResult | Promise<TerminalCommandResult>
): TerminalCommandResult | Promise<TerminalCommandResult> {
  if (typeof (result as Promise<TerminalCommandResult>).then === "function") {
    return (result as Promise<TerminalCommandResult>).then(normalizeCommandResult);
  }

  return normalizeCommandResult(result as TerminalCommandResult);
}

function normalizeCommandResult(
  result: TerminalCommandResult
): TerminalCommandResult {
  const exitCode = result.exitCode ?? result.exit_code ?? 0;
  return {
    stdout: sanitizeTerminalText(result.stdout),
    stderr: sanitizeTerminalText(result.stderr),
    exitCode,
    exit_code: exitCode
  };
}

function buildTerminalCommandError(
  command: string,
  args: readonly string[],
  error: unknown
): TerminalCommandError {
  const errorWithOutput = error as {
    message?: string;
    stdout?: unknown;
    stderr?: unknown;
    status?: number;
    code?: number | string;
  };
  const exitCode =
    typeof errorWithOutput.status === "number"
      ? errorWithOutput.status
      : typeof errorWithOutput.code === "number"
        ? errorWithOutput.code
        : 1;

  return new TerminalCommandError({
    message:
      error instanceof Error
        ? error.message
        : `${command} failed with exit code ${exitCode}`,
    command,
    args,
    stdout: outputToString(errorWithOutput.stdout),
    stderr: outputToString(errorWithOutput.stderr),
    exitCode
  });
}

function outputToString(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }

  return typeof value === "string" ? value : "";
}

function sanitizeTerminalText(value: string): string {
  return value
    .replace(SECRET_TOKEN_PATTERN, "[redacted_secret]")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}
