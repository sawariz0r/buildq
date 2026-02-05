import { Command } from 'commander';
import { loadConfig } from '../lib/config.js';
import { createApiClient, ApiError } from '../lib/api.js';
import type { Job } from '@buildq/shared';

const noColor = !!process.env['NO_COLOR'];
const green = (s: string) => (noColor ? s : `\x1b[32m${s}\x1b[0m`);
const red = (s: string) => (noColor ? s : `\x1b[31m${s}\x1b[0m`);
const dim = (s: string) => (noColor ? s : `\x1b[2m${s}\x1b[0m`);
const bold = (s: string) => (noColor ? s : `\x1b[1m${s}\x1b[0m`);
const yellow = (s: string) => (noColor ? s : `\x1b[33m${s}\x1b[0m`);

function relativeTime(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function elapsed(startMs: number): string {
  const seconds = Math.floor((Date.now() - startMs) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function statusIcon(status: string): string {
  switch (status) {
    case 'success':
      return green('\u2713');
    case 'error':
      return red('\u2717');
    case 'cancelled':
      return yellow('\u2717');
    case 'building':
    case 'claimed':
      return '\u2022';
    default:
      return '\u2022';
  }
}

export const statusCommand = new Command('status')
  .description('Show build queue status and active runners')
  .action(async (_opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};

    const config = loadConfig({
      server: globalOpts.server,
      token: globalOpts.token,
    });

    const api = createApiClient(config);

    let jobsResponse: { jobs: Job[]; stats: { queued: number; building: number; completed: number } };
    let runnersResponse: { runners: Array<{ id: string; hostname: string; platforms: string[]; lastHeartbeat: number; active: boolean }> };

    try {
      [jobsResponse, runnersResponse] = await Promise.all([
        api.listJobs({ limit: 20 }),
        api.listRunners() as Promise<typeof runnersResponse>,
      ]);
    } catch (err) {
      if (err instanceof ApiError) {
        console.error(red(`\u2717 Cannot reach server at ${config.server}`));
        console.error('  Check your server URL and network connection.');
      } else {
        console.error(red(`\u2717 Cannot reach server at ${config.server}`));
        console.error(`  ${(err as Error).message}`);
      }
      process.exit(1);
    }

    console.log(bold('Build Queue Status'));
    console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');

    // Runners section
    console.log(`\n${bold('Runners')}`);
    if (runnersResponse.runners.length === 0) {
      console.log('  No runners registered');
    } else {
      for (const runner of runnersResponse.runners) {
        const icon = runner.active ? green('\u2713') : red('\u2717');
        const staleLabel = runner.active ? '' : ' \u2014 stale';
        console.log(
          `  ${icon} ${runner.hostname} (${runner.platforms.join(', ')}) \u2014 last seen ${relativeTime(runner.lastHeartbeat)}${staleLabel}`,
        );
      }
    }

    // Queue summary
    console.log(
      `\n${bold('Queue:')} ${jobsResponse.stats.queued} queued, ${jobsResponse.stats.building} building, ${jobsResponse.stats.completed} completed`,
    );

    // Active builds
    const activeJobs = jobsResponse.jobs.filter(
      (j) => j.status === 'claimed' || j.status === 'building',
    );
    console.log(`\n${bold('Active Builds')}`);
    if (activeJobs.length === 0) {
      console.log('  No active builds');
    } else {
      for (const job of activeJobs) {
        const runner = job.claimedBy || '?';
        console.log(
          `  \u2022 ${job.id}  ${job.platform.padEnd(8)} ${job.profile.padEnd(14)} ${job.status.padEnd(10)} (${runner}, ${elapsed(job.updatedAt)})`,
        );
      }
    }

    // Recent completed jobs
    const recentJobs = jobsResponse.jobs
      .filter((j) => j.status === 'success' || j.status === 'error' || j.status === 'cancelled')
      .slice(0, 10);

    console.log(`\n${bold('Recent Jobs')}`);
    if (recentJobs.length === 0) {
      console.log('  No recent jobs');
    } else {
      for (const job of recentJobs) {
        console.log(
          `  ${statusIcon(job.status)} ${job.id}  ${job.platform.padEnd(8)} ${job.profile.padEnd(14)} ${job.status.padEnd(10)} ${relativeTime(job.updatedAt)}`,
        );
      }
    }

    console.log('');
  });
