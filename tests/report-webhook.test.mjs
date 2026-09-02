// microduck の日次介護サマリー入口が、誰でも家族LINEに送れる状態になって
// いないことを固定する。
//
// この入口は公開URLに晒される。認証が緩むと、第三者が家族のLINEへ
// 偽の介護サマリー（または大量のメッセージ）を送れるようになる。
//
// LINE の環境変数は意図的に未設定にしてある。認証を通ると sendLineMessage
// が例外を投げて 502 になるため、401(認証で弾いた)と 502(認証は通った)で
// 区別できる。LINE を実際に呼ばずに認証だけ検証する（EchoCare の
// webhook-auth.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

// 実在しないダミー値。gitleaks の誤検知を避けるため、高エントロピーな
// 文字列を直書きせず組み立てる。許可リストで抜け道を作ると、将来の
// 本物のシークレットも同じ経路で通ってしまう。
const DUMMY_SECRET = ['dummy', 'report', 'not', 'a', 'real', 'secret'].join('-');
process.env.REPORT_WEBHOOK_SECRET = DUMMY_SECRET;
delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
delete process.env.LINE_USER_ID;

const { handler, formatDailySummary } = await import('../index.mjs');

const VALID_REPORT = {
  type: 'daily_summary',
  date: '2026-09-02',
  pace_sessions: 3,
  pace_duration_s: 330.0,
  pace_distance_m: 320.4,
  pace_beats: 264,
  reminders: 4,
  checkins: 1,
  nurse_calls_ok: 1,
  nurse_calls_failed: 0,
  commands: 2,
  generated_at: '2026-09-02T18:00:01+0900',
};

const webhookEvent = (headers = {}, qs = null, body = JSON.stringify(VALID_REPORT), isBase64Encoded = false) => ({
  requestContext: { http: { method: 'POST', path: '/' } },
  headers,
  queryStringParameters: qs,
  body,
  isBase64Encoded,
});

// --- 認証 -------------------------------------------------------------------

test('シークレットが無ければ送らない', async () => {
  const r = await handler(webhookEvent());
  assert.equal(r.statusCode, 401);
});

test('シークレットが違えば送らない', async () => {
  const r = await handler(webhookEvent({ 'x-report-secret': 'wrong' }));
  assert.equal(r.statusCode, 401);
});

test('長さだけ合っていても送らない', async () => {
  const r = await handler(webhookEvent({ 'x-report-secret': 'x'.repeat(DUMMY_SECRET.length) }));
  assert.equal(r.statusCode, 401);
});

test('正しいシークレットなら送信処理まで進む（ヘッダー）', async () => {
  const r = await handler(webhookEvent({ 'x-report-secret': DUMMY_SECRET }));
  assert.equal(r.statusCode, 502, 'LINE 未設定のため 502。認証は通っている');
});

test('正しいシークレットなら送信処理まで進む（クエリ文字列）', async () => {
  // Webhook のヘッダーを設定できない送り手のため、クエリでも受ける
  const r = await handler(webhookEvent({}, { secret: DUMMY_SECRET }));
  assert.equal(r.statusCode, 502);
});

// --- ペイロード検証 -----------------------------------------------------------

test('壊れたJSONは受け取ったことにしない（ブリッジがリトライできる）', async () => {
  const r = await handler(webhookEvent({ 'x-report-secret': DUMMY_SECRET }, null, '{not json'));
  assert.equal(r.statusCode, 400);
});

test('daily_summary 以外は受け取らない', async () => {
  const body = JSON.stringify({ ...VALID_REPORT, type: 'fall_event' });
  const r = await handler(webhookEvent({ 'x-report-secret': DUMMY_SECRET }, null, body));
  assert.equal(r.statusCode, 400);
});

test('日付の形が違えば受け取らない', async () => {
  const body = JSON.stringify({ ...VALID_REPORT, date: '09/02/2026' });
  const r = await handler(webhookEvent({ 'x-report-secret': DUMMY_SECRET }, null, body));
  assert.equal(r.statusCode, 400);
});

test('負の値は受け取らない', async () => {
  const body = JSON.stringify({ ...VALID_REPORT, pace_sessions: -1 });
  const r = await handler(webhookEvent({ 'x-report-secret': DUMMY_SECRET }, null, body));
  assert.equal(r.statusCode, 400);
});

test('数値フィールドの欠落は受け取らない', async () => {
  const { pace_beats, ...partial } = VALID_REPORT;
  const r = await handler(webhookEvent({ 'x-report-secret': DUMMY_SECRET }, null, JSON.stringify(partial)));
  assert.equal(r.statusCode, 400);
});

test('base64 で届く関数URLボディも検証できる', async () => {
  const b64 = Buffer.from(JSON.stringify(VALID_REPORT), 'utf-8').toString('base64');
  const r = await handler(webhookEvent({ 'x-report-secret': DUMMY_SECRET }, null, b64, true));
  assert.equal(r.statusCode, 502, '検証を通って LINE 送信段階まで到達');
});

// --- 定型文化（純関数。LINEは叩かない） ----------------------------------------

test('定型文: 数値がそのまま家族向けテキストになる', () => {
  const text = formatDailySummary(VALID_REPORT);
  assert.match(text, /【介護サマリー】2026-09-02/);
  assert.match(text, /歩行: 3回・計5.5分・約320m/);
  assert.match(text, /リマインド: 4回（うち安否確認1回）/);
  assert.match(text, /ナースコール: 成功1回・失敗0回/);
  assert.match(text, /その他コマンド: 2回/);
});

test('定型文: 全0の日も数値をそのまま出す（沈黙を解釈しない）', () => {
  const zero = { ...VALID_REPORT, pace_sessions: 0, pace_duration_s: 0, pace_distance_m: 0, pace_beats: 0, reminders: 0, checkins: 0, nurse_calls_ok: 0, nurse_calls_failed: 0, commands: 0 };
  const text = formatDailySummary(zero);
  assert.match(text, /歩行: 0回・計0分・約0m/);
});

test('定型文: 分数は1桁に丸める（125秒→2.1分、99.6m→100m）', () => {
  const text = formatDailySummary({ ...VALID_REPORT, pace_duration_s: 125, pace_distance_m: 99.6 });
  assert.match(text, /歩行: 3回・計2.1分・約100m/);
});

// --- Alexa 経路の不変 ---------------------------------------------------------

test('Webhook を足しても Alexa の経路は変わらない', async () => {
  const r = await handler({ request: { type: 'LaunchRequest' } });
  assert.match(r.response.outputSpeech.text, /看護師メッセージ/);
});