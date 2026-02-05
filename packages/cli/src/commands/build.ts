import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../lib/config.js';
import { createApiClient } from '../lib/api.js';
import { connectToJob } from '../lib/sse-client.js';
import { packProject } from '../lib/pack.js';
import type { Platform, SSEEvent } from '@buildq/shared';

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
      console.log('\u2192 Waiting for runner...');

      // Connect SSE
      let exitCode = 0;
      let finished = false;

      const sseConn = connectToJob(config.server, config.token, job.id);

      // Queue timeout warning
      const queueTimeout = setTimeout(() => {
        if (!finished) {
          console.log(
            yellow('\u26a0 Job has been waiting for 10 minutes. No runner has claimed it.'),
          );
          console.log('  Check runner status with: buildq status');
        }
      }, 10 * 60_000);

      // Stream output using named SSE events
      const done = new Promise<void>((resolve) => {
        sseConn.on('job:status', (event: SSEEvent) => {
          if (event.type !== 'job:status') return;
          switch (event.status) {
            case 'claimed':
              clearTimeout(queueTimeout);
              console.log(`\u2192 Runner picked up job`);
              break;
            case 'building':
              console.log('\u2192 Build started');
              console.log(dim('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 build output \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500'));
              break;
            case 'success':
              console.log(dim('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 build complete \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500'));
              console.log(green('\u2713 Build succeeded'));
              exitCode = 0;
              finished = true;
              break;
            case 'error':
              console.log(dim('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 build failed \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500'));
              console.log(red(`\u2717 Build failed${event.exitCode ? ` (exit code ${event.exitCode})` : ''}`));
              if (event.error) {
                console.log(red(`Error: ${event.error}`));
              }
              exitCode = event.exitCode ?? 1;
              finished = true;
              break;
            case 'cancelled':
              console.log(yellow('\u2192 Build cancelled'));
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
