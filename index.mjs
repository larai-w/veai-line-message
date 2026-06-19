import https from 'https';

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_USER_ID,
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

export const handler = async (event) => {
  console.log('Received event:', JSON.stringify(event, null, 2));

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
