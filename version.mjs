import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = join(__dirname, 'package.json');

/**
 * Read the current version from package.json.
 * @returns {string} The current version string (e.g. "1.0.0")
 */
export function getVersion() {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
  return pkg.version;
}

/**
 * Bump the version in package.json and optionally create a git tag.
 * @param {'major'|'minor'|'patch'} part - Which part of semver to bump
 * @param {object} [options]
 * @param {boolean} [options.tag=false] - Create a git tag after bumping
 * @returns {string} The new version string
 */
export function bumpVersion(part, options = {}) {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
  const [major, minor, patch] = pkg.version.split('.').map(Number);

  let newVersion;
  switch (part) {
    case 'major':
      newVersion = `${major + 1}.0.0`;
      break;
    case 'minor':
      newVersion = `${major}.${minor + 1}.0`;
      break;
    case 'patch':
      newVersion = `${major}.${minor}.${patch + 1}`;
      break;
    default:
      throw new Error(`Invalid version part: "${part}". Use "major", "minor", or "patch".`);
  }

  pkg.version = newVersion;
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  console.log(`Version bumped: ${major}.${minor}.${patch} → ${newVersion}`);

  if (options.tag) {
    try {
      execSync(`git add package.json`, { stdio: 'pipe' });
      execSync(`git commit -m "chore: bump version to ${newVersion}"`, { stdio: 'pipe' });
      execSync(`git tag v${newVersion}`, { stdio: 'pipe' });
      console.log(`Git tag created: v${newVersion}`);
    } catch (err) {
      console.warn(`Warning: Git operations failed — ${err.message}`);
      console.warn('Version updated in package.json, but git tag was not created.');
    }
  }

  return newVersion;
}

// ── CLI usage ────────────────────────────────────────────────────────────────
// Run directly: node version.mjs [major|minor|patch] [--tag]

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const args = process.argv.slice(2);
  const part = args.find(a => ['major', 'minor', 'patch'].includes(a));
  const tag = args.includes('--tag');

  if (!part) {
    console.log(`DoctorClaw v${getVersion()}`);
    console.log('');
    console.log('Usage: node version.mjs <major|minor|patch> [--tag]');
    console.log('');
    console.log('  major   Bump major version (1.0.0 → 2.0.0)');
    console.log('  minor   Bump minor version (1.0.0 → 1.1.0)');
    console.log('  patch   Bump patch version (1.0.0 → 1.0.1)');
    console.log('  --tag   Also create a git commit + tag');
  } else {
    bumpVersion(part, { tag });
  }
}
