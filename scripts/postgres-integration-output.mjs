import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';

const limit = 32 * 1024 * 1024, prefix = 'AMPG ';
const phases = new Set(['begin', 'connect', 'end', 'error', 'setup', 'check', 'close', 'drop',
  'complete', 'create', 'start', 'ready', 'cleanup']);
const records = [];
const children = new Set();
const abort = new AbortController();
const signals = new Set(['none', 'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGABRT', 'SIGKILL',
  'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGBUS', 'SIGXCPU', 'SIGXFSZ']);
let bytes = 0;
let publicBytes = 0;
let failed = false;
let cleaning = false;
let begun = false;
let complete = false;
let createAttempted = false;
let stopping = false;
let cutoff = Infinity;
let observedSignal = 'none';
let directory, capture, container, attached, executionTimer, cleanupTimer;
const name = 'ai-memory-ci-' + randomUUID();
const manifest = 'sha256:ff8da7b0714e5efa413d77f43e24d93064dd66469d418d12608c1bbc91fcf045';
const image = 'pgvector/pgvector@' + manifest;
const serviceEnvironment = "POSTGRES_USER=ci_memory\nPOSTGRES_PASSWORD=ci_only\nPOSTGRES_DB=ai_memory_ci\n";
const integrationEnvironment = {"AI_MEMORY_DATABASE_URL": "postgresql://ci_memory:ci_only@127.0.0.1:5432/ai_memory_ci", "AI_MEMORY_PROJECT_IDENTITY_TEST_URL": "postgresql://ci_memory:ci_only@127.0.0.1:5432/ai_memory_project_identity_ci"};

