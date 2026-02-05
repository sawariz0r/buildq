#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { buildCommand } from './commands/build.js';
import { runnerCommand } from './commands/runner.js';
import { statusCommand } from './commands/status.js';
import { cancelCommand } from './commands/cancel.js';

const program = new Command();

program
  .name('buildq')
  .description('Self-hosted distributed build queue for Expo/EAS local builds')
  .version('0.0.1')
  .option('--server <url>', 'Build queue server URL')
  .option('--token <token>', 'Auth token');

program.addCommand(initCommand);
program.addCommand(buildCommand);
program.addCommand(runnerCommand);
program.addCommand(statusCommand);
program.addCommand(cancelCommand);

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof Error) {
    const noColor = !!process.env['NO_COLOR'];
    const prefix = noColor ? 'Error:' : '\x1b[31mError:\x1b[0m';
    console.error(`${prefix} ${err.message}`);
  }
  process.exit(1);
});
