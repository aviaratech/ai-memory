import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const entry = fileURLToPath(new URL('./postgres-integration-output.mjs', import.meta.url));
const fixture = String.raw`
const fs = require('node:fs'), path = require('node:path');
const root = path.dirname(__dirname), scenario = fs.readFileSync(path.join(root,'scenario'),'utf8');
const args = process.argv.slice(2), name = path.basename(process.argv[1]);
const id = 'a'.repeat(64), marker = 'synthetic-marker-7d72';
const record = value => process.stdout.write('AMPG '+JSON.stringify(value)+'\n');
fs.appendFileSync(path.join(root,'calls'),name+' '+(args[0]||'')+'\n');
function noise() { console.error({cause:{connectionParameters:{password:marker},secretKey:marker}}); }
if(name==='docker') {
  if(args[0]==='create') {
    const index=args.indexOf('--log-driver');
    fs.writeFileSync(path.join(root,'driver'),index<0?'json-file':args[index+1]);
    noise(); console.log(id);
  }
  else if(args[0]==='inspect') {
    if(args.includes('{{.HostConfig.LogConfig.Type}}')) console.log(scenario==='logging'?'json-file':fs.readFileSync(path.join(root,'driver'),'utf8'));
    else if(args.includes('{{.State.Health.Status}}')) console.log(scenario==='deadline'?'starting':'healthy');
    else console.log(id);
  } else if(args[0]==='start') {
    fs.writeFileSync(path.join(root,'attached'),String(process.pid)); noise();
    if(scenario==='attachment') process.exitCode=2;
    else { process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000); }
  } else if(args[0]==='rm') {
    noise();
    try { process.kill(Number(fs.readFileSync(path.join(root,'attached'),'utf8')),'SIGTERM'); } catch {}
    if(scenario==='cleanup') process.exitCode=3;
    if(scenario==='deadline') setInterval(()=>{},1000);
  }
} else if(name==='node') { noise(); if(scenario==='setup') process.exitCode=4; }
else if(name==='npm') {
  if(scenario!=='incomplete') record({event:'phase',phase:'begin'}); noise();
  if(scenario==='overflow') {
    const chunk=Buffer.alloc(65536,120); let count=0;
    function more() { while(count++<540) if(!process.stdout.write(chunk)) return process.stdout.once('drain',more); }
    more();
  } else if(scenario==='records') for(let i=0;i<513;i++) record({event:'phase',phase:'begin'});
  else if(scenario==='publicbytes') for(let i=0;i<510;i++) record({event:'client',phase:'error',id:2147483647,client:2147483647,pid:2147483647,count:2147483647,status:255,code:'57P01',signal:'SIGTERM'});
  else if(scenario==='malformed') record({event:'client',password:marker});
  else if(scenario==='missing') process.exit(0);
  record({event:'phase',phase:'complete'});
  if(scenario==='assertion') { const e=new Error(marker); e.cause={password:marker}; throw e; }
  if(scenario==='unhandled') { const e=new Error(marker); e.code='57P01'; record({event:'uncaught',code:e.code}); Promise.reject(e); }
  if(scenario==='exit') process.exitCode=7;
  if(scenario==='signal') process.kill(process.pid,'SIGTERM');
}
`;

