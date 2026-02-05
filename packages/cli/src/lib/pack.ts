import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { nanoid } from 'nanoid';
import * as tar from 'tar';

const MAX_SIZE_WARN = 100 * 1024 * 1024;  // 100 MB
const MAX_SIZE_ABORT = 500 * 1024 * 1024; // 500 MB

/** Hardcoded directory/file exclusions */
const HARDCODED_EXCLUSIONS = [
  'node_modules/',
  '.git/',
  'ios/',
  'android/',
  '.expo/',
  'dist/',
  'build/',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
  '.env',
  '.env.*',
  '*.p12',
  '*.mobileprovision',
  '*.keystore',
  '*.jks',
  '*.pem',
  '*.key',
];

/** Secret patterns that are always excluded regardless of any config */
const SECRET_PATTERNS = [
  '.env*',
  '*.p12',
  '*.mobileprovision',
  '*.keystore',
  '*.jks',
  '*.pem',
  '*.key',
  'credentials.json',
  'serviceAccount.json',
  'service-account*.json',
  'google-services.json',
  'GoogleService-Info.plist',
];

/**
 * Convert a .gitignore-style pattern into a RegExp that matches against
 * relative file paths (using forward slashes).
 */
function patternToRegExp(pattern: string): RegExp {
  // Trim whitespace and skip empty lines/comments
  pattern = pattern.trim();

  // Handle directory patterns (trailing /)
  const isDir = pattern.endsWith('/');
  if (isDir) {
    pattern = pattern.slice(0, -1);
  }

  // Escape regex special characters except * and ?
  let regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  // Convert glob wildcards
  regexStr = regexStr.replace(/\*\*/g, '{{GLOBSTAR}}');
  regexStr = regexStr.replace(/\*/g, '[^/]*');
  regexStr = regexStr.replace(/\?/g, '[^/]');
  regexStr = regexStr.replace(/\{\{GLOBSTAR\}\}/g, '.*');

  if (isDir) {
    // Match the directory itself or anything inside it
    return new RegExp(`(^|/)${regexStr}(/|$)`);
  }

  // If pattern contains a slash, it's anchored to the root
  if (pattern.includes('/')) {
    return new RegExp(`^${regexStr}$`);
  }

  // Otherwise, match anywhere in the path
  return new RegExp(`(^|/)${regexStr}$`);
}

/**
 * Read a file of ignore patterns (like .gitignore or .buildqignore).
 * Returns an array of non-empty, non-comment lines.
 */
function readIgnoreFile(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Recursively collect all file paths relative to the given root directory.
 */
function collectFiles(rootDir: string, currentDir: string = ''): string[] {
  const absoluteDir = currentDir ? path.join(rootDir, currentDir) : rootDir;
  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = currentDir ? `${currentDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files.push(...collectFiles(rootDir, relativePath));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(relativePath);
    }
  }

  return files;
}

/**
 * Pack the project directory into a .tar.gz tarball, excluding build artifacts,
 * dependencies, secrets, and user-configured ignore patterns.
 *
 * Returns the path to the created tarball and its size in bytes.
 */
export async function packProject(
  projectDir: string,
): Promise<{ tarballPath: string; sizeBytes: number }> {
  const resolvedDir = path.resolve(projectDir);

  // Gather all exclusion patterns
  const allPatterns = [...HARDCODED_EXCLUSIONS];

  // Read .gitignore if it exists
  const gitignorePatterns = readIgnoreFile(path.join(resolvedDir, '.gitignore'));
  allPatterns.push(...gitignorePatterns);

  // Read .buildqignore if it exists
  const buildqignorePatterns = readIgnoreFile(path.join(resolvedDir, '.buildqignore'));
  allPatterns.push(...buildqignorePatterns);

  // Always add secret patterns
  allPatterns.push(...SECRET_PATTERNS);

  // Deduplicate
  const uniquePatterns = [...new Set(allPatterns)];

  // Compile patterns to regexes
  const regexes = uniquePatterns.map(patternToRegExp);

  // Collect all files
  const allFiles = collectFiles(resolvedDir);

  // Filter files against exclusion patterns
  const includedFiles: string[] = [];
  const excludedSecrets: string[] = [];

  const secretRegexes = SECRET_PATTERNS.map(patternToRegExp);

  for (const file of allFiles) {
    const isExcluded = regexes.some((re) => re.test(file));
    if (isExcluded) {
      // Check if it was specifically a secret pattern match
      const isSecret = secretRegexes.some((re) => re.test(file));
      if (isSecret) {
        excludedSecrets.push(file);
      }
      continue;
    }
    includedFiles.push(file);
  }

  // Warn about excluded secrets
  if (excludedSecrets.length > 0) {
    console.warn(
      `[buildq] Excluded ${excludedSecrets.length} file(s) matching secret patterns:`,
    );
    for (const secret of excludedSecrets) {
      console.warn(`  - ${secret}`);
    }
  }

  if (includedFiles.length === 0) {
    throw new Error('No files to pack after applying exclusion filters.');
  }

  // Generate unique tarball filename
  const tarballName = `buildq-${nanoid(12)}.tar.gz`;
  const tarballPath = path.join(os.tmpdir(), tarballName);

  // Create the tarball
  await tar.create(
    {
      gzip: true,
      cwd: resolvedDir,
      file: tarballPath,
    },
    includedFiles,
  );

  // Check size
  const stat = fs.statSync(tarballPath);
  const sizeBytes = stat.size;

  if (sizeBytes > MAX_SIZE_ABORT) {
    // Clean up the tarball
    fs.unlinkSync(tarballPath);
    throw new Error(
      `Tarball size (${(sizeBytes / 1024 / 1024).toFixed(1)} MB) exceeds the 500 MB limit. ` +
      'Add patterns to .buildqignore to reduce the archive size.',
    );
  }

  if (sizeBytes > MAX_SIZE_WARN) {
    console.warn(
      `[buildq] Warning: tarball is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB. ` +
      'Consider adding patterns to .buildqignore to reduce upload size.',
    );
  }

  return { tarballPath, sizeBytes };
}
