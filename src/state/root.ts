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

function packageInstallWarningMessage(workspaceRoot: string): string {
  return (
    `Workspace root resolved to the codex-team package install directory (${workspaceRoot}); ` +
    "teams bind here instead of your project and file-modifying TeamMates are blocked with " +
    "workspace_isolation_required. Set CODEX_TEAM_WORKSPACE_ROOT to your project repo, remove any " +
    "`cwd` override in the MCP server config, or launch codex from inside the project repo."
  );
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

// True when the resolved workspace root is the codex-team package's OWN install
// directory rather than a user project. Catches both the dev checkout (the repo's
// `codex-team/` dir) and the published/vendored install (`.../codex-team-mcp`,
// including a `node_modules/codex-team-mcp` whose basename is `codex-team-mcp`).
// Binding teams there is almost always a misconfiguration: a `cwd` override pinned
// the MCP server's process.cwd() to its install dir while CODEX_TEAM_WORKSPACE_ROOT
// was unset, so the workspace root fell back to that install dir.
function isWorkspaceRootPackageInstall(workspaceRoot: string): boolean {
  const base = path.basename(path.normalize(workspaceRoot));
  return base === "codex-team-mcp" || base === "codex-team";
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

  // Detection keys off the WORKSPACE root (not the state-root source): even with an
  // explicit CODEX_TEAM_STATE_ROOT, a workspace root that is the package install dir
  // still mis-binds every team. An explicit CODEX_TEAM_WORKSPACE_ROOT is the fix, so
  // this only fires when the resolved root looks like the install dir itself.
  if (isWorkspaceRootPackageInstall(workspaceRoot)) {
    warnings.push({
      code: "state_root_inside_package",
      message: packageInstallWarningMessage(workspaceRoot)
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
