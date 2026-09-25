import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const [file, tag, sourceSha, archive, phase] = process.argv.slice(2);
if (!file || !tag || !sourceSha || !archive || !['preflight', 'final'].includes(phase)) {
  throw new Error('Usage: verify-release-state <json> <tag> <source-sha> <archive> <preflight|final>');
}

const release = JSON.parse(readFileSync(file, 'utf8'));
assert.equal(release.tagName, tag, 'release tag mismatch');
assert.equal(release.name, `ai-memory ${tag}`, 'release title mismatch');
assert.equal(release.body?.trimEnd(), `Reviewed ai-memory release from ${sourceSha}.`, 'release notes mismatch');
assert.equal(release.isPrerelease, false, 'unexpected prerelease flag');
assert.equal(typeof release.isDraft, 'boolean', 'missing draft state');
assert.ok(Array.isArray(release.assets), 'missing release assets');
assert.ok(release.assets.length <= 1, 'unexpected release assets');

if (release.assets.length === 1) {
  const asset = release.assets[0];
  assert.equal(asset.name, archive, 'unexpected release asset');
  assert.ok(asset.label == null || asset.label === '', 'unexpected release asset label');
  assert.equal(asset.state, 'uploaded', 'release asset is incomplete');
} else {
  assert.equal(release.isDraft, true, 'published release is missing the plugin archive');
}

if (phase === 'final') {
  assert.equal(release.isDraft, false, 'release is still a draft');
  assert.equal(release.assets.length, 1, 'published release is missing the plugin archive');
}

process.stdout.write(`${release.isDraft ? 'draft' : 'published'} ${release.assets.length ? 'present' : 'absent'}\n`);
