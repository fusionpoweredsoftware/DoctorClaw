import express from 'express';
import { execSync, exec } from 'child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import WebSocket, { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'doctorclaw.config.json');

// ── CLI Flags ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const FLAG_YES = args.includes('-y') || args.includes('--yes');
const FLAG_INTERACTIVE = args.includes('-i') || args.includes('--interactive');

// ── Interactive Setup ────────────────────────────────────────────────────────

const DEFAULTS = {
  port: 3333,
  ollama_url: 'http://localhost:11434',
  model: 'glm-4.7:cloud',
  has_openclaw: false,
  openclaw_dir: '',
  os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
  read_paths: ['/etc/', '/var/log/', '/var/lib/', '/tmp/', '/home/', '/opt/', '/usr/local/etc/', '/proc/cpuinfo', '/proc/meminfo', '/proc/loadavg', '/proc/version', '/proc/uptime', '/proc/net/'],
  write_paths: ['/tmp/'],
};

function ask(rl, question, fallback) {
  const display = fallback !== undefined && fallback !== '' ? ` (${fallback})` : '';
  return new Promise(resolve => {
    rl.question(`  ${question}${display}: `, answer => {
      resolve(answer.trim() || (fallback !== undefined ? String(fallback) : ''));
    });
  });
}

async function detectModels(ollamaUrl) {
  try {
    const resp = await fetch(`${ollamaUrl}/api/tags`);
    if (resp.ok) {
      const data = await resp.json();
      return (data.models || []).map(m => m.name);
    }
  } catch {}
  return [];
}

// ── Ollama Installation Helpers ──────────────────────────────────────────────

const LOCAL_MODEL_DEFAULT = 'llama3.1';

function isOllamaInstalled() {
  try {
    const cmd = process.platform === 'win32' ? 'where ollama' : 'which ollama';
    execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function installOllamaCli() {
  if (process.platform === 'win32') {
    console.log('  Ollama must be installed manually on Windows.');
    console.log('  Download from: https://ollama.com/download');
    return false;
  }
  console.log('  Installing Ollama...');
  try {
    execSync('curl -fsSL https://ollama.com/install.sh | sh', {
      stdio: 'inherit',
      timeout: 120000,
    });
    console.log('');
    console.log('  ✓ Ollama installed successfully.');
    return true;
  } catch (err) {
    console.log(`  ✗ Failed to install Ollama: ${err.message}`);
    console.log('  Install manually from: https://ollama.com');
    return false;
  }
}

async function ensureOllamaRunning(ollamaUrl) {
  try {
    const resp = await fetch(`${ollamaUrl}/api/tags`);
    if (resp.ok) return true;
  } catch {}

  if (!isOllamaInstalled()) return false;

  console.log('  Ollama is installed but not running. Starting Ollama service...');
  try {
    const child = exec('ollama serve');
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
    child.unref();

    // Wait for it to come up (up to ~10s)
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const resp = await fetch(`${ollamaUrl}/api/tags`);
        if (resp.ok) {
          console.log('  ✓ Ollama service started.');
          return true;
        }
      } catch {}
    }
    console.log('  ⚠  Could not start Ollama. Please start it manually: ollama serve');
  } catch {
    console.log('  ⚠  Could not start Ollama. Please start it manually: ollama serve');
  }
  return false;
}

