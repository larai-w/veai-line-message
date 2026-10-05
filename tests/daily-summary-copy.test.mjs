import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The receiver returns success after provider acceptance. It has no recipient
// delivery/read receipt or human-care confirmation feed for daily summaries.
test('daily-summary documentation distinguishes API acceptance from delivery', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.split('## Daily care summary receiver\n')[1]?.split('\n## ')[0];
  assert.ok(section, 'daily-summary section must be present');
  const rows = section.split('\n').filter(line => line.startsWith('|'));
  const success = rows.find(line => /200\s+\{/.test(line));
  assert.ok(success, 'success response must be documented');
  assert.match(success, /LINE API accepted the push request/);
  assert.doesNotMatch(success, /\bDelivered\b/i);
  assert.match(section, /does not\s+confirm delivery to the recipient/);
  assert.match(section, /that anyone read it/);
  assert.match(section, /that care was provided/);
  assert.match(section, /postback; its status\s+is not included in these daily-summary counts/);
});