function stop(child) {
  // The production job is Linux: discover descendants, then signal only exact owned PIDs.
  const owned = new Set([child.pid]), parents = new Map();
  if (process.platform === 'linux') {
    for (const pid of readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
      try {
        const stat = readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ').at(-1).split(' ');
        parents.set(Number(pid), Number(stat[1]));
      } catch { /* A process may exit during the snapshot. */ }
    }
    for (let previous = -1; previous !== owned.size;) {
      previous = owned.size;
      for (const [pid, parent] of parents) if (owned.has(parent)) owned.add(pid);
    }
  }
  for (const pid of [...owned].reverse()) if (Number.isInteger(pid) && pid > 1) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
}
function fault() {
  failed = true;
  abort.abort();
  for (const child of children) { try { stop(child); } catch { failed = true; } }
}
function captureFault() {
  if (cleaning) failed = true;
  else fault();
}
function record(value, imageReceipt = false) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw Error();
  if ((value.event === 'image') !== imageReceipt || imageReceipt
    && Object.keys(value).sort().join(',') !== 'event,imageId,manifest,platform') throw Error();
  for (const [key, item] of Object.entries(value)) {
    const valid = key === 'event' ? ['phase', 'client', 'pool', 'uncaught', 'exit', 'image'].includes(item)
      : key === 'manifest' ? imageReceipt && item === manifest
      : key === 'imageId' ? imageReceipt && typeof item === 'string' && /^sha256:[a-f0-9]{64}$/.test(item)
      : key === 'platform' ? imageReceipt && item === 'linux/amd64'
      : key === 'phase' ? phases.has(item)
      : key === 'code' ? typeof item === 'string' && /^[0-9A-Z]{5}$/.test(item)
      : key === 'signal' ? signals.has(item)
      : ['id', 'client', 'pid', 'count', 'status'].includes(key)
        && Number.isSafeInteger(item) && item >= 0 && item <= (key === 'status' ? 255 : 2147483647);
    if (!valid) throw Error();
  }
  if (!Object.hasOwn(value, 'event') || (value.event === 'phase' && !Object.hasOwn(value, 'phase')))
    throw Error();
  const line = JSON.stringify(value) + '\n';
  if (records.length >= 511 || publicBytes + Buffer.byteLength(line) > 65024) throw Error();
  publicBytes += Buffer.byteLength(line);
  records.push(line);
  if (value.event === 'phase' && value.phase === 'begin') begun = true;
  if (value.event === 'phase' && value.phase === 'complete') {
    if (!begun) throw Error();
    complete = true;
  }
}
function phase(value) { record({ event: 'phase', phase: value }); }
function command(executable, args, env = process.env, inspect = false) {
  if (performance.now() >= cutoff) throw Error();
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '';
  for (const [index, stream] of [child.stdout, child.stderr].entries()) {
    let pending = '', dropping = false;
    stream.on('data', chunk => {
      try {
        const remaining = limit - bytes;
        if (chunk.length > remaining) { captureFault(); return; }
        const written = writeSync(capture, chunk);
        bytes += written;
        if (written !== chunk.length) throw Error();
        if (inspect && index === 0) {
          if (output.length + chunk.length > 4096) throw Error();
          output += chunk.toString();
        }
        const pieces = chunk.toString('utf8').split('\n');
        for (let i = 0; i < pieces.length; i++) {
          if (!dropping) pending += pieces[i];
          if (Buffer.byteLength(pending) > 65536) {
            if (pending.startsWith(prefix)) throw Error();
            pending = ''; dropping = true;
          }
          if (i < pieces.length - 1) {
            if (pending.startsWith(prefix)) record(JSON.parse(pending.slice(prefix.length)));
            pending = ''; dropping = false;
          }
        }
      } catch { captureFault(); }
    });
    stream.on('error', captureFault);
    stream.on('end', () => { if (pending.startsWith(prefix)) captureFault(); });
  }
  const done = new Promise(resolve => {
    child.on('error', fault);
    child.on('close', (code, signal) => {
      children.delete(child);
      resolve({ status: code ?? 128 + (constants.signals[signal] ?? 1), signal,
        output: output.trim() });
    });
  });
  return { child, done };
}
async function checked(executable, args, env, inspect = false) {
  if (failed) throw Error();
  const result = await command(executable, args, env, inspect).done;
  if (result.status !== 0 || failed) throw Error();
  return result.output;
}
async function main() {
  let status = 1;
  const started = Number(process.env.AI_MEMORY_POSTGRES_JOB_STARTED_MS);
  const now = Date.now();
  // Reserve the entire 7+1 minutes before dispatch; bootstrap consumes the remainder.
  if (!Number.isSafeInteger(started) || started > now || now - started > 119000) {
    failed = true; return status;
  }
  directory = mkdtempSync(join(tmpdir(), 'memory-postgres-'));
  capture = openSync(join(directory, 'capture'), 'wx', 0o600);
  cutoff = performance.now() + 480000;
  executionTimer = setTimeout(fault, 420000);
  const onSignal = () => fault();
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
  try {
    const envFile = join(directory, 'environment');
    const envFd = openSync(envFile, 'wx', 0o600);
    try {
      const written = writeSync(envFd, serviceEnvironment);
      bytes += written;
      if (written !== Buffer.byteLength(serviceEnvironment) || bytes > limit) throw Error();
    } finally { closeSync(envFd); }
    phase('create');
    createAttempted = true;
    container = await checked('docker', ['create', '--name', name, '--log-driver', 'none',
      '--env-file', envFile, '-p', '5432:5432', '--health-cmd',
      'pg_isready -U ci_memory -d ai_memory_ci', '--health-interval', '10s',
      '--health-timeout', '5s', '--health-retries', '5', image], undefined, true);
    if (!/^[a-f0-9]{64}$/.test(container)) throw Error();
    if (await checked('docker', ['inspect', '--format', '{{.HostConfig.LogConfig.Type}}', container],
      undefined, true) !== 'none') throw Error();
    const containerImage = await checked('docker', ['inspect', '--format', '{{.Image}}', container], undefined, true);
    const identity = (await checked('docker', ['image', 'inspect', '--format',
      '{{json .RepoDigests}}|{{.Id}}|{{.Os}}|{{.Architecture}}', image], undefined, true)).split('|');
    if (identity.length !== 4 || !/^sha256:[a-f0-9]{64}$/.test(identity[1])
      || containerImage !== identity[1] || identity[2] !== 'linux' || identity[3] !== 'amd64') throw Error();
    const digests = JSON.parse(identity[0]);
    if (!Array.isArray(digests) || !digests.includes(image)) throw Error();
    record({ event: 'image', manifest, imageId: containerImage, platform: 'linux/amd64' }, true);
    phase('start');
    attached = command('docker', ['start', '--attach', container]);
    attached.done.then(() => { if (!stopping) fault(); });
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { abort.signal.removeEventListener('abort', cancel); resolve(); }, 10000);
        const cancel = () => { clearTimeout(timer); reject(Error()); };
        abort.signal.addEventListener('abort', cancel, { once: true });
        if (abort.signal.aborted) cancel();
      });
      const state = JSON.parse(await checked('docker', ['inspect', '--format', '{{json .State}}',
        container], undefined, true));
      if (state.Status === 'running' && state.Running === true && state.Health?.Status === 'healthy') break;
      const waiting = state.Status === 'created' && state.Running === false
        || state.Status === 'running' && state.Running === true && state.Health?.Status === 'starting';
      if (!waiting || attempt === 5) throw Error();
    }
    phase('ready');
    const env = { ...process.env, ...integrationEnvironment, AI_MEMORY_POSTGRES_TRACE: '1' };
    phase('setup');
    await checked('node', ['--input-type=module', '-e',
      "import pg from 'pg'; const c=new pg.Client({connectionString:process.env.AI_MEMORY_DATABASE_URL}); await c.connect(); try { await c.query('CREATE DATABASE ai_memory_project_identity_ci OWNER ci_memory'); } finally { await c.end(); }"], env);
    phase('check');
    const result = await command('npm', ['run', 'test:integration'], env).done;
    status = result.status;
    observedSignal = signals.has(result.signal) ? result.signal : 'none';
    if (!complete || failed) throw Error();
  } catch { failed = true; }
  finally {
    clearTimeout(executionTimer);
    cleaning = true;
    cleanupTimer = setTimeout(fault, Math.max(0, Math.min(60000, cutoff - performance.now())));
    try { phase('cleanup'); } catch { failed = true; }
    try {
      if (createAttempted) {
        // Reconcile an uncertain create acknowledgement through this exact owned name.
        if (!/^[a-f0-9]{64}$/.test(container ?? '')) {
          const result = await command('docker', ['inspect', '--format', '{{.Id}}', name], process.env, true).done;
          if (result.status !== 0 || !/^[a-f0-9]{64}$/.test(result.output)) throw Error();
          container = result.output;
        }
        stopping = true;
        const removal = await command('docker', ['rm', '--force', '--volumes', container]).done;
        if (removal.status !== 0) throw Error();
        if (attached) {
          const result = await attached.done;
          if (result.status !== 0 && result.status !== 137) throw Error();
        }
      }
    } catch { failed = true; }
    finally {
      for (const child of children) { try { stop(child); } catch { failed = true; } }
      clearTimeout(cleanupTimer);
      process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal);
    }
  }
  return status || (failed ? 1 : 0);
}
let status = 1;
try { status = await main(); } catch { failed = true; }
finally {
  clearTimeout(executionTimer); clearTimeout(cleanupTimer);
  for (const child of children) { try { stop(child); } catch { failed = true; } }
  try { if (capture !== undefined) closeSync(capture); } catch { failed = true; }
  try { if (directory) rmSync(directory, { recursive: true }); } catch { failed = true; }
}
if (failed && status === 0) status = 1;
records.push(JSON.stringify({ event: 'exit', status, signal: observedSignal, count: records.length }) + '\n');
process.exitCode = status;
process.stdout.on('error', () => { process.exitCode = status || 1; });
try {
  await new Promise(resolve => process.stdout.write(records.join(''), error => {
    if (error) process.exitCode = status || 1;
    resolve();
  }));
} catch { process.exitCode = status || 1; }
