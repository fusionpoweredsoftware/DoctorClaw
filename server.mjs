import express from 'express';
import { execSync, exec } from 'child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

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
  openclaw_dir: '/opt/openclaw',
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

async function runSetup() {
  const configExists = existsSync(CONFIG_PATH);

  // Decide whether to run interactive setup
  if (FLAG_YES) {
    if (configExists) {
      const existing = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      console.log('  Skipping setup (-y flag), using existing config.');
      return existing;
    }
    console.log('  Skipping setup (-y flag), using defaults.');
    const cfg = { ...DEFAULTS, read_paths: [...DEFAULTS.read_paths, DEFAULTS.openclaw_dir], write_paths: [...DEFAULTS.write_paths, process.cwd(), DEFAULTS.openclaw_dir] };
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
    return cfg;
  }

  if (!FLAG_INTERACTIVE && configExists) {
    const existing = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    console.log(`  Loaded config from ${CONFIG_PATH}`);
    return existing;
  }

  // ── Interactive prompts ──
  console.log('');
  console.log('  ─────────────────────────────────');
  console.log('  🩺 DoctorClaw Setup');
  console.log('  ─────────────────────────────────');
  console.log('');
  console.log('  Press Enter to accept defaults shown in parentheses.');
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Port
  const port = parseInt(await ask(rl, 'Server port', DEFAULTS.port), 10) || DEFAULTS.port;

  // Ollama URL
  const ollamaUrl = await ask(rl, 'Ollama URL', DEFAULTS.ollama_url);

  // Detect available models
  console.log('');
  console.log('  Checking for available Ollama models...');
  const models = await detectModels(ollamaUrl);
  let model;
  if (models.length > 0) {
    console.log(`  Found ${models.length} model(s): ${models.join(', ')}`);
    model = await ask(rl, 'Model to use', models.includes(DEFAULTS.model) ? DEFAULTS.model : models[0]);
  } else {
    console.log('  Could not reach Ollama or no models found.');
    model = await ask(rl, 'Model to use', DEFAULTS.model);
  }

  // OS
  console.log('');
  const os = await ask(rl, 'Operating system (linux/macos/windows)', DEFAULTS.os);

  // OpenClaw directory
  const openclawDir = await ask(rl, 'OpenClaw directory', DEFAULTS.openclaw_dir);

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
  const readPaths = [...DEFAULTS.read_paths, openclawDir, ...extraReadPaths];
  const writePaths = [...DEFAULTS.write_paths, process.cwd(), openclawDir, ...extraWritePaths];
  // Deduplicate
  const cfg = {
    port,
    ollama_url: ollamaUrl,
    model,
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
const OPENCLAW_DIR = config.openclaw_dir || '/opt/openclaw';
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
  res.json({
    port: PORT,
    ollama_url: OLLAMA_URL,
    model: MODEL,
    openclaw_dir: OPENCLAW_DIR,
    os: OS_TYPE,
    read_paths: SAFE_READ_PATHS,
    write_paths: SAFE_WRITE_PATHS,
  });
});

app.post('/api/config', (req, res) => {
  const updates = req.body;
  try {
    let current = {};
    try { current = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); } catch {}

    if (updates.openclaw_dir !== undefined) current.openclaw_dir = updates.openclaw_dir;
    if (updates.ollama_url !== undefined) current.ollama_url = updates.ollama_url;
    if (updates.model !== undefined) current.model = updates.model;
    if (updates.port !== undefined) current.port = parseInt(updates.port, 10);
    if (updates.os !== undefined) current.os = updates.os;
    if (updates.read_paths !== undefined) current.read_paths = updates.read_paths;
    if (updates.write_paths !== undefined) current.write_paths = updates.write_paths;

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

// ── Chat (streaming) ────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are DoctorClaw, an expert system diagnostics and troubleshooting assistant. Your job is to help the user fix problems on their system — especially issues related to OpenClaw configuration and services, but also general Linux system issues.

ENVIRONMENT:
- Operating system: ${OS_TYPE}
- OpenClaw directory: ${OPENCLAW_DIR}
- Server working directory: ${process.cwd()}
- Config file location: ${CONFIG_PATH}
- Readable paths: ${SAFE_READ_PATHS.join(', ')}
- Writable paths: ${SAFE_WRITE_PATHS.join(', ')}
- The user can add more paths by editing doctorclaw.config.json (read_paths and write_paths arrays).
- IMPORTANT: There is a Settings panel in the DoctorClaw UI — the user can click the gear icon (⚙) in the top-right header to open it. The Settings panel lets the user configure: Ollama URL, model, port, OpenClaw directory, and all readable/writable paths. All changes are saved to doctorclaw.config.json automatically. Path changes take effect immediately without a restart. If a user asks how to configure paths or settings, ALWAYS direct them to the Settings panel (gear icon) first — do NOT tell them to manually edit the JSON file.

RULES:
1. You can REQUEST actions (reading files, running commands, writing files) but you CANNOT execute them yourself. The user must approve each action.
2. When you need to perform an action, output it in EXACTLY this format on its own line:
   [ACTION:READ_FILE:/path/to/file]
   [ACTION:RUN_CMD:command here]
   [ACTION:RUN_SCRIPT:/path/to/script.sh]
   [ACTION:RUN_SCRIPT:/path/to/script.sh:arg1 arg2]
   [ACTION:WRITE_FILE:/path/to/file:content here]
3. ALWAYS use absolute paths (starting with / on linux/mac, or drive letter on windows). Never use relative paths.
4. RUN_SCRIPT can execute .sh, .bash, .bat, .cmd, and .ps1 scripts from any readable directory. The correct shell is chosen automatically based on the file extension and configured OS. Use RUN_SCRIPT instead of RUN_CMD when executing existing scripts.
5. Use commands and paths appropriate for the configured operating system (${OS_TYPE}). For example, use ls on linux/mac and dir on windows.
4. Only request ONE action at a time. Wait for the result before requesting the next.
5. NEVER suggest actions that could damage the system — no destructive commands, no formatting disks, no deleting critical system files.
6. Always explain WHY you want to perform each action before requesting it.
7. When proposing a fix that writes to a file, show the user what you plan to write and explain the change.
8. Be concise, professional, and helpful. You are a doctor for systems — diagnose methodically.
9. If you are unsure, ask clarifying questions before taking action.
10. When you have enough information, provide a clear diagnosis and treatment plan.
11. If an action FAILS or is DENIED, explain to the user what went wrong in plain language, suggest an alternative approach, and continue troubleshooting. Do NOT stop or get stuck — always keep the conversation moving forward.
12. If a path is denied due to access restrictions, tell the user which paths are currently writable, and let them know they can add more paths by clicking the gear icon (⚙) in the top-right corner to open Settings.
13. Only write to paths listed in the writable paths above. If you need to write somewhere else, tell the user to add it to the config first.`;
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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
    res.end();
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
  console.log(`\n  🩺 DoctorClaw is running at http://localhost:${PORT}\n`);
  console.log(`  Ollama endpoint: ${OLLAMA_URL}`);
  console.log(`  Model: ${MODEL}`);
  console.log(`  OS: ${OS_TYPE}`);
  console.log(`  OpenClaw dir: ${OPENCLAW_DIR}`);
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

} // end boot()

boot().catch(err => {
  console.error(`\n  ❌ Startup failed: ${err.message}\n`);
  process.exit(1);
});
