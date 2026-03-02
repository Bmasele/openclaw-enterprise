import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

type BuildMediaLocalRootsOptions = {
  preferredTmpDir?: string;
};

let cachedPreferredTmpDir: string | undefined;

function resolveCachedPreferredTmpDir(): string {
  if (!cachedPreferredTmpDir) {
    cachedPreferredTmpDir = resolvePreferredOpenClawTmpDir();
  }
  return cachedPreferredTmpDir;
}

function buildMediaLocalRoots(
  stateDir: string,
  options: BuildMediaLocalRootsOptions = {},
): string[] {
  const resolvedStateDir = path.resolve(stateDir);
  const preferredTmpDir = options.preferredTmpDir ?? resolveCachedPreferredTmpDir();
  return [
    preferredTmpDir,
    path.join(resolvedStateDir, "media"),
    path.join(resolvedStateDir, "agents"),
    path.join(resolvedStateDir, "workspace"),
    path.join(resolvedStateDir, "sandboxes"),
  ];
}

export function getDefaultMediaLocalRoots(): readonly string[] {
  return buildMediaLocalRoots(resolveStateDir());
}

export function getAgentScopedMediaLocalRoots(
  cfg: OpenClawConfig,
  agentId?: string,
): readonly string[] {
  const roots = buildMediaLocalRoots(resolveStateDir());
  if (agentId?.trim()) {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    if (workspaceDir) {
      const normalizedWorkspaceDir = path.resolve(workspaceDir);
      if (!roots.includes(normalizedWorkspaceDir)) {
        roots.push(normalizedWorkspaceDir);
      }
    }
  }
  // Always include all agent workspace directories so that gateway-routed
  // messages (where agentId may be resolved differently) can still access
  // files created by any agent.
  const agents = cfg.agents as Record<string, unknown> | undefined;
  const list = agents?.list as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(list)) {
    for (const agent of list) {
      const ws = (agent as Record<string, unknown>).workspace;
      if (typeof ws === "string" && ws.trim()) {
        const resolved = path.resolve(ws);
        if (!roots.includes(resolved)) {
          roots.push(resolved);
        }
      }
    }
  }
  return roots;
}
