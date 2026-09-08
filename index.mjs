import https from 'https';

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_USER_ID,
  // microduck の日次介護サマリーを受け取る Webhook の共有シークレット。
  // 未設定なら入口ごと無効（誰でも家族LINEに送れる状態にしない、fail closed）。
  REPORT_WEBHOOK_SECRET,
  EVENT_WEBHOOK_SECRET,
} = process.env;

function sendLineMessage(message) {
  return new Promise((resolve, reject) => {
    if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_USER_ID) {
      return reject(new Error('Required LINE environment variables are not set.'));
    }

    const body = JSON.stringify({
      to: LINE_USER_ID,
      messages: [{ type: 'text', text: message }],
    });

    const options = {
      hostname: 'api.line.me',
      path: '/v2/bot/message/push',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // 成功時も応答コードを残す。失敗時しか記録が無いと、
          // 「送ったつもりで届いていない」を後から切り分けられない。
          console.log(`LINE API ok: ${res.statusCode}`);
          resolve(data);
        } else {
          reject(new Error(`LINE API error: ${res.statusCode} ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildAlexaResponse(speechText, shouldEndSession = true) {
  return {
    version: '1.0',
    response: {
      outputSpeech: {
        type: 'PlainText',
        text: speechText,
      },
      shouldEndSession,
    },
  };
}

/**
 * 文字列を定数時間で比較する。長さの違いだけでも情報が漏れるため、
 * 先に長さを揃えず、常に全体を走査する。
 */
function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

const SUMMARY_NUMBER_FIELDS = [
  'pace_sessions', 'pace_duration_s', 'pace_distance_m', 'pace_beats',
  'reminders', 'checkins', 'nurse_calls_ok', 'nurse_calls_failed', 'commands',
];

/**
 * microduck が送る daily_summary ペイロードを検証する。
 * 壊れた入力は 400 で落とす（受け取ったことにしない＝ブリッジがリトライできる）。
 * 戻り値は検証済みオブジェクト、違反時は null。
 */
export function parseDailySummary(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.type !== 'daily_summary') return null;
  if (typeof body.date !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(body.date)) return null;
  for (const field of SUMMARY_NUMBER_FIELDS) {
    const value = body[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  }
  if (Object.hasOwn(body, 'call_status')) {
    const status = body.call_status;
    const counts = ['acknowledged', 'pending', 'unknown', 'not_configured', 'human_unknown'];
    if (!status || typeof status !== 'object' || Array.isArray(status) || status.version !== 1) return null;
    if (Object.keys(status).length !== counts.length + 1) return null;
    if (counts.some(key => !Number.isSafeInteger(status[key]) || status[key] < 0)) return null;
    const total = status.acknowledged + status.pending + status.unknown + status.not_configured;
    if (!Number.isSafeInteger(total) || status.human_unknown !== total) return null;
  }
  return body;
}

/**
 * 検証済みの daily_summary を家族向けの定型文にする（決定論的・GenAIなし）。
 * 数値をそのまま出すだけ。記録が無い日（0）を「無かった」と解釈して書かない。
 */
export function formatDailySummary(report) {
  const minutes = Math.round((report.pace_duration_s / 60) * 10) / 10;
  const meters = Math.round(report.pace_distance_m);
  const status = report.call_status;
  const callLines = status ? [
    `ナースコール記録: システム受付${status.acknowledged}件・処理中${status.pending}件・結果不明${status.unknown}件・呼び出し先未設定${status.not_configured}件`,
    `人の確認: 未確認${status.human_unknown}件（確認情報の連携なし）`,
  ] : [
    `ナースコール記録（旧形式）: システム応答あり${report.nurse_calls_ok}件・送信完了を確認できず${report.nurse_calls_failed}件`,
    '人の確認: 不明（旧形式に確認情報なし）',
  ];
  return [
    `【介護サマリー】${report.date}`,
    `歩行: ${report.pace_sessions}回・計${minutes}分・約${meters}m`,
    `リマインド: ${report.reminders}回（うち安否確認${report.checkins}回）`,
    ...callLines,
    '※件数は再送を含む記録の集計で、現在の対応状況ではありません。',
    '※受付は人の対応完了を意味しません。記録0件でも異常なしとは判断できません。',
    `その他コマンド: ${report.commands}回`,
  ].join('\n');
}

const EVENT_TYPES = new Set(['fall_detected', 'battery_low', 'duck_unhealthy', 'duck_offline', 'duck_online']);

export function parseMicroduckEvent(rawBody) {
  let body;
  try { body = JSON.parse(rawBody); } catch { return null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!EVENT_TYPES.has(body.type) || typeof body.ts !== 'string' || !body.ts) return null;
  if (body.source !== 'duckbridge' || !body.detail || typeof body.detail !== 'object' || Array.isArray(body.detail)) return null;
  return body;
}

export function formatMicroduckEvent(event) {
  const labels = {
    fall_detected: '転倒を検知しました。まず本人の状態を確認してください。',
    battery_low: 'Microduckのバッテリーが低下しています。',
    duck_unhealthy: 'Microduckの制御状態が正常ではありません。',
    duck_offline: 'Microduckが応答していません。',
    duck_online: 'Microduckが再接続しました。',
  };
  return `【Microduck通知】\n${labels[event.type]}`;
}

async function handleEventWebhook(event) {
  const reply = (statusCode, body) => ({
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!EVENT_WEBHOOK_SECRET) {
    console.error('EVENT_WEBHOOK_SECRET is not set; event entry is disabled.');
    return reply(503, { error: 'event webhook disabled' });
  }
  const provided = event.headers?.['x-event-secret'];
  if (!provided || !timingSafeEqualString(provided, EVENT_WEBHOOK_SECRET)) {
    console.warn('Event webhook rejected: bad or missing secret.');
    return reply(401, { error: 'unauthorized' });
  }
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
    : (event.body ?? '');
  const microduckEvent = parseMicroduckEvent(rawBody);
  if (!microduckEvent) {
    console.warn('Event webhook rejected: invalid microduck event payload.');
    return reply(400, { error: 'invalid microduck event payload' });
  }
  try {
    await sendLineMessage(formatMicroduckEvent(microduckEvent));
    return reply(200, { ok: true, type: microduckEvent.type });
  } catch (err) {
    console.error('Failed to push Microduck event to LINE:', err);
    return reply(502, { error: 'LINE push failed' });
  }
}

/**
 * microduck ブリッジからの日次介護サマリー Webhook を処理する。
 *
 * 公開URLなので、共有シークレットが一致しない限り LINE に送らない。
 * シークレット未設定のときは入口ごと無効（fail closed）。
 * LINE 送信に失敗したら 502 を返す —— ブリッジ側は同じ分（同じ時刻分）
 * の間だけリトライするため、成功するまで届き続ける。
 *
 * @param {object} event - Lambda 関数URL のイベント
 */
async function handleReportWebhook(event) {
  const reply = (statusCode, body) => ({
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!REPORT_WEBHOOK_SECRET) {
    console.error('REPORT_WEBHOOK_SECRET is not set; report entry is disabled.');
    return reply(503, { error: 'report webhook disabled' });
  }

  // ヘッダーはクライアントによって大文字小文字が揺れる。関数URLは小文字化するが、
  // クエリ文字列も受け付ける（Webhook のヘッダーを設定できない送り手のため）。
  const provided = event.headers?.['x-report-secret']
    ?? event.queryStringParameters?.secret;

  if (!provided || !timingSafeEqualString(provided, REPORT_WEBHOOK_SECRET)) {
    console.warn('Report webhook rejected: bad or missing secret.');
    return reply(401, { error: 'unauthorized' });
  }

  // 関数URLは content-type 次第で body を base64 化することがある。
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
    : (event.body ?? '');

  const report = parseDailySummary(rawBody);
  if (!report) {
    console.warn('Report webhook rejected: payload is not a valid daily_summary.');
    return reply(400, { error: 'invalid daily_summary payload' });
  }

  try {
    await sendLineMessage(formatDailySummary(report));
    return reply(200, { ok: true, date: report.date });
  } catch (err) {
    console.error('Failed to push daily summary to LINE:', err);
    return reply(502, { error: 'LINE push failed' });
  }
}

export const handler = async (event) => {
  console.log('Received event:', JSON.stringify(event, null, 2));

  // --- microduck 日次介護サマリーの Webhook ---------------------------------
  // Lambda 関数URL 経由で来るため、Alexa のイベントとは形が違う
  // (requestContext を持ち、request.type を持たない)。
  if (event?.requestContext?.http) {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
      : (event.body ?? '');
    let parsedBody = null;
    try { parsedBody = JSON.parse(rawBody); } catch { /* report handler returns 400 */ }
    // 既知のイベント、またはイベント用ヘッダーが明示された場合だけ
    // イベント入口へ振り分ける。未知の type を日次サマリー入口に混ぜず、
    // 既存の report webhook の「daily_summary 以外は400」も維持する。
    if (
      parsedBody?.type
      && parsedBody.type !== 'daily_summary'
      && (EVENT_TYPES.has(parsedBody.type) || event.headers?.['x-event-secret'])
    ) {
      return handleEventWebhook(event);
    }
    return handleReportWebhook(event);
  }

  const requestType = event?.request?.type;

  if (!requestType) {
    console.warn('No request type found in event:', JSON.stringify(event));
    return buildAlexaResponse('リクエストの種類が不明です。');
  }

  if (requestType === 'LaunchRequest') {
    return buildAlexaResponse(
      '看護師メッセージです。送りたいメッセージを言ったあと「送って」と言ってください。',
      false
    );
  }

  if (requestType === 'IntentRequest') {
    const intentName = event.request.intent?.name;

    if (intentName === 'LineMessageIntent') {
      const dialogState = event.request.dialogState;

      if (dialogState !== 'COMPLETED') {
        return {
          version: '1.0',
          response: {
            directives: [{ type: 'Dialog.Delegate' }],
            shouldEndSession: false,
          },
        };
      }

      const message = event.request.intent?.slots?.message?.value;
      if (!message) {
        return buildAlexaResponse('メッセージが聞き取れませんでした。もう一度お試しください。');
      }
      try {
        await sendLineMessage(message);
        return buildAlexaResponse('LINEでメッセージを送信しました。');
      } catch (err) {
        console.error('Failed to send LINE message:', err);
        return buildAlexaResponse('申し訳ありません。LINEへの送信に失敗しました。もう一度お試しください。');
      }
    }

    if (intentName === 'AMAZON.StopIntent' || intentName === 'AMAZON.CancelIntent') {
      return buildAlexaResponse('看護師メッセージを終了します。');
    }

    if (intentName === 'AMAZON.HelpIntent') {
      return buildAlexaResponse(
        '送りたいメッセージを言ったあと「送って」と言ってください。例えば「明日10時に来てください、送って」のように話しかけてください。',
        false
      );
    }

    return buildAlexaResponse('そのコマンドは認識できませんでした。もう一度お試しください。');
  }

  if (requestType === 'SessionEndedRequest') {
    console.log('Session ended:', event.request.reason);
    return {};
  }

  return buildAlexaResponse('リクエストを処理できませんでした。');
};
