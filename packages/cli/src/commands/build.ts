import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../lib/config.js';
import { createApiClient } from '../lib/api.js';
import { connectToJob } from '../lib/sse-client.js';
import type { ConnectionState } from '../lib/sse-client.js';
import { packProject } from '../lib/pack.js';
import { createSpinner } from '../lib/spinner.js';
import type { Spinner } from '../lib/spinner.js';
import type { Platform, SSEEvent, RunnerStep } from '@buildq/shared';

const noColor = !!process.env['NO_COLOR'];
const green = (s: string) => (noColor ? s : `\x1b[32m${s}\x1b[0m`);
const red = (s: string) => (noColor ? s : `\x1b[31m${s}\x1b[0m`);
const dim = (s: string) => (noColor ? s : `\x1b[2m${s}\x1b[0m`);
const yellow = (s: string) => (noColor ? s : `\x1b[33m${s}\x1b[0m`);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

const STEP_LABELS: Record<RunnerStep, string> = {
  downloading_tarball: 'Downloading project to runner...',
  extracting: 'Extracting project...',
  git_init: 'Initializing git repo...',
  installing_deps: 'Installing dependencies...',
  building: 'Building...',
  uploading_artifact: 'Uploading artifact...',
};

export const buildCommand = new Command('build')
  .description('Submit a build job to the queue')
  .requiredOption('-p, --platform <platform>', 'Build platform: ios or android')
  .option('-P, --profile <name>', 'EAS build profile')
  .option('-f, --flag <flag...>', 'Extra flags to pass to eas build')
  .option('--no-download', 'Do not download artifact after build')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};

    const config = loadConfig({
      server: globalOpts.server,
      token: globalOpts.token,
    });

    const platform = opts.platform as Platform;
    if (platform !== 'ios' && platform !== 'android') {
      console.error(red(`\u2717 Invalid platform: ${opts.platform}. Must be "ios" or "android".`));
      process.exit(1);
    }

    // Resolve profile from config defaults
    const profile =
      opts.profile ??
      config.defaults?.[platform]?.profile ??
      'development';

    const flags = [
      ...(config.defaults?.[platform]?.flags ?? []),
      ...(opts.flag ?? []),
    ];

    const api = createApiClient(config);

    // Check runner availability
    try {
      const { runners } = await api.listRunners();
      const hasRunner = runners.some(
        (r) => r.platforms.includes(platform),
      );
      if (!hasRunner) {
        console.log(
          yellow(`\u26a0 No active ${platform} runner detected. Job will be queued and wait for a runner.`),
        );
      }
    } catch {
      // Non-fatal -- continue even if we can't check runners
    }

    // Pack project
    console.log('\u2192 Packing project...');
    let tarballPath: string | undefined;

    try {
      const packResult = await packProject(process.cwd());
      tarballPath = packResult.tarballPath;
      const sizeBytes = packResult.sizeBytes;
      console.log(`\u2192 Packed project (${formatSize(sizeBytes)})`);

      // Submit job
      const tarball = fs.readFileSync(tarballPath);
      const { job } = await api.submitJob(tarball, {
        platform,
        profile,
        flags,
        submittedBy: os.hostname(),
      });

      console.log(`\u2192 Job submitted: ${job.id}`);

      // Connect SSE
      let exitCode = 0;
      let finished = false;
      let spinner: Spinner | null = createSpinner('Waiting for runner...');
      let buildStarted = false;

      const sseConn = connectToJob(config.server, config.token, job.id);

      // Queue timeout warning
      const queueTimeout = setTimeout(() => {
        if (!finished) {
          if (spinner) spinner.update('Waiting for runner (10m+, no runner claimed)...');
          else {
            console.log(
              yellow('\u26a0 Job has been waiting for 10 minutes. No runner has claimed it.'),
            );
            console.log('  Check runner status with: buildq status');
          }
        }
      }, 10 * 60_000);

      // Handle connection state
      sseConn.on('stateChange', ((state: ConnectionState) => {
        if (finished) return;
        if (state === 'disconnected' && spinner) {
          spinner.update('Connection interrupted, reconnecting...');
        } else if (state === 'connected' && spinner && !buildStarted) {
          spinner.update('Waiting for runner...');
        }
      }) as unknown as (event: SSEEvent) => void);

      // Stream output using named SSE events
      const done = new Promise<void>((resolve) => {
        sseConn.on('job:step', (event: SSEEvent) => {
          if (event.type !== 'job:step') return;
          if (spinner) {
            const label = STEP_LABELS[event.step] || event.step;
            spinner.update(label);
          }
        });

        sseConn.on('job:status', (event: SSEEvent) => {
          if (event.type !== 'job:status') return;
          switch (event.status) {
            case 'claimed':
              clearTimeout(queueTimeout);
              if (spinner) {
                const host = event.hostname ? ` (${event.hostname})` : '';
                spinner.update(`Runner${host} picked up job...`);
              }
              break;
            case 'building':
              buildStarted = true;
              if (spinner) {
                spinner.stop('\u2192', 'Build started');
                spinner = null;
              }
              console.log(dim('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 build output \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500'));
              break;
            case 'success':
              console.log(dim('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 build complete \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500'));
              console.log(green('\u2713 Build succeeded'));
              exitCode = 0;
              finished = true;
              break;
            case 'error': {
              if (spinner) {
                spinner.stop(red('\u2717'), red('Build failed'));
                spinner = null;
              } else {
                console.log(dim('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 build failed \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500'));
              }
              console.log(red(`\u2717 Build failed${event.exitCode ? ` (exit code ${event.exitCode})` : ''}`));
              if (event.error) {
                // Check if error contains multi-line build output
                if (event.error.includes('\n')) {
                  const lines = event.error.split('\n');
                  console.log(red(`Error: ${lines[0]}`));
                  console.log(dim('  Last output:'));
                  for (const line of lines.slice(1)) {
                    console.log(dim(`  ${line}`));
                  }
                } else {
                  console.log(red(`Error: ${event.error}`));
                }
              }
              exitCode = event.exitCode ?? 1;
              finished = true;
              break;
            }
            case 'cancelled':
              if (spinner) {
                spinner.stop('\u2192', yellow('Build cancelled'));
                spinner = null;
              } else {
                console.log(yellow('\u2192 Build cancelled'));
              }
              exitCode = 130;
              finished = true;
              break;
          }

          if (finished) {
            resolve();
          }
        });

        sseConn.on('job:log', (event: SSEEvent) => {
          if (event.type !== 'job:log') return;
          // Suppress log output while spinner is active (pre-build phase)
          if (spinner) return;
          const lines = event.data.split('\n');
          for (const line of lines) {
            if (line) {
              const prefix = event.stream === 'stderr' ? '\u2502 ' : dim('\u2502 ');
              process.stdout.write(`${prefix}${line}\n`);
            }
          }
        });

        sseConn.on('job:artifact', (event: SSEEvent) => {
          if (event.type !== 'job:artifact') return;
          console.log(`\u2192 Artifact ready: ${event.filename}`);
        });
      });

      // Ctrl+C handling
      const sigintHandler = async () => {
        if (spinner) {
          spinner.clear();
          spinner = null;
        }
        console.log('\n\u2192 Cancelling build...');
        try {
          await api.cancelJob(job.id);
        } catch {
          // Best-effort cancel
        }
        sseConn.close();
        clearTimeout(queueTimeout);
        process.exit(130);
      };
      process.on('SIGINT', sigintHandler);

      await done;
      clearTimeout(queueTimeout);

      // Download artifact
      if (exitCode === 0 && opts.download !== false) {
        try {
          const buildsDir = path.join(process.cwd(), 'builds');
          fs.mkdirSync(buildsDir, { recursive: true });
          const filename = await api.downloadArtifact(job.id, buildsDir + '/');
          console.log(green(`\u2713 Downloaded: ./builds/${filename}`));
        } catch (err) {
          console.log(yellow(`\u26a0 Could not download artifact: ${(err as Error).message}`));
        }
      }

      // Cleanup and exit
      sseConn.close();
      process.removeListener('SIGINT', sigintHandler);
      process.exit(exitCode);
    } finally {
      // Clean up temp tarball
      if (tarballPath) {
        try {
          fs.unlinkSync(tarballPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  });
