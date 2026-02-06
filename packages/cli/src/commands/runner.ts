import { Command } from 'commander';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { nanoid } from 'nanoid';
import * as tar from 'tar';
import { loadConfig } from '../lib/config.js';
import { createApiClient } from '../lib/api.js';
import { connectToPlatform } from '../lib/sse-client.js';
import type { Platform, SSEEvent, Job } from '@buildq/shared';

const noColor = !!process.env['NO_COLOR'];
const green = (s: string) => (noColor ? s : `\x1b[32m${s}\x1b[0m`);
const red = (s: string) => (noColor ? s : `\x1b[31m${s}\x1b[0m`);
const dim = (s: string) => (noColor ? s : `\x1b[2m${s}\x1b[0m`);
const yellow = (s: string) => (noColor ? s : `\x1b[33m${s}\x1b[0m`);

const RUNNER_ID_PATH = path.join(os.homedir(), '.config', 'buildq', 'runner-id');
const POLL_INTERVAL_MS = 30_000;

function loadOrCreateRunnerId(): string {
  try {
    return fs.readFileSync(RUNNER_ID_PATH, 'utf-8').trim();
  } catch {
    const id = nanoid(12);
    fs.mkdirSync(path.dirname(RUNNER_ID_PATH), { recursive: true });
    fs.writeFileSync(RUNNER_ID_PATH, id);
    return id;
  }
}

