import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ResolvedConfig {
  server: string;
  token: string;
  defaults?: {
    ios?: { profile?: string; flags?: string[] };
    android?: { profile?: string; flags?: string[] };
  };
}

interface ProjectConfig {
  server?: string;
  defaults?: ResolvedConfig['defaults'];
}

interface UserConfig {
  server?: string;
  token?: string;
  defaults?: ResolvedConfig['defaults'];
}

/**
 * Walk up from cwd looking for `.buildqconfig.json`.
 * Returns parsed content or null if not found.
 */
export function findProjectConfig(): ProjectConfig | null {
  let dir = process.cwd();

  while (true) {
    const configPath = path.join(dir, '.buildqconfig.json');
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(raw) as ProjectConfig;
    } catch {
      // File doesn't exist or is invalid — keep walking up
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      // Reached filesystem root
      return null;
    }
    dir = parent;
  }
}

/**
 * Read `~/.config/buildq/config.json`.
 * Returns parsed content or null if not found or invalid.
 */
export function loadUserConfig(): UserConfig | null {
  const configPath = path.join(os.homedir(), '.config', 'buildq', 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as UserConfig;
  } catch {
    return null;
  }
}

/**
 * Resolve configuration with priority: CLI flag > env > project config > user config.
 *
 * Token is intentionally NOT read from project config for security reasons
 * (project configs are typically committed to version control).
 *
 * Throws with a helpful message if server or token is missing after merging all sources.
 */
export function loadConfig(cliOptions: { server?: string; token?: string }): ResolvedConfig {
  const userConfig = loadUserConfig();
  const projectConfig = findProjectConfig();

  // Resolve server: CLI flag > env > project config > user config
  const server =
    cliOptions.server ??
    process.env['BUILDQ_SERVER'] ??
    projectConfig?.server ??
    userConfig?.server;

  // Resolve token: CLI flag > env > user config (NOT from project config for security)
  const token =
    cliOptions.token ??
    process.env['BUILDQ_TOKEN'] ??
    userConfig?.token;

  // Merge defaults: project config overrides user config
  let defaults: ResolvedConfig['defaults'] | undefined;
  if (userConfig?.defaults || projectConfig?.defaults) {
    defaults = {
      ios: {
        ...userConfig?.defaults?.ios,
        ...projectConfig?.defaults?.ios,
      },
      android: {
        ...userConfig?.defaults?.android,
        ...projectConfig?.defaults?.android,
      },
    };
  }

  if (!server) {
    throw new Error(
      'buildq server URL is required. Set it via:\n' +
      '  --server <url>           (CLI flag)\n' +
      '  BUILDQ_SERVER=<url>      (environment variable)\n' +
      '  .buildqconfig.json       (project config: { "server": "<url>" })\n' +
      '  ~/.config/buildq/config.json  (user config)'
    );
  }

  if (!token) {
    throw new Error(
      'buildq auth token is required. Set it via:\n' +
      '  --token <token>          (CLI flag)\n' +
      '  BUILDQ_TOKEN=<token>     (environment variable)\n' +
      '  ~/.config/buildq/config.json  (user config: { "token": "<token>" })\n' +
      '\n' +
      'Note: For security, tokens are NOT read from project config (.buildqconfig.json).'
    );
  }

  return { server, token, defaults };
}
