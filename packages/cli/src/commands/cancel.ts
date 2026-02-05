import { Command } from 'commander';
import { loadConfig } from '../lib/config.js';
import { createApiClient, ApiError } from '../lib/api.js';

const noColor = !!process.env['NO_COLOR'];
const green = (s: string) => (noColor ? s : `\x1b[32m${s}\x1b[0m`);
const red = (s: string) => (noColor ? s : `\x1b[31m${s}\x1b[0m`);

export const cancelCommand = new Command('cancel')
  .description('Cancel a queued or in-progress build job')
  .argument('[jobId]', 'Job ID to cancel')
  .option('--latest', 'Cancel the most recent non-terminal job')
  .action(async (jobId: string | undefined, opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};

    const config = loadConfig({
      server: globalOpts.server,
      token: globalOpts.token,
    });

    const api = createApiClient(config);

    if (!jobId && !opts.latest) {
      console.error(red('\u2717 Provide a job ID or use --latest'));
      process.exit(1);
    }

    // Find job ID if --latest
    if (opts.latest) {
      try {
        const { jobs } = await api.listJobs();
        const active = jobs.find(
          (j) => j.status === 'queued' || j.status === 'claimed' || j.status === 'building',
        );
        if (!active) {
          console.log('\u2192 No active jobs to cancel');
          return;
        }
        jobId = active.id;
        console.log(`\u2192 Found active job: ${active.id} (${active.platform}, ${active.status})`);
      } catch (err) {
        console.error(red(`\u2717 Failed to list jobs: ${(err as Error).message}`));
        process.exit(1);
      }
    }

    try {
      await api.cancelJob(jobId!);
      console.log(green(`\u2713 Job ${jobId} cancelled`));
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 404) {
          console.error(red(`\u2717 Job ${jobId} not found`));
        } else if (err.statusCode === 409) {
          console.error(red(`\u2717 Job ${jobId} cannot be cancelled: ${err.body.error}`));
        } else {
          console.error(red(`\u2717 ${err.message}`));
        }
      } else {
        console.error(red(`\u2717 ${(err as Error).message}`));
      }
      process.exit(1);
    }
  });
