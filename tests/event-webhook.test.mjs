import { test } from 'node:test';
import assert from 'node:assert/strict';

const SECRET = ['dummy', 'event', 'not', 'a', 'real', 'secret'].join('-');
process.env.EVENT_WEBHOOK_SECRET = SECRET;
delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
delete process.env.LINE_USER_ID;

const { handler, formatMicroduckEvent, parseMicroduckEvent } = await import('../index.mjs');

const EVENT = {
  type: 'fall_detected', ts: '2026-09-04T10:00:00+0900', source: 'duckbridge',
  detail: { source: 'robot.state' },
};
const request = (headers = {}, body = JSON.stringify(EVENT)) => ({
  requestContext: { http: { method: 'POST', path: '/' } }, headers, body,
});

test('イベント: 正しいシークレットならLINE送信段階まで進む', async () => {
  const result = await handler(request({ 'x-event-secret': SECRET }));
  assert.equal(result.statusCode, 502, 'LINE未設定のため502。認証と検証は通っている');
});

test('イベント: シークレットが違えば送信しない', async () => {
  const result = await handler(request({ 'x-event-secret': 'wrong' }));
  assert.equal(result.statusCode, 401);
});

test('イベント: 未知の種別は受け取らない', async () => {
  const result = await handler(request({ 'x-event-secret': SECRET }, JSON.stringify({ ...EVENT, type: 'unknown' })));
  assert.equal(result.statusCode, 400);
});

test('イベント: 検証済みデータを固定文へ変換する', () => {
  assert.match(formatMicroduckEvent(EVENT), /転倒を検知しました/);
  assert.deepEqual(parseMicroduckEvent(JSON.stringify(EVENT)), EVENT);
});
