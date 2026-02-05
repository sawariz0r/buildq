import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { loadUserConfig, findProjectConfig } from '../lib/config.js';

const noColor = !!process.env['NO_COLOR'];
const green = (s: string) => (noColor ? s : `\x1b[32m${s}\x1b[0m`);
const dim = (s: string) => (noColor ? s : `\x1b[2m${s}\x1b[0m`);
const yellow = (s: string) => (noColor ? s : `\x1b[33m${s}\x1b[0m`);

const USER_CONFIG_PATH = path.join(os.homedir(), '.config', 'buildq', 'config.json');
const PROJECT_CONFIG_NAME = '.buildqconfig.json';

function prompt(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? dim(` (${defaultValue})`) : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

export const initCommand = new Command('init')
  .description('Configure buildq server URL and authentication')
  .option('--project', 'Save server URL to .buildqconfig.json in the current directory')
  .action(async (opts) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      console.log('\n\u2192 BuildQ Setup\n');

      // Load existing config for defaults
      const existingUser = loadUserConfig();
      const existingProject = findProjectConfig();

      // Prompt for server URL
      const currentServer = existingUser?.server || existingProject?.server;
      const server = await prompt(
        rl,
        '  Server URL',
        currentServer,
      );

      if (!server) {
        console.error(yellow('\n\u26a0 Server URL is required. Aborting.'));
        process.exit(1);
      }

      // Validate URL format
      try {
        new URL(server);
      } catch {
        console.error(yellow(`\n\u26a0 "${server}" does not look like a valid URL. Aborting.`));
        process.exit(1);
      }

      // Prompt for token
      const currentToken = existingUser?.token;
      const tokenHint = currentToken ? `${currentToken.slice(0, 4)}${'*'.repeat(Math.max(0, currentToken.length - 4))}` : undefined;
      const token = await prompt(
        rl,
        '  Auth token',
        tokenHint ? `keep existing` : undefined,
      );

      const keepExistingToken = token === 'keep existing' && currentToken;
      const finalToken = keepExistingToken ? currentToken : token;

      // Save to user config (always — this is where token goes)
      const userConfig: Record<string, unknown> = { ...existingUser };
      userConfig.server = server;
      if (finalToken) {
        userConfig.token = finalToken;
      }

      fs.mkdirSync(path.dirname(USER_CONFIG_PATH), { recursive: true });
      fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2) + '\n');
      console.log(green(`\n\u2713 Saved user config to ${USER_CONFIG_PATH}`));

      // Optionally save server URL to project config
      if (opts.project) {
        const projectConfigPath = path.join(process.cwd(), PROJECT_CONFIG_NAME);
        let projectConfig: Record<string, unknown> = {};
        try {
          projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
        } catch {}

        projectConfig.server = server;
        // Never write token to project config
        fs.writeFileSync(projectConfigPath, JSON.stringify(projectConfig, null, 2) + '\n');
        console.log(green(`\u2713 Saved project config to ${projectConfigPath}`));
        console.log(dim('  (token is NOT stored in project config for security)'));
      }

      // Verify connection
      console.log(dim('\n\u2192 Testing connection...'));
      try {
        const healthUrl = new URL('/health', server).toString();
        const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          console.log(green('\u2713 Server is reachable'));
        } else {
          console.log(yellow(`\u26a0 Server responded with status ${res.status}`));
        }
      } catch (err) {
        console.log(yellow(`\u26a0 Could not reach server: ${(err as Error).message}`));
        console.log(dim('  (you can still use buildq — the server may not be running yet)'));
      }

      console.log(dim(`\nRun ${noColor ? 'buildq status' : '\x1b[1mbuildq status\x1b[0m\x1b[2m'} to verify your setup.\n`));
    } finally {
      rl.close();
    }
  });