function getOllamaVersion() {
  try {
    const output = execSync('ollama --version', { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 }).trim();
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function getLatestOllamaVersion() {
  try {
    const resp = await fetch('https://api.github.com/repos/ollama/ollama/releases/latest', {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'DoctorClaw' },
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data = await resp.json();
      const tag = data.tag_name || '';
      const match = tag.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    }
  } catch {}
  return null;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * Check if Ollama is up-to-date. If outdated, strongly recommend updating.
 * @param {object|null} rl - readline interface for interactive mode, or null for non-interactive
 */
async function checkOllamaUpdate(rl) {
  const installed = getOllamaVersion();
  if (!installed) {
    console.log('  Could not determine installed Ollama version.');
    return;
  }
  console.log(`  Ollama version: v${installed}`);

  const latest = await getLatestOllamaVersion();
  if (!latest) {
    console.log('  Could not check for Ollama updates (network unreachable).');
    return;
  }

  if (compareVersions(installed, latest) >= 0) {
    console.log(`  ✓ Ollama is up to date (v${installed}).`);
    return;
  }

  // Outdated — strong warning
  console.log('');
  console.log(`  ⚠⚠  WARNING: Ollama is OUT OF DATE! Installed: v${installed} → Latest: v${latest}`);
  console.log('  ⚠⚠  Running an outdated version of Ollama can cause model download failures,');
  console.log('  ⚠⚠  compatibility issues, and unexpected errors during operation.');
  console.log('  ⚠⚠  Updating is STRONGLY recommended before continuing.');

  if (rl) {
    // Interactive — offer to update
    console.log('');
    const updateAnswer = await ask(rl, 'Update Ollama now? (STRONGLY recommended) (y/n)', 'y');
    if (updateAnswer.toLowerCase().startsWith('y')) {
      installOllamaCli();
    } else {
      console.log('  Continuing with outdated Ollama. You may experience issues.');
    }
  } else {
    // Non-interactive (-y flag) — warn but don't force
    console.log('');
    if (process.platform === 'win32') {
      console.log('  Update Ollama from: https://ollama.com/download');
    } else {
      console.log('  Update with: curl -fsSL https://ollama.com/install.sh | sh');
    }
  }
  console.log('');
}

/**
 * Check if a directory looks like an OpenClaw installation.
 * A directory qualifies if it has "openclaw" in its path OR contains
 * recognizable OpenClaw files (configs, binaries, etc.).
 */
function looksLikeOpenclawDir(dir) {
  if (!existsSync(dir)) return false;
  // Path itself contains "openclaw" (case-insensitive)
  if (/openclaw/i.test(dir)) return true;
  // Contains known OpenClaw config or binary files
  const markers = [
    'config.yml', 'config.yaml', 'openclaw.yml', 'openclaw.conf',
    'gateway.yml', 'gateway.conf', 'openclaw-gateway',
    'bin/openclaw-gateway', 'bin/openclaw',
  ];
  return markers.some(m => existsSync(join(dir, m)));
}

/**
 * Given an absolute binary path, walk up directories to find the
 * OpenClaw install root. E.g. /opt/openclaw/bin/openclaw-gateway → /opt/openclaw
 */
function findInstallRoot(binPath) {
  let dir = dirname(binPath);
  // Walk up at most 4 levels looking for a directory that looks like the install root
  for (let i = 0; i < 4 && dir !== '/'; i++) {
    if (looksLikeOpenclawDir(dir)) return dir;
    dir = dirname(dir);
  }
  return null;
}

/**
 * Auto-detect where OpenClaw is installed by checking common locations,
 * running processes, and PATH lookups.
 */
function detectOpenclawDir() {
  // 1. Check common installation directories
  const candidates = [
    '/opt/openclaw',
    '/usr/local/openclaw',
    '/etc/openclaw',
    '/opt/OpenClaw',
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) {
      console.log(`  Auto-detected OpenClaw directory: ${dir}`);
      return dir;
    }
  }

  // 2. Try to find a running openclaw process and derive its location
  try {
    const psOutput = execSync("ps aux 2>/dev/null | grep -i openclaw | grep -v grep", {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
    if (psOutput) {
      const lines = psOutput.split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[1];

        // Try /proc/<PID>/exe first — this is the actual binary path, most reliable
        if (pid && /^\d+$/.test(pid)) {
          try {
            const exe = execSync(`readlink /proc/${pid}/exe 2>/dev/null`, {
              encoding: 'utf-8', timeout: 3000,
            }).trim();
            if (exe) {
              const root = findInstallRoot(exe);
              if (root) {
                console.log(`  Auto-detected OpenClaw directory from process exe: ${root}`);
                return root;
              }
            }
          } catch {}
        }

        // Try the command path from ps output (field 11+)
        if (parts.length >= 11) {
          const cmd = parts[10];
          if (cmd.startsWith('/')) {
            const root = findInstallRoot(cmd);
            if (root) {
              console.log(`  Auto-detected OpenClaw directory from process command: ${root}`);
              return root;
            }
          }
        }

        // Try /proc/<PID>/cwd — but ONLY accept it if it looks like an OpenClaw dir
        // (not a generic home directory or /)
        if (pid && /^\d+$/.test(pid)) {
          try {
            const cwd = execSync(`readlink /proc/${pid}/cwd 2>/dev/null`, {
              encoding: 'utf-8', timeout: 3000,
            }).trim();
            if (cwd && looksLikeOpenclawDir(cwd)) {
              console.log(`  Auto-detected OpenClaw directory from process cwd: ${cwd}`);
              return cwd;
            }
          } catch {}
        }
      }
    }
  } catch {}

  // 3. Try which/whereis to find openclaw binaries on PATH
  try {
    const binPath = execSync('which openclaw-gateway 2>/dev/null || which openclaw 2>/dev/null', {
      encoding: 'utf-8', timeout: 3000,
    }).trim();
    if (binPath) {
      const root = findInstallRoot(binPath);
      if (root) {
        console.log(`  Auto-detected OpenClaw directory from PATH: ${root}`);
        return root;
      }
    }
  } catch {}

  // 4. Check if openclaw directories exist under home directories
  try {
    const homeHits = execSync("find /home -maxdepth 3 -name 'openclaw*' -type d 2>/dev/null | head -1", {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
    if (homeHits && looksLikeOpenclawDir(homeHits)) {
      console.log(`  Auto-detected OpenClaw directory under /home: ${homeHits}`);
      return homeHits;
    }
  } catch {}

  // 5. Fallback — nothing found
  return '/opt/openclaw';
}

/**
 * Validate that the OpenClaw directory exists and contains expected files.
 * Returns an object with validation details.
 */
function validateOpenclawDir(dir) {
  const result = { exists: false, hasConfig: false, hasLogs: false, configPath: null, logPaths: [] };
  if (!existsSync(dir)) return result;
  result.exists = true;

  // Look for common config file patterns within the directory
  const configCandidates = [
    'config.yml', 'config.yaml', 'config.json', 'config.toml',
    'openclaw.yml', 'openclaw.yaml', 'openclaw.conf', 'openclaw.json',
    'gateway.yml', 'gateway.yaml', 'gateway.conf', 'gateway.json',
    'etc/config.yml', 'etc/openclaw.yml', 'conf/openclaw.yml',
  ];
  for (const c of configCandidates) {
    const full = join(dir, c);
    if (existsSync(full)) {
      result.hasConfig = true;
      result.configPath = full;
      break;
    }
  }

  // Look for log directories/files
  const logCandidates = ['logs', 'log', 'var/log', 'var/logs'];
  for (const l of logCandidates) {
    const full = join(dir, l);
    if (existsSync(full)) {
      result.hasLogs = true;
      result.logPaths.push(full);
    }
  }

  return result;
}

async function runSetup() {
  const configExists = existsSync(CONFIG_PATH);

  // Decide whether to run interactive setup
  if (FLAG_YES) {
    // With -y, auto-install Ollama if missing and assume cloud service
    if (!isOllamaInstalled()) {
      console.log('  Ollama not found. Installing automatically (-y flag)...');
      installOllamaCli();
    } else {
      // Already installed — check if up to date (warn only, no prompt with -y)
      await checkOllamaUpdate(null);
    }

    if (configExists) {
      const existing = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      console.log('  Skipping setup (-y flag), using existing config.');
      // Only validate OpenClaw directory if user indicated they have it
      if (existing.has_openclaw !== false && existing.openclaw_dir) {
        const v = validateOpenclawDir(existing.openclaw_dir);
        if (!v.exists) {
          console.log(`  ⚠  Warning: OpenClaw directory "${existing.openclaw_dir}" does not exist.`);
          console.log('  Attempting auto-detection...');
          const detected = detectOpenclawDir();
          if (existsSync(detected)) {
            console.log(`  → Using detected directory: ${detected}`);
            existing.openclaw_dir = detected;
            // Update paths to include the detected directory
            if (existing.read_paths && !existing.read_paths.includes(detected)) existing.read_paths.push(detected);
            if (existing.write_paths && !existing.write_paths.includes(detected)) existing.write_paths.push(detected);
            writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
          } else {
            console.log('  → Could not detect OpenClaw installation. Run with -i to configure manually.');
          }
        }
      }
      return existing;
    }
    console.log('  Skipping setup (-y flag), detecting OpenClaw location...');
    const detectedDir = detectOpenclawDir();
    const v = validateOpenclawDir(detectedDir);
    const detectedOpenclaw = v.exists;
    const ocDir = detectedOpenclaw ? detectedDir : '';
    if (detectedOpenclaw) {
      console.log(`  Found OpenClaw at: ${detectedDir}`);
    } else {
      console.log('  OpenClaw not detected. Skipping OpenClaw configuration.');
      console.log('  Run with -i to configure manually if you have OpenClaw installed.');
    }
    const cfg = { ...DEFAULTS, has_openclaw: detectedOpenclaw, openclaw_dir: ocDir, read_paths: [...DEFAULTS.read_paths, ...(ocDir ? [ocDir] : [])], write_paths: [...DEFAULTS.write_paths, process.cwd(), ...(ocDir ? [ocDir] : [])] };
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
    return cfg;
  }

  if (!FLAG_INTERACTIVE && configExists) {
    const existing = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    console.log(`  Loaded config from ${CONFIG_PATH}`);
    // Only validate OpenClaw directory if user indicated they have it
    if (existing.has_openclaw !== false && existing.openclaw_dir) {
      const v = validateOpenclawDir(existing.openclaw_dir);
      if (!v.exists) {
        console.log(`  ⚠  Warning: OpenClaw directory "${existing.openclaw_dir}" does not exist.`);
        console.log('  Attempting auto-detection...');
        const detected = detectOpenclawDir();
        if (existsSync(detected)) {
          console.log(`  → Using detected directory: ${detected}`);
          existing.openclaw_dir = detected;
          if (existing.read_paths && !existing.read_paths.includes(detected)) existing.read_paths.push(detected);
          if (existing.write_paths && !existing.write_paths.includes(detected)) existing.write_paths.push(detected);
          writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
        } else {
          console.log('  → Could not detect OpenClaw installation. Run with -i to configure manually.');
        }
      }
    }
    return existing;
  }

  // ── Interactive prompts ──
  console.log('');
  console.log('  ─────────────────────────────────');
  console.log('  [+] DoctorClaw Setup');
  console.log('  ─────────────────────────────────');
  console.log('');
  console.log('  Press Enter to accept defaults shown in parentheses.');
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Check Ollama installation
  if (!isOllamaInstalled()) {
    console.log('  Ollama is not installed. DoctorClaw requires Ollama to function.');
    console.log('');
    const installAnswer = await ask(rl, 'Install Ollama now? (y/n)', 'y');
    if (installAnswer.toLowerCase().startsWith('y')) {
      installOllamaCli();
    } else {
      console.log('');
      console.log('  Ollama is required. Install from: https://ollama.com');
      console.log('  You can continue setup, but DoctorClaw will not work until Ollama is installed.');
    }
    console.log('');
  } else {
    // Already installed — check if up to date
    await checkOllamaUpdate(rl);
  }

  // Port
  const port = parseInt(await ask(rl, 'Server port', DEFAULTS.port), 10) || DEFAULTS.port;

  // Ollama URL
  const ollamaUrl = await ask(rl, 'Ollama URL', DEFAULTS.ollama_url);

  // Ask about Ollama cloud service
  console.log('');
  console.log('  Ollama can run models locally or via the cloud service.');
  console.log('  The default model (glm-4.7:cloud) requires an Ollama cloud subscription.');
  console.log('  Without cloud, models run locally on your hardware.');
  const cloudAnswer = await ask(rl, 'Do you have Ollama cloud service? (y/n)', 'n');
  const hasCloud = cloudAnswer.toLowerCase().startsWith('y');
  const defaultModel = hasCloud ? DEFAULTS.model : LOCAL_MODEL_DEFAULT;

  // Try to ensure Ollama is running for model detection
  await ensureOllamaRunning(ollamaUrl);

  // Detect available models
  console.log('');
  console.log('  Checking for available Ollama models...');
  const models = await detectModels(ollamaUrl);
  let model;
  if (models.length > 0) {
    console.log(`  Found ${models.length} model(s): ${models.join(', ')}`);
    model = await ask(rl, 'Model to use', models.includes(defaultModel) ? defaultModel : models[0]);
  } else {
    console.log('  Could not reach Ollama or no models found.');
    if (!hasCloud) {
      console.log(`  Tip: Pull a model with: ollama pull ${defaultModel}`);
    }
    model = await ask(rl, 'Model to use', defaultModel);
  }

  // OS
  console.log('');
  const os = await ask(rl, 'Operating system (linux/macos/windows)', DEFAULTS.os);

  // OpenClaw — ask if user has it before trying to detect/configure
  console.log('');
  console.log('  DoctorClaw can help troubleshoot OpenClaw installations,');
  console.log('  but it also works as a general system diagnostics tool.');
  const hasOpenclawAnswer = await ask(rl, 'Do you have OpenClaw installed? (y/n)', 'y');
  const hasOpenclaw = hasOpenclawAnswer.toLowerCase().startsWith('y');

  let openclawDir = '';
  if (hasOpenclaw) {
    // OpenClaw directory — try auto-detection first
    console.log('');
    console.log('  Detecting OpenClaw installation...');
    const detectedOcDir = detectOpenclawDir();
    const detectedValid = validateOpenclawDir(detectedOcDir);
    if (detectedValid.exists) {
      console.log(`  Found OpenClaw at: ${detectedOcDir}`);
      if (detectedValid.configPath) console.log(`  Config file: ${detectedValid.configPath}`);
      if (detectedValid.logPaths.length) console.log(`  Logs: ${detectedValid.logPaths.join(', ')}`);
    } else {
      console.log(`  Could not auto-detect OpenClaw installation.`);
    }
    openclawDir = await ask(rl, 'OpenClaw directory', detectedOcDir);
    const finalValid = openclawDir !== detectedOcDir ? validateOpenclawDir(openclawDir) : detectedValid;
    if (!finalValid.exists) {
      console.log(`  ⚠  Warning: "${openclawDir}" does not exist. You can update this later in Settings.`);
    }
  } else {
    console.log('  Skipping OpenClaw configuration. You can enable it later in Settings.');
  }

  // Paths
  console.log('');
  console.log('  Default readable paths: /etc/, /var/log/, /tmp/, /home/, /opt/, ...');
  const extraRead = await ask(rl, 'Additional readable paths (comma-separated, or Enter to skip)', '');
  const extraReadPaths = extraRead ? extraRead.split(',').map(p => p.trim()).filter(Boolean) : [];

  console.log('  Default writable paths: /tmp/');
  const extraWrite = await ask(rl, 'Additional writable paths (comma-separated, or Enter to skip)', '');
  const extraWritePaths = extraWrite ? extraWrite.split(',').map(p => p.trim()).filter(Boolean) : [];

  rl.close();

  // Build config
  const readPaths = [...DEFAULTS.read_paths, ...(openclawDir ? [openclawDir] : []), ...extraReadPaths];
  const writePaths = [...DEFAULTS.write_paths, process.cwd(), ...(openclawDir ? [openclawDir] : []), ...extraWritePaths];
  // Deduplicate
  const cfg = {
    port,
    ollama_url: ollamaUrl,
    model,
    has_openclaw: hasOpenclaw,
    openclaw_dir: openclawDir,
    os,
    read_paths: [...new Set(readPaths)],
    write_paths: [...new Set(writePaths)],
  };

  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  console.log('');
  console.log(`  ✓ Config saved to ${CONFIG_PATH}`);
  console.log('');

  return cfg;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {

const config = await runSetup();

const app = express();
const PORT = process.env.PORT || config.port || 3333;
const OLLAMA_URL = process.env.OLLAMA_URL || config.ollama_url || 'http://localhost:11434';
const MODEL = process.env.DOCTORCLAW_MODEL || config.model || 'glm-4.7:cloud';
const HAS_OPENCLAW = config.has_openclaw !== false && !!config.openclaw_dir;
const OPENCLAW_DIR = config.openclaw_dir || '';
const OS_TYPE = config.os || 'linux';
const BACKUP_DIR = join(__dirname, '.doctorclaw-backups');

// ── Safety ──────────────────────────────────────────────────────────────────

const BLOCKED_COMMANDS = [
  /rm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r|--force|--recursive).*\//i,
  /rm\s+-rf\s/i,
  /mkfs/i,
  /dd\s+if=/i,
  /chmod\s+(-R\s+)?777\s+\//i,
  /chown\s+-R\s+.*\s+\//i,
  />\s*\/dev\/sd/i,
  /:(){ :\|:& };:/,
  /shutdown/i,
  /reboot/i,
  /init\s+[06]/i,
  /systemctl\s+(poweroff|halt|reboot)/i,
  /wipefs/i,
  /fdisk/i,
  /parted/i,
  /\bformat\b.*\/(dev|disk)/i,
  /curl.*\|\s*(bash|sh|zsh)/i,
  /wget.*\|\s*(bash|sh|zsh)/i,
  /python.*-c.*import\s+os.*system/i,
  /iptables\s+-F/i,
  /ufw\s+disable/i,
  /passwd\s+root/i,
  /userdel/i,
  /groupdel/i,
  /mv\s+\/etc/i,
  /rm\s+\/etc/i,
  /truncate.*\/etc/i,
  /echo\s+.*>\s*\/etc\/(passwd|shadow|sudoers|fstab)/i,
];

const DEFAULT_READ_PATHS = [
  '/etc/', '/var/log/', '/var/lib/', '/tmp/',
  '/home/', '/opt/', '/usr/local/etc/',
  '/proc/cpuinfo', '/proc/meminfo', '/proc/loadavg',
  '/proc/version', '/proc/uptime', '/proc/net/',
];

const DEFAULT_WRITE_PATHS = [
  '/tmp/',
];

// Build live path lists from config (or defaults on first run)
let SAFE_READ_PATHS = config.read_paths || [...DEFAULT_READ_PATHS, OPENCLAW_DIR];
let SAFE_WRITE_PATHS = config.write_paths || [...DEFAULT_WRITE_PATHS, process.cwd(), OPENCLAW_DIR];

function isCommandBlocked(cmd) {
  return BLOCKED_COMMANDS.some(pattern => pattern.test(cmd));
}

function isPathReadable(filepath) {
  return SAFE_READ_PATHS.some(p => filepath.startsWith(p));
}

function isPathWritable(filepath) {
  return SAFE_WRITE_PATHS.some(p => filepath.startsWith(p));
}

function backupFile(filepath) {
  if (!existsSync(filepath)) return null;
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = filepath.replace(/\//g, '__') + `.${timestamp}.bak`;
  const backupPath = join(BACKUP_DIR, backupName);
  copyFileSync(filepath, backupPath);
  return backupPath;
}

// ── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json({ limit: '5mb' }));
const staticPath = join(__dirname, 'public');
console.log(`  Static files: ${staticPath}`);
app.use(express.static(staticPath));

// Fallback if index.html is missing
app.get('/', (_req, res) => {
  const indexPath = join(staticPath, 'index.html');
  if (existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send(`
      <h2>public/index.html not found</h2>
      <p>Expected at: <code>${indexPath}</code></p>
      <p>Make sure the <code>public/</code> folder is in the same directory as <code>server.mjs</code>.</p>
    `);
  }
});

// ── Config API ──────────────────────────────────────────────────────────────

app.get('/api/config', (_req, res) => {
  let current = {};
  try { current = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
  res.json({
    port: PORT,
    ollama_url: OLLAMA_URL,
    model: MODEL,
    has_openclaw: HAS_OPENCLAW,
    openclaw_dir: OPENCLAW_DIR,
    os: OS_TYPE,
    read_paths: SAFE_READ_PATHS,
    write_paths: SAFE_WRITE_PATHS,
    audio_enabled: !!current.audio_enabled,
    elevenlabs_api_key: current.elevenlabs_api_key || '',
    elevenlabs_voice_id: current.elevenlabs_voice_id || '',
  });
});

app.post('/api/config', (req, res) => {
  const updates = req.body;
  try {
    let current = {};
    try { current = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); } catch {}

    if (updates.has_openclaw !== undefined) current.has_openclaw = !!updates.has_openclaw;
    if (updates.openclaw_dir !== undefined) current.openclaw_dir = updates.openclaw_dir;
    if (updates.ollama_url !== undefined) current.ollama_url = updates.ollama_url;
    if (updates.model !== undefined) current.model = updates.model;
    if (updates.port !== undefined) current.port = parseInt(updates.port, 10);
    if (updates.os !== undefined) current.os = updates.os;
    if (updates.read_paths !== undefined) current.read_paths = updates.read_paths;
    if (updates.write_paths !== undefined) current.write_paths = updates.write_paths;
    if (updates.audio_enabled !== undefined) current.audio_enabled = !!updates.audio_enabled;
    if (updates.elevenlabs_api_key !== undefined) current.elevenlabs_api_key = updates.elevenlabs_api_key;
    if (updates.elevenlabs_voice_id !== undefined) current.elevenlabs_voice_id = updates.elevenlabs_voice_id;

    writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2) + '\n', 'utf-8');

    // Hot-reload paths so restart isn't needed for path changes
    if (updates.read_paths) SAFE_READ_PATHS = updates.read_paths;
    if (updates.write_paths) SAFE_WRITE_PATHS = updates.write_paths;

    const needsRestart = updates.port || updates.ollama_url || updates.model;
    const msg = needsRestart
      ? 'Config saved. Restart DoctorClaw for port/model/URL changes to take effect.'
      : 'Config saved. Path changes are active immediately.';
    res.json({ success: true, message: msg });
  } catch (err) {
    res.json({ success: false, message: 'Failed to save config: ' + err.message });
  }
});

// ── Ollama health check ─────────────────────────────────────────────────────

app.get('/api/health', async (_req, res) => {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`);
    if (resp.ok) {
      const data = await resp.json();
      const models = (data.models || []).map(m => m.name);
      res.json({ status: 'ok', models, configured_model: MODEL });
    } else {
      res.json({ status: 'error', message: 'Ollama responded with an error' });
    }
  } catch {
    res.json({ status: 'error', message: 'Cannot reach Ollama at ' + OLLAMA_URL });
  }
});

// ── ElevenLabs TTS Proxy ─────────────────────────────────────────────────────

app.post('/api/tts', async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No text provided' });
  }

  let current = {};
  try { current = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); } catch {}

  const apiKey = current.elevenlabs_api_key;
  const voiceId = current.elevenlabs_voice_id || '21m00Tcm4TlvDq8ikWAM';

  if (!apiKey) {
    return res.status(400).json({ error: 'ElevenLabs API key not configured' });
  }

  try {
    const ttsResp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: text.trim(),
        model_id: 'eleven_monolingual_v1',
        voice_settings: { stability: 0.5, similarity_boost: 0.5 },
      }),
    });

    if (!ttsResp.ok) {
      const errText = await ttsResp.text();
      return res.status(ttsResp.status).json({ error: errText });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    const buffer = await ttsResp.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: 'TTS request failed: ' + err.message });
  }
});

// ── ElevenLabs STT Proxy (Scribe) ────────────────────────────────────────────

app.post('/api/stt', async (req, res) => {
  const { audio, mimeType } = req.body;
  if (!audio) {
    return res.status(400).json({ error: 'No audio data provided' });
  }

  let current = {};
  try { current = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); } catch {}

  const apiKey = current.elevenlabs_api_key;
  if (!apiKey) {
    return res.status(400).json({ error: 'ElevenLabs API key not configured' });
  }

  try {
    const audioBuffer = Buffer.from(audio, 'base64');
    const ext = (mimeType || '').includes('ogg') ? 'ogg' : (mimeType || '').includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob([audioBuffer], { type: mimeType || 'audio/webm' });

    const formData = new FormData();
    formData.append('file', blob, `recording.${ext}`);
    formData.append('model_id', 'scribe_v2');

    const sttResp = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: formData,
    });

    if (!sttResp.ok) {
      const errText = await sttResp.text();
      return res.status(sttResp.status).json({ error: errText });
    }

    const result = await sttResp.json();
    res.json({ text: result.text || '' });
  } catch (err) {
    res.status(500).json({ error: 'STT request failed: ' + err.message });
  }
});

// ── Chat (streaming) ────────────────────────────────────────────────────────

function buildSystemPrompt() {
  const openclawContext = HAS_OPENCLAW
    ? `Your job is to help the user fix problems on their system — especially issues related to OpenClaw configuration and services, but also general Linux system issues.`
    : `Your job is to help the user fix problems on their system — general Linux system diagnostics and troubleshooting.`;
  const openclawEnv = HAS_OPENCLAW ? `\n- OpenClaw directory: ${OPENCLAW_DIR}` : '';
  return `You are DoctorClaw, an expert system diagnostics and troubleshooting assistant. ${openclawContext}

ENVIRONMENT:
- Operating system: ${OS_TYPE}${openclawEnv}
- Server working directory: ${process.cwd()}
- Config file location: ${CONFIG_PATH}
- Readable paths: ${SAFE_READ_PATHS.join(', ')}
- Writable paths: ${SAFE_WRITE_PATHS.join(', ')}
- The user can add more paths by editing doctorclaw.config.json (read_paths and write_paths arrays).
- IMPORTANT: There is a Settings panel in the DoctorClaw UI — the user can click the gear icon (⚙) in the top-right header to open it. The Settings panel lets the user configure: Ollama URL, model, port, OpenClaw directory, and all readable/writable paths. All changes are saved to doctorclaw.config.json automatically. Path changes take effect immediately without a restart. If a user asks how to configure paths or settings, ALWAYS direct them to the Settings panel (gear icon) first — do NOT tell them to manually edit the JSON file.

RULES:
1. You can REQUEST actions (reading files, running commands, writing files) but you CANNOT execute them yourself. The user must approve each action.
2. When you need to perform an action, output it in EXACTLY this format on its own line:
   [ACTION:READ_FILE:/path/to/file[/ACTION]
   [ACTION:RUN_CMD:command here[/ACTION]
   [ACTION:RUN_SCRIPT:/path/to/script.sh[/ACTION]
   [ACTION:RUN_SCRIPT:/path/to/script.sh:arg1 arg2[/ACTION]
   [ACTION:WRITE_FILE:/path/to/file:content here[/ACTION]
3. ALWAYS use absolute paths (starting with / on linux/mac, or drive letter on windows). Never use relative paths.
4. RUN_SCRIPT can execute .sh, .bash, .bat, .cmd, and .ps1 scripts from any readable directory. The correct shell is chosen automatically based on the file extension and configured OS. Use RUN_SCRIPT instead of RUN_CMD when executing existing scripts.
5. Use commands and paths appropriate for the configured operating system (${OS_TYPE}). For example, use ls on linux/mac and dir on windows.
6. Only request ONE action at a time. Wait for the result before requesting the next.
7. NEVER suggest actions that could damage the system — no destructive commands, no formatting disks, no deleting critical system files.
8. Always explain WHY you want to perform each action before requesting it.
9. When proposing a fix that writes to a file, show the user what you plan to write and explain the change.
10. Be concise, professional, and helpful. You are a doctor for systems — diagnose methodically.
11. If you are unsure, ask clarifying questions before taking action.
12. When you have enough information, provide a clear diagnosis and treatment plan.
13. If an action FAILS or is DENIED, explain to the user what went wrong in plain language, suggest an alternative approach, and continue troubleshooting. Do NOT stop or get stuck — always keep the conversation moving forward.
14. If a path is denied due to access restrictions, tell the user which paths are currently writable, and let them know they can add more paths by clicking the gear icon (⚙) in the top-right corner to open Settings.
15. Only write to paths listed in the writable paths above. If you need to write somewhere else, tell the user to add it to the config first.
16. If the user sends a casual greeting (like "hi", "hello", "hey", etc.) or a non-technical message, respond warmly and briefly. Introduce yourself as DoctorClaw, a system diagnostics assistant, and ask how you can help. Do NOT ignore greetings or return an empty response.`;
}

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  const ollamaMessages = [
    { role: 'system', content: buildSystemPrompt() },
    ...messages,
  ];

  try {
    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: ollamaMessages,
        stream: true,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(502).json({ error: 'Ollama error', detail: errText });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let clientClosed = false;

    req.on('close', () => { clientClosed = true; reader.cancel().catch(() => {}); });

    while (true) {
      const { done, value } = await reader.read();
      if (done || clientClosed) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          res.write(`data: ${JSON.stringify(parsed)}\n\n`);
          if (parsed.done) {
            res.write('data: [DONE]\n\n');
          }
        } catch { /* skip malformed */ }
      }
    }
    if (!clientClosed) res.end();
  } catch (err) {
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

// ── Action execution ────────────────────────────────────────────────────────

app.post('/api/execute', (req, res) => {
  let { type, target, content } = req.body;

  // Resolve relative paths to absolute (only for file-based actions)
  if (type !== 'RUN_CMD' && target && !target.startsWith('/')) {
    target = join(process.cwd(), target);
  }

  try {
    switch (type) {
      case 'READ_FILE': {
        if (!isPathReadable(target)) {
          return res.json({ success: false, result: `Access denied: "${target}" is outside allowed read paths.` });
        }
        if (!existsSync(target)) {
          return res.json({ success: false, result: `File not found: ${target}` });
        }
        const data = readFileSync(target, 'utf-8');
        return res.json({ success: true, result: data });
      }

      case 'RUN_CMD': {
        if (isCommandBlocked(target)) {
          return res.json({ success: false, result: `Blocked: "${target}" matches a dangerous command pattern. DoctorClaw refuses to run it.` });
        }
        try {
          const output = execSync(target, {
            timeout: 30000,
            maxBuffer: 1024 * 1024,
            encoding: 'utf-8',
          });
          return res.json({ success: true, result: output || '(no output)' });
        } catch (execErr) {
          return res.json({
            success: false,
            result: execErr.stderr || execErr.stdout || execErr.message,
          });
        }
      }

      case 'RUN_SCRIPT': {
        // target = path to script, content = optional arguments
        if (!isPathReadable(target)) {
          return res.json({ success: false, result: `Access denied: "${target}" is outside allowed read paths.` });
        }
        if (!existsSync(target)) {
          return res.json({ success: false, result: `Script not found: ${target}` });
        }
        // Determine shell based on OS and file extension
        let shell;
        const ext = target.split('.').pop().toLowerCase();
        if (['bat', 'cmd', 'ps1'].includes(ext)) {
          if (ext === 'ps1') shell = `powershell -ExecutionPolicy Bypass -File "${target}"`;
          else shell = `cmd /c "${target}"`;
        } else {
          shell = `bash "${target}"`;
        }
        const fullCmd = content ? `${shell} ${content}` : shell;
        if (isCommandBlocked(fullCmd)) {
          return res.json({ success: false, result: `Blocked: script execution matches a dangerous command pattern.` });
        }
        try {
          const output = execSync(fullCmd, {
            timeout: 60000,
            maxBuffer: 1024 * 1024 * 2,
            encoding: 'utf-8',
            cwd: dirname(target),
          });
          return res.json({ success: true, result: output || '(no output)' });
        } catch (execErr) {
          return res.json({
            success: false,
            result: execErr.stderr || execErr.stdout || execErr.message,
          });
        }
      }

      case 'WRITE_FILE': {
        if (!isPathWritable(target)) {
          return res.json({ success: false, result: `Access denied: "${target}" is outside allowed write paths.` });
        }
        const dir = dirname(target);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const backup = backupFile(target);
        writeFileSync(target, content, 'utf-8');
        const msg = backup
          ? `File written. Backup saved to: ${backup}`
          : `File created at: ${target}`;
        return res.json({ success: true, result: msg });
      }

      default:
        return res.json({ success: false, result: `Unknown action type: ${type}` });
    }
  } catch (err) {
    res.json({ success: false, result: `Error: ${err.message}` });
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`\n  [+] DoctorClaw is running at http://localhost:${PORT}\n`);
  console.log(`  Ollama endpoint: ${OLLAMA_URL}`);
  console.log(`  Model: ${MODEL}`);
  console.log(`  OS: ${OS_TYPE}`);
  console.log(`  OpenClaw: ${HAS_OPENCLAW ? OPENCLAW_DIR : '(not configured)'}`);
  console.log(`  Config: ${CONFIG_PATH}`);
  console.log(`\n  Tip: Run with -i to reconfigure, or -y to skip setup.\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ❌ Port ${PORT} is already in use.`);
    console.error(`  Try: PORT=4000 npm start\n`);
  } else {
    console.error(`\n  ❌ Server error: ${err.message}\n`);
  }
  process.exit(1);
});

// ── WebSocket: Realtime STT Proxy (ElevenLabs Scribe v2 Realtime) ────────────

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/ws/stt') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (clientWs) => {
  let current = {};
  try { current = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
  const apiKey = current.elevenlabs_api_key;

  if (!apiKey) {
    clientWs.send(JSON.stringify({ error: 'ElevenLabs API key not configured' }));
    clientWs.close();
    return;
  }

  const elevenWs = new WebSocket(
    'wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&language_code=en&sample_rate=16000',
    { headers: { 'xi-api-key': apiKey } }
  );

  let elevenReady = false;

  elevenWs.on('open', () => {
    elevenReady = true;
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'ready' }));
    }
  });

  elevenWs.on('message', (data) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data.toString());
    }
  });

  elevenWs.on('error', (err) => {
    console.warn('ElevenLabs STT WebSocket error:', err.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ error: 'ElevenLabs connection error' }));
    }
    try { clientWs.close(); } catch {}
  });

  elevenWs.on('close', () => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  clientWs.on('message', (data) => {
    if (elevenReady && elevenWs.readyState === WebSocket.OPEN) {
      elevenWs.send(data.toString());
    }
  });

  clientWs.on('close', () => {
    if (elevenWs.readyState === WebSocket.OPEN) elevenWs.close();
  });

  clientWs.on('error', () => {
    if (elevenWs.readyState === WebSocket.OPEN) elevenWs.close();
  });
});

} // end boot()

boot().catch(err => {
  console.error(`\n  ❌ Startup failed: ${err.message}\n`);
  process.exit(1);
});