function detectPackageManager(projectDir: string): string {
  if (fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(projectDir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function tailLines(text: string, n: number): string {
  const lines = text.split('\n').filter(Boolean);
  return lines.slice(-n).join('\n');
}

export const runnerCommand = new Command('runner')
  .description('Start a build runner that claims and executes jobs')
  .requiredOption('-p, --platform <platforms>', 'Comma-separated platforms: ios, android, or ios,android')
  .option('-i, --install', 'Auto-install artifact on device after build', false)
  .option('-w, --work-dir <path>', 'Working directory for builds', path.join(os.homedir(), '.buildq', 'builds'))
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};

    const config = loadConfig({
      server: globalOpts.server,
      token: globalOpts.token,
    });

    const platforms = opts.platform.split(',').map((p: string) => p.trim()) as Platform[];
    for (const p of platforms) {
      if (p !== 'ios' && p !== 'android') {
        console.error(red(`\u2717 Invalid platform: ${p}. Must be "ios" or "android".`));
        process.exit(1);
      }
    }

    // Check iOS on macOS
    if (platforms.includes('ios') && process.platform !== 'darwin') {
      console.error(red(`\u2717 iOS builds require macOS. This machine is running ${process.platform}.`));
      process.exit(1);
    }

    // Check eas-cli
    try {
      const { execSync } = await import('node:child_process');
      execSync('eas --version', { stdio: 'ignore' });
    } catch {
      console.error(red('\u2717 eas-cli is not installed. Install it with: npm install -g eas-cli'));
      process.exit(1);
    }

    const runnerId = loadOrCreateRunnerId();
    const hostname = os.hostname();
    const workDir = path.resolve(opts.workDir);

    fs.mkdirSync(workDir, { recursive: true });

    // Clean up leftover directories from previous runs
    try {
      const entries = fs.readdirSync(workDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          console.log(dim(`\u2192 Cleaning up leftover build directory: ${entry.name}`));
          fs.rmSync(path.join(workDir, entry.name), { recursive: true, force: true });
        }
      }
    } catch {}

    const api = createApiClient(config);

    console.log(`\u2192 Runner ID: ${runnerId}`);
    console.log(`\u2192 Hostname: ${hostname}`);
    console.log(`\u2192 Platforms: ${platforms.join(', ')}`);
    console.log(`\u2192 Work directory: ${workDir}`);

    // Initial heartbeat
    try {
      await api.sendHeartbeat(runnerId, hostname, platforms);
      console.log(green('\u2713 Registered with server'));
    } catch (err) {
      console.error(red(`\u2717 Failed to connect to server: ${(err as Error).message}`));
      process.exit(1);
    }

    // Heartbeat interval
    const heartbeatInterval = setInterval(async () => {
      try {
        await api.sendHeartbeat(runnerId, hostname, platforms);
      } catch {
        console.warn(yellow('\u26a0 Heartbeat failed — server may be unreachable'));
      }
    }, 30_000);

    let currentBuild: { child?: ReturnType<typeof spawn>; jobId?: string } = {};
    let shuttingDown = false;

    // Helper to send step events (fire-and-forget)
    function sendStep(jobId: string, step: string): void {
      api.pushStep(jobId, step).catch(() => {});
    }

    // Process a single job
    async function processJob(job: Job): Promise<void> {
      const jobDir = path.join(workDir, job.id);
      const projectDir = path.join(jobDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });

      // Track output across all phases for error context
      let lastOutput = '';

      console.log(`\n\u2192 Processing job ${job.id} (${job.platform}, ${job.profile})`);
      currentBuild.jobId = job.id;

      try {
        // Download tarball
        sendStep(job.id, 'downloading_tarball');
        const tarballPath = path.join(jobDir, 'source.tar.gz');
        await api.downloadTarball(job.id, tarballPath);
        console.log(dim('\u2192 Downloaded tarball'));

        // Extract
        sendStep(job.id, 'extracting');
        await tar.extract({ file: tarballPath, cwd: projectDir });
        console.log(dim('\u2192 Extracted project'));

        // Initialize a synthetic git repo so EAS build --local doesn't fail
        sendStep(job.id, 'git_init');
        {
          const { execSync } = await import('node:child_process');
          execSync('git init', { cwd: projectDir, stdio: 'ignore' });
          execSync('git add -A', { cwd: projectDir, stdio: 'ignore' });
          execSync(
            'git -c user.name="buildq" -c user.email="buildq@local" commit -m "buildq: synthetic commit for remote build"',
            { cwd: projectDir, stdio: 'ignore' },
          );
          console.log(dim('\u2192 Initialized synthetic git repo'));
        }

        // Install dependencies
        sendStep(job.id, 'installing_deps');
        const pm = detectPackageManager(projectDir);
        console.log(dim(`\u2192 Installing dependencies with ${pm}...`));
        await new Promise<void>((resolve, reject) => {
          const child = spawn(pm, ['install'], {
            cwd: projectDir,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          let logBuffer = '';
          const flushLogs = async (stream: 'stdout' | 'stderr') => {
            if (logBuffer) {
              try {
                await api.pushLogs(job.id, stream, logBuffer);
              } catch {}
              logBuffer = '';
            }
          };

          child.stdout?.on('data', (data: Buffer) => {
            const str = data.toString();
            logBuffer += str;
            lastOutput += str;
          });
          child.stderr?.on('data', (data: Buffer) => {
            const str = data.toString();
            logBuffer += str;
            lastOutput += str;
          });

          const flushInterval = setInterval(() => flushLogs('stdout'), 500);

          child.on('close', (code) => {
            clearInterval(flushInterval);
            flushLogs('stdout').then(() => {
              if (code === 0) resolve();
              else reject(new Error(`${pm} install failed with exit code ${code}`));
            });
          });
          child.on('error', (err) => {
            clearInterval(flushInterval);
            reject(err);
          });
        });

        // Update status to building
        sendStep(job.id, 'building');
        await api.updateJobStatus(job.id, 'building');
        console.log('\u2192 Build started');

        // Execute EAS build
        const buildFlags = [
          'build',
          '--local',
          '--platform', job.platform,
          '--profile', job.profile,
          '--non-interactive',
          ...job.flags,
        ];

        const exitCode = await new Promise<number>((resolve, reject) => {
          const child = spawn('eas', buildFlags, {
            cwd: projectDir,
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          currentBuild.child = child;

          let logBuffer = '';

          const flushLogs = async () => {
            if (logBuffer) {
              const toSend = logBuffer;
              logBuffer = '';
              try {
                await api.pushLogs(job.id, 'stdout', toSend);
              } catch {}
            }
          };

          child.stdout?.on('data', (data: Buffer) => {
            const str = data.toString();
            logBuffer += str;
            lastOutput += str;
            process.stdout.write(dim(str));
          });

          child.stderr?.on('data', (data: Buffer) => {
            const str = data.toString();
            logBuffer += str;
            lastOutput += str;
            process.stderr.write(str);
          });

          const flushInterval = setInterval(flushLogs, 500);

          child.on('close', (code) => {
            currentBuild.child = undefined;
            clearInterval(flushInterval);
            flushLogs().then(() => resolve(code ?? 1));
          });
          child.on('error', (err) => {
            currentBuild.child = undefined;
            clearInterval(flushInterval);
            reject(err);
          });
        });

        if (exitCode !== 0) {
          const tail = tailLines(lastOutput, 20);
          const errorMsg = tail
            ? `Build failed (exit code ${exitCode})\n${tail}`
            : `Build failed (exit code ${exitCode})`;
          await api.updateJobStatus(job.id, 'error', {
            error: errorMsg,
            exitCode,
          });
          console.log(red(`\u2717 Build failed (exit code ${exitCode})`));
          return;
        }

        // Find artifact
        sendStep(job.id, 'uploading_artifact');
        const artifactExtensions = ['.apk', '.aab', '.ipa', '.tar.gz'];
        let artifactPath: string | null = null;

        // Search recursively in project directory for recently created build artifacts
        const findArtifact = (dir: string): string | null => {
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isFile()) {
                for (const ext of artifactExtensions) {
                  if (entry.name.endsWith(ext)) {
                    return fullPath;
                  }
                }
              } else if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
                const found = findArtifact(fullPath);
                if (found) return found;
              }
            }
          } catch {}
          return null;
        };

        artifactPath = findArtifact(projectDir);

        if (artifactPath) {
          console.log(`\u2192 Uploading artifact: ${path.basename(artifactPath)}`);
          await api.uploadArtifact(job.id, artifactPath);
        }

        await api.updateJobStatus(job.id, 'success');
        console.log(green(`\u2713 Build succeeded for job ${job.id}`));

        // Auto-install
        if (opts.install && artifactPath) {
          try {
            if (job.platform === 'ios') {
              const { execSync } = await import('node:child_process');
              execSync(`xcrun simctl install booted "${artifactPath}"`, { stdio: 'inherit' });
              console.log(green('\u2713 Installed on iOS simulator'));
            } else if (job.platform === 'android') {
              const { execSync } = await import('node:child_process');
              execSync(`adb install "${artifactPath}"`, { stdio: 'inherit' });
              console.log(green('\u2713 Installed on Android device'));
            }
          } catch (err) {
            console.warn(yellow(`\u26a0 Auto-install failed: ${(err as Error).message}`));
          }
        }
      } catch (err) {
        console.error(red(`\u2717 Error processing job ${job.id}: ${(err as Error).message}`));
        const tail = tailLines(lastOutput, 20);
        const errorMsg = tail
          ? `${(err as Error).message}\n${tail}`
          : (err as Error).message;
        try {
          await api.updateJobStatus(job.id, 'error', {
            error: errorMsg,
            exitCode: 1,
          });
        } catch {}
      } finally {
        currentBuild = {};
        // Clean up work directory
        try {
          fs.rmSync(jobDir, { recursive: true, force: true });
        } catch {}
      }
    }

    // Connect to SSE for each platform and listen for jobs
    let processing = false;

    const tryClaimJob = async (platform: Platform) => {
      if (processing || shuttingDown) return;

      try {
        const result = await api.claimJob(platform, runnerId, hostname);
        if (!result) return; // 204 — someone else claimed it

        processing = true;
        await processJob(result.job);
        processing = false;

        // Re-claim: immediately try for next job after completing one
        if (!shuttingDown) {
          for (const p of platforms) {
            tryClaimJob(p);
          }
        }
      } catch (err) {
        processing = false;
        console.warn(yellow(`\u26a0 Claim attempt failed: ${(err as Error).message}`));
      }
    };

    for (const platform of platforms) {
      const conn = connectToPlatform(config.server, config.token, platform);
      conn.on('job:created', (_event: SSEEvent) => {
        tryClaimJob(platform);
      });
      console.log(`\u2192 Listening for ${platform} jobs...`);
    }

    // Also try claiming on startup in case there are queued jobs
    for (const platform of platforms) {
      tryClaimJob(platform);
    }

    // Periodic polling fallback — catches jobs missed by SSE
    const pollInterval = setInterval(() => {
      if (processing || shuttingDown) return;
      for (const platform of platforms) {
        tryClaimJob(platform);
      }
    }, POLL_INTERVAL_MS);

    // Graceful shutdown
    let forceCount = 0;
    const shutdown = async () => {
      forceCount++;
      if (forceCount >= 2) {
        console.log('\n\u2192 Force shutting down...');
        process.exit(1);
      }

      shuttingDown = true;
      console.log('\n\u2192 Shutting down gracefully...');

      if (currentBuild.child) {
        console.log('\u2192 Waiting for current build to finish...');
      }

      clearInterval(heartbeatInterval);
      clearInterval(pollInterval);

      // Wait for current build if one is running
      while (processing) {
        await new Promise((r) => setTimeout(r, 1000));
      }

      // Deregister
      try {
        const { default: fetch } = await import('node-fetch' as string).catch(() => ({ default: globalThis.fetch }));
        await api.sendHeartbeat(runnerId, hostname, []); // empty platforms signals going away
      } catch {}

      console.log(green('\u2713 Runner shut down cleanly'));
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep the process alive
    await new Promise(() => {});
  });
