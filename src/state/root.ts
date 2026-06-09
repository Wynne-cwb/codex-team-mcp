import path from "node:path";

export const DEFAULT_STATE_ROOT = ".codex-team/state";
export const STATE_DB_FILENAME = "codex-team.sqlite";

export type StateRootSource = "option" | "env" | "default";

export interface StateRootWarning {
  code: "state_root_inside_package";
  message: string;
}

export interface ResolvedStateRoot {
  workspaceRoot: string;
  stateRoot: string;
  databasePath: string;
  source: StateRootSource;
  defaultStateRoot: typeof DEFAULT_STATE_ROOT;
  warnings: StateRootWarning[];
}

export interface ResolveStateRootOptions {
  stateRoot?: string;
  workspaceRoot?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

const STATE_ROOT_INSIDE_PACKAGE_MESSAGE =
  "Default state root resolved under codex-team package source; pass CODEX_TEAM_WORKSPACE_ROOT or CODEX_TEAM_STATE_ROOT to isolate runtime state.";

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

function isDefaultUnderPackageSource(resolvedStateRoot: string): boolean {
  const segments = path.normalize(resolvedStateRoot).split(path.sep).filter(Boolean);
  const lastSegments = segments.slice(-3);

  return (
    lastSegments[0] === "codex-team" &&
    lastSegments[1] === ".codex-team" &&
    lastSegments[2] === "state"
  );
}

export function resolveStateRoot(options: ResolveStateRootOptions = {}): ResolvedStateRoot {
  const env = options.env ?? process.env;
  const workspaceRoot = path.resolve(
    firstNonBlank(options.workspaceRoot, env.CODEX_TEAM_WORKSPACE_ROOT, options.cwd) ??
      process.cwd()
  );

  const configuredStateRoot = firstNonBlank(options.stateRoot);
  const envStateRoot = firstNonBlank(env.CODEX_TEAM_STATE_ROOT);
  const source: StateRootSource = configuredStateRoot
    ? "option"
    : envStateRoot
      ? "env"
      : "default";
  const stateRootInput = configuredStateRoot ?? envStateRoot ?? DEFAULT_STATE_ROOT;
  const stateRoot = path.resolve(workspaceRoot, stateRootInput);
  const warnings: StateRootWarning[] = [];

  if (source === "default" && isDefaultUnderPackageSource(stateRoot)) {
    warnings.push({
      code: "state_root_inside_package",
      message: STATE_ROOT_INSIDE_PACKAGE_MESSAGE
    });
  }

  return {
    workspaceRoot,
    stateRoot,
    databasePath: path.join(stateRoot, STATE_DB_FILENAME),
    source,
    defaultStateRoot: DEFAULT_STATE_ROOT,
    warnings
  };
}