function run(scenario, stale = false) {
  const root = mkdtempSync(join(tmpdir(), 'memory-privacy-synthetic-'));
  const bin = join(root, 'bin');
  mkdirSync(bin, { mode: 0o700 });
  writeFileSync(join(root, 'scenario'), scenario);
  writeFileSync(join(root, 'calls'), '');
  for (const name of ['docker', 'npm', 'node'])
    writeFileSync(join(bin, name), '#!' + process.execPath + '\n' + fixture, { mode: 0o700 });
  let result;
  try {
    const flags = [];
    if (scenario === 'deadline') {
      const hook = join(root, 'clock.mjs');
      writeFileSync(hook, `
        import {writeFileSync} from 'node:fs';
        let elapsed=0; const origin=Date.now(), timer=globalThis.setTimeout;
        Date.now=()=>origin+elapsed;
        Object.defineProperty(performance,'now',{value:()=>elapsed});
        globalThis.setTimeout=(callback,ms,...args)=>timer(()=>{elapsed+=ms;callback(...args)},
          ms===420000?1500:ms===10000?2000:ms>10000?300:ms);
        process.on('exit',()=>writeFileSync(${JSON.stringify(join(root, 'clock'))},String(elapsed)));
      `);
      flags.push('--import', hook);
    }
    result = spawnSync(process.execPath, [...flags, entry], {
      cwd: resolve(dirname(entry), '..'),
      env: { PATH: bin, HOME: root, TMPDIR: root,
        AI_MEMORY_POSTGRES_JOB_STARTED_MS: String(Date.now() - (stale ? 125000 : 0)) },
      encoding: 'utf8', timeout: 20000, maxBuffer: 128 * 1024,
    });
    assert.equal(result.error, undefined, 'the synthetic process must finish');
    const output = result.stdout + result.stderr;
    assert.equal(output.includes('synthetic-marker-7d72'), false, 'private markers must never publish');
    assert.equal(Buffer.byteLength(output) <= 65536, true);
    assert.equal(result.stderr, '');
    const records = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(records.length <= 512, true);
    assert.equal(records.length > 0, true);
    assert.equal(readdirSync(root).some(name => name.startsWith('memory-postgres-')), false,
      'owned raw artifacts must be removed');
    return { status: result.status, records, calls: readFileSync(join(root, 'calls'), 'utf8'),
      elapsed: scenario === 'deadline' ? Number(readFileSync(join(root, 'clock'), 'utf8')) : 0 };
  } finally {
    // Safety net for the fake service if a regression prevents the gate's cleanup.
    try { process.kill(Number(readFileSync(join(root, 'attached'), 'utf8')), 'SIGTERM'); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}

test('owned startup through teardown keeps nested non-URI markers private', () => {
  const result = run('success');
  assert.equal(result.status, 0);
  assert.equal(result.calls.includes('docker rm'), true);
  assert.equal(result.records.some(record => record.phase === 'complete'), true);
});
for (const scenario of ['assertion', 'unhandled', 'setup', 'cleanup', 'attachment', 'logging',
  'overflow', 'records', 'publicbytes', 'malformed', 'missing', 'incomplete'])
  test(`${scenario} retains failure without publishing private output`, () => {
    const result = run(scenario);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.includes('docker rm'), true, 'failed output must still permit owned service cleanup');
    if (scenario === 'logging') assert.equal(result.calls.includes('docker start'), false);
  });
test('original nonzero integration status survives capture and cleanup', () => {
  assert.equal(run('exit').status, 7);
});
test('original integration signal remains visible as a failing signal status', () => {
  const result = run('signal');
  assert.equal(result.status, 143);
  assert.equal(result.records.at(-1).signal, 'SIGTERM');
});
test('insufficient job allowance refuses every owned command', () => {
  const result = run('success', true);
  assert.notEqual(result.status, 0);
  assert.equal(result.calls, '');
});
test('execution timeout leaves cleanup inside the original eight-minute allowance', () => {
  const result = run('deadline');
  assert.notEqual(result.status, 0);
  assert.equal(result.elapsed <= 480000, true, 'cleanup must not reset the admitted deadline');
});

test('actual observer forwards the same unhandled Client and Pool error objects', () => {
  const root = mkdtempSync(join(tmpdir(), 'memory-observer-synthetic-'));
  try {
    writeFileSync(join(root, 'hooks.mjs'), `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        const source = specifier === 'pg' ? 'export default globalThis.fixturePg'
          : specifier === 'vitest' ? 'const test=()=>{}; test.skipIf=()=>()=>{}; export {test}; export const afterAll=f=>globalThis.finish=f;'
          : specifier.endsWith('/localPostgresSetup.js') || specifier === './localPostgresSetup.js'
            ? 'export const parseSetupArguments=()=>{}; export const runLocalPostgresSetup=()=>{};' : null;
        return source ? {url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true} : next(specifier, context);
      }});
    `);
    const observed = pathToFileURL(resolve(dirname(entry), '../packages/ai-memory/src/tools/localPostgresSetup.integration.test.ts')).href;
    const source = `
      import assert from 'node:assert/strict'; import { EventEmitter } from 'node:events';
      globalThis.fixturePg={Client:class extends EventEmitter {processID=12345},Pool:class extends EventEmitter {}};
      await import(${JSON.stringify(observed)});
      const original=new Error('synthetic-marker-7d72'); original.code='57P01'; original.cause={password:'synthetic-marker-7d72'};
      for(const Constructor of Object.values(globalThis.fixturePg)) {
        const emitter=new Constructor(); let caught;
        try { emitter.emit('error',original); } catch(error) {caught=error}
        assert.equal(caught,original); assert.equal(emitter.listenerCount('error'),0);
      }
      process.emit('uncaughtExceptionMonitor',original,'uncaughtException');
      globalThis.finish?.();
    `;
    const result = spawnSync(process.execPath, ['--import', join(root, 'hooks.mjs'), '--input-type=module', '-e', source], {
      env: { PATH: root, HOME: root, TMPDIR: root, AI_MEMORY_POSTGRES_TRACE: '1' },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, 'observer must leave original error identity and unhandled behavior intact');
    assert.equal((result.stdout + result.stderr).includes('synthetic-marker-7d72'), false);
    const records = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line.slice(5)));
    for (const event of ['client', 'pool', 'uncaught'])
      assert.equal(records.some(record => record.event === event && record.code === '57P01'), true,
        'observer must report only bounded error classifications');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
