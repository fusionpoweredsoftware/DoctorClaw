import { createInterface } from 'readline';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

// ── ANSI Colors ──────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  // Foreground
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  // Background
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
};

// ── Terminal UI ──────────────────────────────────────────────────────────────

export async function runTerminalMode(ctx) {
  const {
    OLLAMA_URL, MODEL, CONFIG_PATH, OS_TYPE, HAS_OPENCLAW, OPENCLAW_DIR,
    SAFE_READ_PATHS, SAFE_WRITE_PATHS, BACKUP_DIR,
    buildSystemPrompt, isCommandBlocked, isPathReadable, isPathWritable, backupFile,
  } = ctx;

  let conversation = [];

  // ── Header ──

  console.log('');
  console.log(`  ${C.cyan}${C.bold}  DoctorClaw${C.reset}  ${C.dim}Terminal Mode${C.reset}`);
  console.log(`  ${C.dim}${'─'.repeat(50)}${C.reset}`);

  // Health check
  let ollamaOk = false;
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`);
    if (resp.ok) {
      ollamaOk = true;
      console.log(`  ${C.green}●${C.reset} Connected to Ollama at ${C.dim}${OLLAMA_URL}${C.reset}`);
    }
  } catch {}
  if (!ollamaOk) {
    console.log(`  ${C.red}●${C.reset} Cannot reach Ollama at ${C.dim}${OLLAMA_URL}${C.reset}`);
    console.log(`  ${C.yellow}  Make sure Ollama is running: ollama serve${C.reset}`);
  }

  console.log(`  ${C.dim}Model: ${MODEL}  |  OS: ${OS_TYPE}${HAS_OPENCLAW ? '  |  OpenClaw: ' + OPENCLAW_DIR : ''}${C.reset}`);
  console.log(`  ${C.dim}${'─'.repeat(50)}${C.reset}`);
  console.log('');
  console.log(`  ${C.dim}Describe the issue you're experiencing.${C.reset}`);
  console.log(`  ${C.dim}Actions require your explicit approval before execution.${C.reset}`);
  console.log(`  ${C.dim}Commands: /new (new session) /clear (clear screen) /quit (exit)${C.reset}`);
  console.log('');

  // ── Action execution (mirrors server.mjs /api/execute) ──

  function executeAction(type, target, content) {
    // Resolve relative paths for file-based actions
    if (type !== 'RUN_CMD' && target && !target.startsWith('/')) {
      target = join(process.cwd(), target);
    }

    try {
      switch (type) {
        case 'READ_FILE': {
          if (!isPathReadable(target)) {
            return { success: false, result: `Access denied: "${target}" is outside allowed read paths.` };
          }
          if (!existsSync(target)) {
            return { success: false, result: `File not found: ${target}` };
          }
          const data = readFileSync(target, 'utf-8');
          return { success: true, result: data };
        }

        case 'RUN_CMD': {
          if (isCommandBlocked(target)) {
            return { success: false, result: `Blocked: "${target}" matches a dangerous command pattern.` };
          }
          try {
            const output = execSync(target, {
              timeout: 30000,
              maxBuffer: 1024 * 1024,
              encoding: 'utf-8',
            });
            return { success: true, result: output || '(no output)' };
          } catch (execErr) {
            return { success: false, result: execErr.stderr || execErr.stdout || execErr.message };
          }
        }

        case 'RUN_SCRIPT': {
          if (!isPathReadable(target)) {
            return { success: false, result: `Access denied: "${target}" is outside allowed read paths.` };
          }
          if (!existsSync(target)) {
            return { success: false, result: `Script not found: ${target}` };
          }
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
            return { success: false, result: `Blocked: script execution matches a dangerous command pattern.` };
          }
          try {
            const output = execSync(fullCmd, {
              timeout: 60000,
              maxBuffer: 1024 * 1024 * 2,
              encoding: 'utf-8',
              cwd: dirname(target),
            });
            return { success: true, result: output || '(no output)' };
          } catch (execErr) {
            return { success: false, result: execErr.stderr || execErr.stdout || execErr.message };
          }
        }

        case 'WRITE_FILE': {
          if (!isPathWritable(target)) {
            return { success: false, result: `Access denied: "${target}" is outside allowed write paths.` };
          }
          const dir = dirname(target);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          const backup = backupFile(target);
          writeFileSync(target, content, 'utf-8');
          const msg = backup
            ? `File written. Backup saved to: ${backup}`
            : `File created at: ${target}`;
          return { success: true, result: msg };
        }

        default:
          return { success: false, result: `Unknown action type: ${type}` };
      }
    } catch (err) {
      return { success: false, result: `Error: ${err.message}` };
    }
  }

  // ── Action parsing (mirrors browser regex logic) ──

  const ACT_TYPES = 'READ_FILE|RUN_CMD|RUN_SCRIPT|WRITE_FILE';
  const ACT_RE_NEW = new RegExp('\\[ACTION:(' + ACT_TYPES + '):([\\s\\S]+?)\\[/ACTION\\]', 'g');
  const ACT_RE_OLD = new RegExp('\\[ACTION:(' + ACT_TYPES + '):([^\\]]+)\\]', 'g');
  const ACT_RE_STRIP = new RegExp('\\[ACTION:(' + ACT_TYPES + '):[\\s\\S]+?\\[/ACTION\\]', 'g');
  const ACT_RE_STRIP_OLD = new RegExp('\\[ACTION:(' + ACT_TYPES + '):[^\\]]*\\]', 'g');
  const ACT_RE_PARTIAL = /\[ACTION[\s\S]*$/;
  const CLEAN_TAG = /\[\/ACTION\s*$/;

  function extractActions(full) {
    const actions = [];
    let m;

    ACT_RE_NEW.lastIndex = 0;
    while ((m = ACT_RE_NEW.exec(full)) !== null) {
      const type = m[1];
      const raw = m[2].replace(CLEAN_TAG, '').trimEnd();
      let target, content;
      if (type === 'WRITE_FILE' || type === 'RUN_SCRIPT') {
        const ci = raw.indexOf(':');
        if (ci > -1) { target = raw.slice(0, ci); content = raw.slice(ci + 1).replace(CLEAN_TAG, '').trimEnd(); }
        else { target = raw; content = null; }
      } else {
        target = raw; content = null;
      }
      actions.push({ type, target, content });
    }

    // Check for legacy format in content not matched by new format
    const fullLegacy = full.replace(ACT_RE_STRIP, '');
    ACT_RE_OLD.lastIndex = 0;
    while ((m = ACT_RE_OLD.exec(fullLegacy)) !== null) {
      const type = m[1];
      const raw = m[2].replace(CLEAN_TAG, '').trimEnd();
      let target, content;
      if (type === 'WRITE_FILE' || type === 'RUN_SCRIPT') {
        const ci = raw.indexOf(':');
        if (ci > -1) { target = raw.slice(0, ci); content = raw.slice(ci + 1).replace(CLEAN_TAG, '').trimEnd(); }
        else { target = raw; content = null; }
      } else {
        target = raw; content = null;
      }
      actions.push({ type, target, content });
    }

    return actions;
  }

  function stripActions(text) {
    return text
      .replace(ACT_RE_STRIP, '')
      .replace(ACT_RE_STRIP_OLD, '')
      .replace(ACT_RE_PARTIAL, '')
      .trim();
  }

  // ── Terminal formatting helpers ──

  function actionBadge(type) {
    switch (type) {
      case 'READ_FILE':  return `${C.bgCyan}${C.black} READ ${C.reset}`;
      case 'RUN_CMD':    return `${C.bgYellow}${C.black} CMD ${C.reset}`;
      case 'RUN_SCRIPT': return `${C.bgYellow}${C.black} SCRIPT ${C.reset}`;
      case 'WRITE_FILE': return `${C.bgRed}${C.white} WRITE ${C.reset}`;
      default:           return `${C.dim}[${type}]${C.reset}`;
    }
  }

  function wrapText(text, width) {
    if (!text) return '';
    const lines = [];
    for (const rawLine of text.split('\n')) {
      if (rawLine.length <= width) { lines.push(rawLine); continue; }
      let remaining = rawLine;
      while (remaining.length > width) {
        let breakAt = remaining.lastIndexOf(' ', width);
        if (breakAt <= 0) breakAt = width;
        lines.push(remaining.slice(0, breakAt));
        remaining = remaining.slice(breakAt).trimStart();
      }
      if (remaining) lines.push(remaining);
    }
    return lines.join('\n');
  }

  function formatResponse(text) {
    // Simple terminal markdown: bold, code, code blocks
    let out = text;
    // Code blocks — highlight
    out = out.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const header = lang ? `${C.dim}── ${lang} ${'─'.repeat(Math.max(0, 40 - lang.length))}${C.reset}` : `${C.dim}${'─'.repeat(44)}${C.reset}`;
      return `\n${header}\n${C.cyan}${code.trimEnd()}${C.reset}\n${C.dim}${'─'.repeat(44)}${C.reset}`;
    });
    // Inline code
    out = out.replace(/`([^`]+)`/g, `${C.cyan}$1${C.reset}`);
    // Bold
    out = out.replace(/\*\*([^*]+)\*\*/g, `${C.bold}$1${C.reset}`);
    return out;
  }

  // ── Prompt helper ──

  function promptYN(rl, question) {
    return new Promise(resolve => {
      rl.question(question, answer => {
        resolve(answer.trim().toLowerCase().startsWith('y'));
      });
    });
  }

  function promptLine(rl, prompt) {
    return new Promise(resolve => {
      rl.question(prompt, answer => {
        resolve(answer);
      });
    });
  }

  // ── Streaming chat ──

  async function streamChat(messages) {
    const ollamaMessages = [
      { role: 'system', content: buildSystemPrompt() },
      ...messages,
    ];

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
      throw new Error(`Ollama error (${resp.status}): ${errText}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let insideAction = false;
    let pendingBracket = '';

    // Print assistant label
    process.stdout.write(`\n  ${C.cyan}${C.bold}DoctorClaw${C.reset}\n  `);

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
          if (parsed.message?.content) {
            const chunk = parsed.message.content;
            full += chunk;

            // Stream display: suppress text inside [ACTION:...[/ACTION] tags
            for (const ch of chunk) {
              if (insideAction) {
                // Look for end of action tag
                if (full.endsWith('[/ACTION]')) {
                  insideAction = false;
                }
              } else {
                pendingBracket += ch;
                if (ch === '[') {
                  // Start accumulating potential tag
                  pendingBracket = '[';
                } else if (pendingBracket.startsWith('[')) {
                  if (pendingBracket.match(/^\[ACTION:(READ_FILE|RUN_CMD|RUN_SCRIPT|WRITE_FILE):/)) {
                    insideAction = true;
                    pendingBracket = '';
                  } else if (pendingBracket.length > 30 || !('[ACTION:READ_FILE:'.startsWith(pendingBracket) ||
                             '[ACTION:RUN_CMD:'.startsWith(pendingBracket) ||
                             '[ACTION:RUN_SCRIPT:'.startsWith(pendingBracket) ||
                             '[ACTION:WRITE_FILE:'.startsWith(pendingBracket))) {
                    // Not an action tag, flush the pending text
                    process.stdout.write(pendingBracket);
                    pendingBracket = '';
                  }
                  // else still could be an action tag, keep buffering
                } else {
                  process.stdout.write(ch);
                  pendingBracket = '';
                }
              }
            }
          }
          if (parsed.done) break;
        } catch { /* skip malformed */ }
      }
    }

    // Flush any remaining pending text that wasn't an action tag
    if (pendingBracket && !insideAction) {
      process.stdout.write(pendingBracket);
    }
    process.stdout.write('\n');

    return full;
  }

  // ── Main loop ──

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `  ${C.bold}You${C.reset}${C.dim} > ${C.reset}`,
  });

  async function handleUserInput(text) {
    text = text.trim();
    if (!text) return;

    // Slash commands
    if (text === '/quit' || text === '/exit') {
      console.log(`\n  ${C.dim}Goodbye!${C.reset}\n`);
      process.exit(0);
    }
    if (text === '/new') {
      conversation = [];
      console.log(`\n  ${C.green}New session started.${C.reset}\n`);
      return;
    }
    if (text === '/clear') {
      process.stdout.write('\x1b[2J\x1b[H');
      console.log(`  ${C.cyan}${C.bold}  DoctorClaw${C.reset}  ${C.dim}Terminal Mode${C.reset}`);
      console.log(`  ${C.dim}${'─'.repeat(50)}${C.reset}\n`);
      return;
    }
    if (text === '/help') {
      console.log('');
      console.log(`  ${C.bold}Commands:${C.reset}`);
      console.log(`    ${C.cyan}/new${C.reset}    Start a new session`);
      console.log(`    ${C.cyan}/clear${C.reset}  Clear the screen`);
      console.log(`    ${C.cyan}/quit${C.reset}   Exit DoctorClaw`);
      console.log(`    ${C.cyan}/help${C.reset}   Show this help`);
      console.log('');
      return;
    }

    // Add user message
    conversation.push({ role: 'user', content: text });

    // Stream response and process any action chains
    await processResponse();

    console.log('');
  }

  // Process a response: stream it, then handle any actions (which may trigger follow-ups)
  async function processResponse() {
    let full;
    try {
      full = await streamChat(conversation);
    } catch (err) {
      console.log(`\n  ${C.red}Error: ${err.message}${C.reset}\n`);
      conversation.pop(); // remove the message that triggered this
      return;
    }

    if (!full.trim()) {
      full = conversation.length <= 2
        ? "Hello! I'm DoctorClaw, your system diagnostics assistant. How can I help you today?"
        : "I wasn't able to generate a response. Try rephrasing or starting a new session with /new.";
      console.log(`  ${formatResponse(full)}`);
    }

    conversation.push({ role: 'assistant', content: full });

    // Parse and handle actions — loop handles chained follow-ups
    const actions = extractActions(full);
    const MAX_RESULT = 4000;

    for (const act of actions) {
      console.log('');
      console.log(`  ${C.dim}${'─'.repeat(50)}${C.reset}`);
      console.log(`  ${actionBadge(act.type)}  ${C.bold}${act.target}${C.reset}`);
      if (act.content) {
        const preview = act.content.length > 200 ? act.content.slice(0, 200) + '...' : act.content;
        console.log(`  ${C.dim}${preview}${C.reset}`);
      }
      console.log(`  ${C.dim}${'─'.repeat(50)}${C.reset}`);

      const approved = await promptYN(rl, `  ${C.yellow}Approve? (y/n)${C.reset} `);

      if (approved) {
        process.stdout.write(`  ${C.dim}Executing...${C.reset}`);
        const result = executeAction(act.type, act.target, act.content);
        process.stdout.write('\r\x1b[K'); // clear "Executing..." line

        console.log(result.success ? `  ${C.green}Success${C.reset}` : `  ${C.red}Failed${C.reset}`);

        // Show result (truncated for display)
        const displayResult = result.result.length > 2000
          ? result.result.slice(0, 2000) + `\n${C.dim}  ...[truncated, ${result.result.length} total chars]${C.reset}`
          : result.result;
        const resultColor = result.success ? C.green : C.red;
        console.log(`  ${C.dim}${'─'.repeat(40)}${C.reset}`);
        console.log(`  ${resultColor}${displayResult}${C.reset}`);
        console.log(`  ${C.dim}${'─'.repeat(40)}${C.reset}`);

        // Feed result back into conversation
        let resultForConv = result.result;
        if (resultForConv.length > MAX_RESULT) {
          resultForConv = resultForConv.slice(0, MAX_RESULT) + '\n...[truncated]';
        }
        conversation.push({
          role: 'user',
          content: `[Result of ${act.type} on "${act.target}"]: ${result.success ? 'SUCCESS' : 'FAILED'}\n${resultForConv}`,
        });

        // Stream follow-up (which may contain more actions — handled recursively)
        await processResponse();
      } else {
        console.log(`  ${C.dim}Action denied.${C.reset}`);
        conversation.push({
          role: 'user',
          content: `[User DENIED the action: ${act.type} on "${act.target}"]`,
        });
      }
    }
  }

  // ── Start the REPL ──

  rl.prompt();

  rl.on('line', async (line) => {
    // Pause readline during processing so prompts don't interfere
    rl.pause();
    await handleUserInput(line);
    rl.prompt();
    rl.resume();
  });

  rl.on('close', () => {
    console.log(`\n  ${C.dim}Goodbye!${C.reset}\n`);
    process.exit(0);
  });

  // Keep process alive
  return new Promise(() => {});
}
