// シークレット未設定のとき、サマリー入口は完全に閉じていなければならない。
// 設定漏れで「誰でも送れる」状態になる方が、入口が無いより危険なため。
// （別プロセスで検証する必要があるため別ファイル。モジュールロード時に
//  環境変数が固定されるため。）

import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.REPORT_WEBHOOK_SECRET;

const { handler } = await import('../index.mjs');

test('シークレット未設定なら入口ごと無効（503）', async () => {
  const r = await handler({
    requestContext: { http: { method: 'POST', path: '/' } },
    headers: {},
    body: '{}',
  });
  assert.equal(r.statusCode, 503);
});