import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

try {
  const [directory, checkoutCommit, checkoutTree, pullRequestSourceHead, runId, runAttempt] = process.argv.slice(2);
  if (
    process.argv.length !== 8 ||
    ![checkoutCommit, checkoutTree].every(value => /^[0-9a-f]{40}$/.test(value)) ||
    (pullRequestSourceHead !== '' && !/^[0-9a-f]{40}$/.test(pullRequestSourceHead)) ||
    ![runId, runAttempt].every(value => /^[1-9][0-9]*$/.test(value))
  )
    throw new Error('Invalid source identity');
  const archives = [];
  for (const [label, name] of [
    ['core', '@aviaratech/ai-memory'],
    ['plugin', '@aviaratech/ai-memory-plugin'],
  ]) {
    const [dry, packed] = ['dry-run', 'pack'].map(kind => {
      const records = JSON.parse(readFileSync(join(directory, `${label}-${kind}.json`), 'utf8'));
      if (records.length !== 1) throw new Error('Unexpected package count');
      return records[0];
    });
    const paths = item =>
      item.files
        .map(file => file.path)
        .sort()
        .join('\n');
    if (dry.name !== name || packed.name !== name || dry.version !== packed.version || paths(dry) !== paths(packed))
      throw new Error('Package inventory mismatch');
    const basename = `${name.slice(1).replace('/', '-')}-${packed.version}.tgz`;
    if (packed.filename !== basename || basename.includes('/') || basename.includes('\\'))
      throw new Error('Unexpected archive name');
    const file = join(directory, basename),
      metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.size === 0) throw new Error('Missing regular archive');
    archives.push({
      basename,
      size: metadata.size,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    });
  }
  const actual = readdirSync(directory)
    .filter(name => name.endsWith('.tgz'))
    .sort();
  if (
    actual.join('\n') !==
    archives
      .map(item => item.basename)
      .sort()
      .join('\n')
  )
    throw new Error('Unexpected archive set');
  writeFileSync(
    join(directory, 'source-digests.json'),
    JSON.stringify(
      {
        checkoutCommit,
        checkoutTree,
        pullRequestSourceHead: pullRequestSourceHead || null,
        runId,
        runAttempt,
        archives,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
} catch {
  console.error('CI package retention failed; check the archive set, inventories and source identities.');
  process.exitCode = 1;
}
