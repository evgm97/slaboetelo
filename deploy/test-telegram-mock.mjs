// TEST ONLY: load with `node --import deploy/test-telegram-mock.mjs server.mjs`.
// It intercepts Telegram Bot API requests; no Telegram token or network call is used.
import { appendFile } from 'node:fs/promises';

const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'api.telegram.org') {
    const method = url.pathname.split('/').pop();
    if (method === 'getWebhookInfo') {
      return new Response(JSON.stringify({ ok: true, result: { url: 'https://slaboetelo.ru/api/telegram/webhook' } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (method === 'sendMessage') {
      if (process.env.MOCK_TELEGRAM_LOG) {
        await appendFile(process.env.MOCK_TELEGRAM_LOG, `${JSON.stringify(JSON.parse(options.body || '{}'))}\n`);
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
  }
  return nativeFetch(input, options);
};
