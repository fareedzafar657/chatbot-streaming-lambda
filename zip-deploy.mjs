// zip-deploy.mjs — Works on Windows with no extra tools needed
// Usage: node zip-deploy.mjs

import { execSync } from 'child_process';
import { createWriteStream, createReadStream, statSync, readdirSync, existsSync, rmSync } from 'fs';
import { join, relative } from 'path';
import { createGzip } from 'zlib';

const FUNCTION_NAME = 'node-streaming-test';
const REGION = 'us-east-1';
const ZIP_FILE = 'function.zip';

// ─── Simple zip implementation using archiver ─────────────────────────────────
// First install archiver if not present
console.log('==> Checking archiver dependency...');
try {
  await import('archiver');
} catch {
  console.log('==> Installing archiver (one-time)...');
  execSync('npm install archiver --no-save', { stdio: 'inherit' });
}

const archiver = (await import('archiver')).default;

// ─── Install production deps ──────────────────────────────────────────────────
console.log('==> Installing production dependencies...');
execSync('npm install --omit=dev', { stdio: 'inherit' });

// ─── Create zip ───────────────────────────────────────────────────────────────
console.log('==> Creating zip...');

await new Promise((resolve, reject) => {
  const output = createWriteStream(ZIP_FILE);
  const archive = archiver('zip', { zlib: { level: 6 } });

  output.on('close', resolve);
  archive.on('error', reject);
  archive.pipe(output);

  // Add src/ folder
  archive.directory('src/', 'src');
  // Add node_modules/ folder
  archive.directory('node_modules/', 'node_modules');
  // Add package.json at root
  archive.file('package.json', { name: 'package.json' });

  archive.finalize();
});

const sizeMB = (statSync(ZIP_FILE).size / 1024 / 1024).toFixed(2);
console.log(`==> Zip size: ${sizeMB} MB`);

// ─── Deploy to Lambda ─────────────────────────────────────────────────────────
console.log(`==> Deploying to Lambda: ${FUNCTION_NAME}...`);
try {
  execSync(
    `aws lambda update-function-code --function-name ${FUNCTION_NAME} --zip-file fileb://${ZIP_FILE} --region ${REGION}`,
    { stdio: 'inherit' }
  );
  console.log('==> Deploy successful!');
} catch {
  console.error('==> Deploy failed!');
  process.exit(1);
} finally {
  // Clean up zip
  if (existsSync(ZIP_FILE)) rmSync(ZIP_FILE);
}

console.log('==> Done!');
