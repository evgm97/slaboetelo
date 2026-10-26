import { readFile } from 'node:fs/promises';

const allowedEnvNames = new Set([
  'RITM_TELEGRAM_BOT_TOKEN',
  'RITM_TELEGRAM_WEBHOOK_SECRET',
  'RITM_TELEGRAM_BOT_USERNAME',
  'RITM_PUBLIC_URL'
]);

function parseArgs(args) {
  let envFile = '';
  let replaceExisting = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--env-file') {
      envFile = args[index + 1] || '';
      index++;
    } else if (args[index] === '--replace-existing') replaceExisting = true;
    else throw new Error('Неизвестный параметр. Используй --env-file и при необходимости --replace-existing.');
  }
  return { envFile, replaceExisting };
}

function parseEnvFile(source) {
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match || !allowedEnvNames.has(match[1])) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

async function telegramApi(token, method, payload) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new Error(`Не удалось связаться с Telegram Bot API (${method}).`);
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true) throw new Error(`Telegram Bot API отклонил запрос ${method} (HTTP ${response.status}).`);
  return result.result;
}

try {
  const { envFile, replaceExisting } = parseArgs(process.argv.slice(2));
  const fileValues = envFile ? parseEnvFile(await readFile(envFile, 'utf8')) : {};
  const token = String(fileValues.RITM_TELEGRAM_BOT_TOKEN || process.env.RITM_TELEGRAM_BOT_TOKEN || '').trim();
  const secret = String(fileValues.RITM_TELEGRAM_WEBHOOK_SECRET || process.env.RITM_TELEGRAM_WEBHOOK_SECRET || '').trim();
  const origin = String(fileValues.RITM_PUBLIC_URL || process.env.RITM_PUBLIC_URL || 'https://slaboetelo.ru').trim();
  const parsedOrigin = new URL(origin);
  if (!token || token.length > 256) throw new Error('В защищённом env-файле не задан RITM_TELEGRAM_BOT_TOKEN.');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw new Error('В защищённом env-файле нет допустимого RITM_TELEGRAM_WEBHOOK_SECRET.');
  if (parsedOrigin.protocol !== 'https:' || parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash) throw new Error('RITM_PUBLIC_URL должен быть корневым HTTPS-адресом сайта.');
  const webhookUrl = `${parsedOrigin.origin}/api/telegram/webhook`;
  const current = await telegramApi(token, 'getWebhookInfo', {});
  if (current.url && current.url !== webhookUrl && !replaceExisting) {
    throw new Error('У бота уже настроен другой webhook. Ничего не менял; проверь старую интеграцию. Флаг --replace-existing заменит её только после твоего явного решения.');
  }
  await telegramApi(token, 'setWebhook', { url: webhookUrl, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: false });
  const confirmed = await telegramApi(token, 'getWebhookInfo', {});
  if (confirmed.url !== webhookUrl) throw new Error('Telegram не подтвердил адрес webhook.');
  console.log(`Webhook настроен и проверен: ${webhookUrl}`);
  console.log('Токен и секрет не выводились. Перезапусти службу приложения и проверь ответ бота командой /start.');
} catch (error) {
  console.error(error?.message || 'Не удалось настроить webhook Telegram.');
  process.exitCode = 1;
}
