import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Platform, PreflightCheck, PreflightResult } from '@buildq/shared';

const noColor = !!process.env['NO_COLOR'];
const green = (s: string) => (noColor ? s : `\x1b[32m${s}\x1b[0m`);
const red = (s: string) => (noColor ? s : `\x1b[31m${s}\x1b[0m`);
const yellow = (s: string) => (noColor ? s : `\x1b[33m${s}\x1b[0m`);
const dim = (s: string) => (noColor ? s : `\x1b[2m${s}\x1b[0m`);

/* ------------------------------------------------------------------ */
/*  Helper: run a command and capture stdout + stderr                  */
/* ------------------------------------------------------------------ */

function probe(command: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(command, args, {
    timeout: 10_000,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [result.stdout ?? '', result.stderr ?? ''].join('\n').trim();
  return { ok: result.status === 0, output };
}

/* ------------------------------------------------------------------ */
/*  Platform-specific checks                                          */
/* ------------------------------------------------------------------ */

function checkAndroid(): PreflightCheck[] {
  const checks: PreflightCheck[] = [];

  // JDK (java) — note: java -version writes to stderr
  const java = probe('java', ['-version']);
  if (java.ok) {
    const match = java.output.match(/version "([^"]+)"/);
    checks.push({ name: 'JDK (java)', status: 'pass', version: match?.[1] });
  } else {
    checks.push({
      name: 'JDK (java)',
      status: 'fail',
      message: 'java binary not found',
      fix: 'Install JDK 17+: https://adoptium.net/ or `brew install openjdk@17`',
    });
  }

  // JDK (javac)
  const javac = probe('javac', ['-version']);
  if (javac.ok) {
    const match = javac.output.match(/javac\s+([\d.]+)/);
    checks.push({ name: 'JDK (javac)', status: 'pass', version: match?.[1] });
  } else {
    checks.push({
      name: 'JDK (javac)',
      status: 'fail',
      message: 'javac not found — JRE alone is not sufficient',
      fix: 'Install full JDK (not just JRE). Ensure JAVA_HOME/bin is on PATH.',
    });
  }

  // ANDROID_HOME
  const androidHome = process.env['ANDROID_HOME'] || process.env['ANDROID_SDK_ROOT'];
  if (androidHome && fs.existsSync(androidHome)) {
    checks.push({ name: 'ANDROID_HOME', status: 'pass', version: androidHome });

    // SDK platforms
    const platformsDir = path.join(androidHome, 'platforms');
    const hasPlatforms =
      fs.existsSync(platformsDir) &&
      fs.readdirSync(platformsDir).some((e) => e.startsWith('android-'));
    checks.push({
      name: 'Android SDK platforms',
      status: hasPlatforms ? 'pass' : 'fail',
      message: hasPlatforms ? undefined : 'No Android platform SDKs installed',
      fix: hasPlatforms ? undefined : 'Run: sdkmanager "platforms;android-34"',
    });

    // build-tools
    const buildToolsDir = path.join(androidHome, 'build-tools');
    const hasBuildTools =
      fs.existsSync(buildToolsDir) && fs.readdirSync(buildToolsDir).length > 0;
    checks.push({
      name: 'Android build-tools',
      status: hasBuildTools ? 'pass' : 'fail',
      message: hasBuildTools ? undefined : 'No Android build-tools installed',
      fix: hasBuildTools ? undefined : 'Run: sdkmanager "build-tools;34.0.0"',
    });
  } else {
    const msg = androidHome
      ? `Directory does not exist: ${androidHome}`
      : 'Neither ANDROID_HOME nor ANDROID_SDK_ROOT is set';
    checks.push({
      name: 'ANDROID_HOME',
      status: 'fail',
      message: msg,
      fix: 'Set ANDROID_HOME to your Android SDK path. Install via Android Studio or sdkmanager.',
    });
    checks.push({
      name: 'Android SDK platforms',
      status: 'fail',
      message: 'Skipped — ANDROID_HOME not set',
    });
    checks.push({
      name: 'Android build-tools',
      status: 'fail',
      message: 'Skipped — ANDROID_HOME not set',
    });
  }

  return checks;
}

function checkIOS(): PreflightCheck[] {
  const checks: PreflightCheck[] = [];

  if (process.platform !== 'darwin') {
    checks.push({
      name: 'macOS',
      status: 'fail',
      message: `Running on ${process.platform}`,
      fix: 'iOS builds can only run on macOS.',
    });
    return checks; // skip remaining iOS checks
  }
  checks.push({ name: 'macOS', status: 'pass' });

  // Xcode (xcodebuild)
  const xcodebuild = probe('xcodebuild', ['-version']);
  if (xcodebuild.ok) {
    const match = xcodebuild.output.match(/Xcode\s+([\d.]+)/);
    checks.push({ name: 'Xcode', status: 'pass', version: match?.[1] });
  } else {
    const needsLicense = xcodebuild.output.toLowerCase().includes('license');
    checks.push({
      name: 'Xcode',
      status: 'fail',
      message: needsLicense ? 'Xcode license not accepted' : 'xcodebuild not found',
      fix: needsLicense
        ? 'Run: sudo xcodebuild -license accept'
        : 'Install Xcode from the App Store, then run: sudo xcode-select --switch /Applications/Xcode.app',
    });
  }

  // xcrun
  const xcrun = probe('xcrun', ['--version']);
  checks.push({
    name: 'Xcode CLT (xcrun)',
    status: xcrun.ok ? 'pass' : 'fail',
    message: xcrun.ok ? undefined : 'xcrun not found',
    fix: xcrun.ok ? undefined : 'Run: xcode-select --install',
  });

  // CocoaPods
  const pod = probe('pod', ['--version']);
  if (pod.ok) {
    checks.push({
      name: 'CocoaPods',
      status: 'pass',
      version: pod.output.trim().split('\n')[0],
    });
  } else {
    checks.push({
      name: 'CocoaPods',
      status: 'fail',
      message: 'pod command not found',
      fix: 'Install CocoaPods: sudo gem install cocoapods  or  brew install cocoapods',
    });
  }

  return checks;
}

function checkCommon(dryRun: boolean): PreflightCheck[] {
  const checks: PreflightCheck[] = [];

  // Git
  const git = probe('git', ['--version']);
  checks.push({
    name: 'Git',
    status: git.ok ? 'pass' : 'fail',
    version: git.ok ? git.output.replace('git version ', '').trim() : undefined,
    message: git.ok ? undefined : 'git not found',
    fix: git.ok ? undefined : 'Install git: https://git-scm.com/downloads',
  });

  // eas-cli (skip in dry-run)
  if (!dryRun) {
    const eas = probe('eas', ['--version']);
    checks.push({
      name: 'eas-cli',
      status: eas.ok ? 'pass' : 'fail',
      version: eas.ok ? eas.output.trim() : undefined,
      message: eas.ok ? undefined : 'eas-cli not found',
      fix: eas.ok ? undefined : 'Install eas-cli: npm install -g eas-cli',
    });
  }

  return checks;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

export interface PreflightOptions {
  platforms: Platform[];
  dryRun: boolean;
  skipPreflight: boolean;
}

export interface PreflightSummary {
  results: PreflightResult[];
  validatedPlatforms: Platform[];
  environment: Record<string, string>;
  allPassed: boolean;
}

export function runPreflight(options: PreflightOptions): PreflightSummary {
  if (options.skipPreflight) {
    return {
      results: [],
      validatedPlatforms: [...options.platforms],
      environment: {},
      allPassed: true,
    };
  }

  const results: PreflightResult[] = [];
  const environment: Record<string, string> = {};
  const commonChecks = checkCommon(options.dryRun);

  for (const platform of options.platforms) {
    const platformChecks = platform === 'android' ? checkAndroid() : checkIOS();
    const allChecks = [...commonChecks, ...platformChecks];
    const passed = allChecks.every((c) => c.status !== 'fail');

    results.push({ platform, passed, checks: allChecks });

    for (const check of allChecks) {
      if (check.version) {
        const key = check.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        environment[key] = check.version;
      }
    }
  }

  const validatedPlatforms = results.filter((r) => r.passed).map((r) => r.platform);

  return {
    results,
    validatedPlatforms,
    environment,
    allPassed: validatedPlatforms.length === options.platforms.length,
  };
}

export function printPreflightReport(summary: PreflightSummary): void {
  console.log('\n' + dim('--- Preflight Checks ---'));

  for (const result of summary.results) {
    const icon = result.passed ? green('\u2713') : red('\u2717');
    console.log(`\n${icon} ${result.platform.toUpperCase()}`);

    for (const check of result.checks) {
      const statusIcon =
        check.status === 'pass'
          ? green('  \u2713')
          : check.status === 'warn'
            ? yellow('  \u26a0')
            : red('  \u2717');
      const versionStr = check.version ? dim(` (${check.version})`) : '';
      console.log(`${statusIcon} ${check.name}${versionStr}`);
      if (check.message) {
        console.log(dim(`      ${check.message}`));
      }
      if (check.fix) {
        console.log(`      ${yellow('Fix:')} ${check.fix}`);
      }
    }
  }

  console.log(dim('\n--- End Preflight ---\n'));
}
