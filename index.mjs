import https from 'https';

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_USER_ID,
  // microduck の日次介護サマリーを受け取る Webhook の共有シークレット。
  // 未設定なら入口ごと無効（誰でも家族LINEに送れる状態にしない、fail closed）。
  REPORT_WEBHOOK_SECRET,
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
function parseDailySummary(rawBody) {
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
  return body;
}

/**
 * 検証済みの daily_summary を家族向けの定型文にする（決定論的・GenAIなし）。
 * 数値をそのまま出すだけ。記録が無い日（0）を「無かった」と解釈して書かない。
 */
export function formatDailySummary(report) {
  const minutes = Math.round((report.pace_duration_s / 60) * 10) / 10;
  const meters = Math.round(report.pace_distance_m);
  return [
    `【介護サマリー】${report.date}`,
    `歩行: ${report.pace_sessions}回・計${minutes}分・約${meters}m`,
    `リマインド: ${report.reminders}回（うち安否確認${report.checkins}回）`,
    `ナースコール: 成功${report.nurse_calls_ok}回・失敗${report.nurse_calls_failed}回`,
    `その他コマンド: ${report.commands}回`,
  ].join('\n');
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
