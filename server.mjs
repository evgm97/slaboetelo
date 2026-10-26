import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, mkdir, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeOpenFoodFactsProduct, openFoodFactsBarcodeUrl, openFoodFactsSearchBody, openFoodFactsSearchUrl } from './nutrition-source.mjs';

const scrypt = promisify(scryptCallback);
const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.RITM_DATA_DIR || path.join(root, 'data'));
const storeFile = path.join(dataDir, 'accounts.json');
const avatarDir = path.join(dataDir, 'avatars');
const maxAvatarBytes = 1024 * 1024;
const nutritionCatalogFile = path.join(root, 'data', 'nutrition-catalog.json');
const port = Number(process.env.PORT || 8766);
const host = process.env.RITM_HOST || (process.env.NODE_ENV === 'production' ? '127.0.0.1' : '127.0.0.1');
const secureCookie = process.env.RITM_SECURE_COOKIE === '1';
const cookieName = 'ritm_session';
const sessionMaxAge = 30 * 24 * 60 * 60 * 1000;
const maxBodyBytes = 2 * 1024 * 1024;
const openFoodFactsUserAgent = (process.env.RITM_OFF_USER_AGENT || 'SlaboeTelo/1.0 (http://localhost:8766)').slice(0, 200);
const adminLogin = String(process.env.RITM_ADMIN_LOGIN || '').trim().toLowerCase();
const telegramBotToken = String(process.env.RITM_TELEGRAM_BOT_TOKEN || '').trim();
const telegramWebhookSecret = String(process.env.RITM_TELEGRAM_WEBHOOK_SECRET || '').trim();
const telegramBotUsernameInput = String(process.env.RITM_TELEGRAM_BOT_USERNAME || 'SlaboeTeloFitnessBot').trim().replace(/^@/, '');
const telegramBotUsername = /^[A-Za-z0-9_]{5,32}$/.test(telegramBotUsernameInput) ? telegramBotUsernameInput : 'SlaboeTeloFitnessBot';
const telegramPublicOrigin = String(process.env.RITM_PUBLIC_URL || 'https://slaboetelo.ru').trim().replace(/\/+$/, '');
const telegramPublicUrl = (() => {
  try {
    const value = new URL(telegramPublicOrigin);
    return value.protocol === 'https:' && value.pathname === '/' && !value.search && !value.hash ? value.origin : '';
  } catch { return ''; }
})();
const telegramConfigured = Boolean(telegramBotToken && telegramWebhookSecret && /^[A-Za-z0-9_-]{1,256}$/.test(telegramWebhookSecret) && telegramPublicUrl);
const telegramWebhookUrl = telegramPublicUrl ? `${telegramPublicUrl}/api/telegram/webhook` : '';
const telegramCategories = ['coach', 'workouts', 'programs', 'nutrition', 'account'];
const programNames = new Map(Object.entries({
  '01': 'Старт — всё тело', '02': 'Возвращение в форму', '03': 'Верх / низ — 3 дня', '04': 'Верх / низ — 4 дня',
  '05': 'Push / Pull / Legs — 3 дня', '06': 'Push / Pull / Legs — 6 дней', '07': 'Гипертрофия — рост мышц', '08': 'Сила — базовые упражнения',
  '09': 'Щадящая нагрузка на спину', '10': 'Верх / низ с опорой', '11': 'Комфортные тренировки для коленей', '12': 'Бережно к плечам',
  '13': 'Домашняя — без оборудования', '14': 'Домашняя — с гантелями', '15': 'Экспресс — 30 минут'
}));
const openFoodFactsCache = new Map();
const openFoodFactsRequests = { search: [], barcode: [] };
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };
const publicFiles = new Set(['/index.html', '/admin.html', '/program-library.js', '/coach.js', '/privacy.html']);
const publicAssetExtensions = new Set(['.jpeg', '.jpg', '.png']);

let state;
let nutritionCatalog = [];
let exerciseNames = new Map([['legpress', 'Жим ногами'], ['bridge', 'Ягодичный мост'], ['lateral', 'Отведение гантелей в стороны'], ['treadmill', 'Ходьба на дорожке'], ['chestpress', 'Жим в тренажёре'], ['row', 'Тяга блока к поясу'], ['curl', 'Сгибание ног в тренажёре'], ['pulldown', 'Тяга верхнего блока']]);
let writeQueue = Promise.resolve();
const attempts = new Map();
const coachAttempts = new Map();
const telegramLinkAttempts = new Map();
let telegramWebhookStatusCache = { checkedAt: 0, ready: false };
let telegramOutboxDraining = false;
let telegramRetryTimer = null;

function emptyState() { return { users: {}, sessions: {}, adminAudit: [], coachInvitations: {}, coachLinks: {}, coachApplications: {}, coachAudit: [], notifications: {}, telegramAccounts: {}, telegramLinkCodes: {}, telegramOutbox: [], telegramUpdates: {} }; }
function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function normalizeTelegramPreferences(input) {
  const source = plainObject(input) ? input : {};
  return Object.fromEntries(telegramCategories.map(category => [category, source[category] === true]));
}
function telegramCategoryForType(type) {
  if (['coach-link', 'coach-message', 'coach-recommendation', 'recommendation-ack'].includes(type)) return 'coach';
  if (['workout-assignment', 'workout-decision', 'workout-check-in', 'workout-check-in-reply', 'client-workout-complete'].includes(type)) return 'workouts';
  if (['program-assignment', 'program-decision'].includes(type)) return 'programs';
  if (['nutrition-goals', 'nutrition-goals-decision'].includes(type)) return 'nutrition';
  if (typeof type === 'string' && (type.startsWith('trainer-application') || type.startsWith('trainer-role-'))) return 'account';
  return '';
}
function telegramNotificationText(type) {
  const messages = {
    'coach-link': 'Изменился статус связи тренера и клиента.',
    'coach-message': 'У тебя новое сообщение в приложении.',
    'coach-recommendation': 'Тренер добавил рекомендацию.',
    'recommendation-ack': 'Клиент отметил рекомендацию.',
    'workout-assignment': 'Тренер предложил тренировку.',
    'workout-decision': 'Клиент ответил на предложение тренировки.',
    'workout-check-in': 'Клиент оставил отзыв о тренировке.',
    'workout-check-in-reply': 'Тренер ответил на отзыв о тренировке.',
    'client-workout-complete': 'Клиент завершил тренировку.',
    'program-assignment': 'Тренер предложил программу.',
    'program-decision': 'Клиент ответил на предложение программы.',
    'nutrition-goals': 'Тренер предложил цели питания.',
    'nutrition-goals-decision': 'Клиент ответил на предложение целей питания.',
    'trainer-application': 'Есть новое событие по заявке на тренерство.',
    'trainer-application-approved': 'Заявка на тренерство одобрена.',
    'trainer-application-rejected': 'По заявке на тренерство есть ответ.',
    'trainer-role-granted': 'Для аккаунта изменился доступ.',
    'trainer-role-revoked': 'Для аккаунта изменился доступ.'
  };
  return `Слабое тело: ${messages[type] || 'Новое уведомление.'} Открой приложение, чтобы посмотреть.`;
}
function boundedNumber(value, max = 10000) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= max ? Math.round(number * 10) / 10 : 0;
}
function nullableNumber(value, max = 10000) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= max ? Math.round(number * 10) / 10 : null;
}
function allowOpenFoodFactsRequest(kind, limit) {
  const now = Date.now();
  const requests = openFoodFactsRequests[kind].filter(time => time > now - 60_000);
  if (requests.length >= limit) { openFoodFactsRequests[kind] = requests; return false; }
  requests.push(now);
  openFoodFactsRequests[kind] = requests;
  return true;
}
async function cachedOpenFoodFacts(key, loader, ttlMs = 10 * 60_000) {
  const cached = openFoodFactsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    openFoodFactsCache.delete(key);
    openFoodFactsCache.set(key, cached);
    return cached.value;
  }
  openFoodFactsCache.delete(key);
  const value = await loader();
  openFoodFactsCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  while (openFoodFactsCache.size > 120) openFoodFactsCache.delete(openFoodFactsCache.keys().next().value);
  return value;
}
async function fetchOpenFoodFacts(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: 'application/json', 'User-Agent': openFoodFactsUserAgent, ...(options.headers || {}) },
    signal: AbortSignal.timeout(8000)
  });
  if (response.status === 429 || response.status === 503) throw Object.assign(new Error('Каталог временно ограничил запросы'), { status: 503 });
  if (!response.ok) throw Object.assign(new Error('Каталог временно недоступен'), { status: 503 });
  return response.json();
}
function normalizeNutrition(input) {
  const source = plainObject(input) ? input : {};
  const goals = plainObject(source.goals) ? source.goals : {};
  const imageKeys = new Set(['chicken', 'rice', 'oats', 'banana', 'egg', 'dairy', 'vegetable', 'shake', 'custom']);
  const nutritionSource = value => ['openfoodfacts', 'rospotrebnadzor'].includes(value) ? value : 'user';
  const food = item => {
    if (!plainObject(item) || typeof item.id !== 'string' || typeof item.name !== 'string' || !item.name.trim()) return null;
    return {
      id: item.id.slice(0, 60), name: item.name.trim().slice(0, 80), brand: String(item.brand || '').trim().slice(0, 60), barcode: String(item.barcode || '').replace(/\D/g, '').slice(0, 32),
        originalName: String(item.originalName || item.name).trim().slice(0, 120), category: String(item.category || '').trim().slice(0, 80), quantity: String(item.quantity || '').trim().slice(0, 40), unit: item.unit === 'ml' ? 'ml' : 'g', updatedAt: String(item.updatedAt || '').slice(0, 40),
        kcal: nullableNumber(item.kcal), protein: nullableNumber(item.protein, 1000), fat: nullableNumber(item.fat, 1000), carbs: nullableNumber(item.carbs, 1000), fiber: nullableNumber(item.fiber, 1000),
        source: nutritionSource(item.source), sourceId: String(item.sourceId || item.barcode || '').slice(0, 80),
      imageKey: imageKeys.has(item.imageKey) ? item.imageKey : 'custom', kind: item.kind === 'dish' ? 'dish' : 'product',
      ingredients: Array.isArray(item.ingredients) ? item.ingredients.slice(0, 40).map(ingredient => ({
        name: String(ingredient?.name || '').slice(0, 80), grams: boundedNumber(ingredient?.grams, 5000),
        source: nutritionSource(ingredient?.source),
        sourceId: String(ingredient?.sourceId || '').slice(0, 80)
      })).filter(ingredient => ingredient.name) : []
    };
  };
  const foods = Array.isArray(source.foods) ? source.foods.slice(-200).map(food).filter(Boolean) : [];
  const entries = {};
  if (plainObject(source.entries)) {
    for (const [date, items] of Object.entries(source.entries).slice(-400)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(items)) continue;
      entries[date] = items.slice(-500).filter(item => plainObject(item) && typeof item.id === 'string' && typeof item.name === 'string').map(item => ({
        id: item.id.slice(0, 80), foodId: String(item.foodId || '').slice(0, 60), name: item.name.slice(0, 80), brand: String(item.brand || '').slice(0, 60),
        meal: ['breakfast', 'lunch', 'dinner', 'snacks'].includes(item.meal) ? item.meal : 'snacks', kind: item.kind === 'dish' ? 'dish' : 'product',
        imageKey: imageKeys.has(item.imageKey) ? item.imageKey : 'custom', demo: Boolean(item.demo), grams: boundedNumber(item.grams, 5000), kcal: boundedNumber(item.kcal, 50000),
        protein: nullableNumber(item.protein, 5000), fat: nullableNumber(item.fat, 5000), carbs: nullableNumber(item.carbs, 5000), fiber: nullableNumber(item.fiber, 5000),
        source: nutritionSource(item.source), sourceId: String(item.sourceId || '').slice(0, 80),
        originalName: String(item.originalName || item.name).trim().slice(0, 120), category: String(item.category || '').trim().slice(0, 80), quantity: String(item.quantity || '').trim().slice(0, 40), unit: item.unit === 'ml' ? 'ml' : 'g', updatedAt: String(item.updatedAt || '').slice(0, 40),
        kcalPer100: nullableNumber(item.kcalPer100), proteinPer100: nullableNumber(item.proteinPer100, 1000), fatPer100: nullableNumber(item.fatPer100, 1000), carbsPer100: nullableNumber(item.carbsPer100, 1000), fiberPer100: nullableNumber(item.fiberPer100, 1000),
        createdAt: typeof item.createdAt === 'string' ? item.createdAt.slice(0, 40) : ''
      }));
    }
  }
  return { goals: { kcal: boundedNumber(goals.kcal), protein: boundedNumber(goals.protein, 2000), fat: boundedNumber(goals.fat, 2000), carbs: boundedNumber(goals.carbs, 2000) }, foods, entries };
}
const bodyMeasurementLimits = { weight: 500, chest: 250, waist: 250, hips: 300, arm: 120, forearm: 100, thigh: 150, calf: 100 };
function normalizeBodyMeasurementValues(input) {
  if (!plainObject(input)) return {};
  return Object.fromEntries(Object.entries(bodyMeasurementLimits).flatMap(([key, max]) => {
    const value = input[key];
    if (value === '' || value === null || value === undefined) return [];
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= max ? [[key, Math.round(number * 10) / 10]] : [];
  }));
}
function validDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function normalizeBodyMeasurements(input) {
  if (!Array.isArray(input)) return [];
  return input.filter(plainObject).flatMap(item => {
    const id = typeof item.id === 'string' ? item.id.slice(0, 80) : '';
    if (!id || !validDateKey(item.date)) return [];
    const values = normalizeBodyMeasurementValues(item.values);
    if (!Object.keys(values).length) return [];
    const revisions = (Array.isArray(item.revisions) ? item.revisions : []).slice(-20).flatMap(revision => {
      if (!plainObject(revision) || !validDateKey(revision.date)) return [];
      const previousValues = normalizeBodyMeasurementValues(revision.values);
      if (!Object.keys(previousValues).length) return [];
      return [{ date: revision.date, values: previousValues, changedAt: typeof revision.changedAt === 'string' ? revision.changedAt.slice(0, 40) : '' }];
    });
    return [{ id, date: item.date, values, createdAt: typeof item.createdAt === 'string' ? item.createdAt.slice(0, 40) : '', updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt.slice(0, 40) : '', revisions }];
  }).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
}
const defaultVisibleAppTabs = ['home', 'workouts', 'nutrition', 'progress', 'program', 'more'];
function normalizeAppSettings(input) {
  const source = plainObject(input) && Array.isArray(input.visibleTabs) ? input.visibleTabs : defaultVisibleAppTabs;
  const selected = new Set(source.filter(tab => defaultVisibleAppTabs.includes(tab)));
  selected.add('more');
  if (selected.size < 2) selected.add('home');
  return { visibleTabs: defaultVisibleAppTabs.filter(tab => selected.has(tab)) };
}
function normalizeData(input) {
  if (!plainObject(input)) throw new Error('Данные профиля имеют неверный формат');
  const profile = plainObject(input.profile) ? input.profile : {};
  const customPrograms = Array.isArray(input.customPrograms) ? input.customPrograms.slice(0, 100).filter(plainObject).map(program => ({
    id: typeof program.id === 'string' && /^cp-[0-9a-f-]{36}$/i.test(program.id) ? program.id : '',
    name: String(program.name || '').trim().slice(0, 60),
    description: String(program.description || '').trim().slice(0, 240),
    schedule: typeof program.schedule === 'string' ? program.schedule.slice(0, 80) : '',
    exerciseIds: Array.isArray(program.exerciseIds) ? [...new Set(program.exerciseIds.filter(id => typeof id === 'string').map(id => id.slice(0, 80)))].slice(0, 60) : [],
    exerciseSpecs: Array.isArray(program.exerciseSpecs) ? program.exerciseSpecs.slice(0, 60).filter(plainObject).map(spec => ({ exerciseId: String(spec.exerciseId || '').slice(0, 80), sets: String(spec.sets || '3').slice(0, 12), reps: String(spec.reps || '8–12').slice(0, 20), rest: String(spec.rest || '90 сек').slice(0, 20) })) : []
  })).filter(program => program.id && program.name && program.exerciseIds.length) : [];
  const active = input.activeSession;
  const validActive = plainObject(active) && typeof active.id === 'string' && Number.isInteger(active.plan) && active.plan >= 0 && active.plan < 200 && Array.isArray(active.done);
  const weeklySessions = Number(input.targets?.weeklySessions);
  const availableProgramId = id => typeof id === 'string' && (/^\d{2}$/.test(id) || customPrograms.some(program => program.id === id));
  const currentProgramId = availableProgramId(input.programId) ? input.programId : '';
  const completed = plainObject(input.completed) ? input.completed : {};
  const myProgramIds = [...new Set((Array.isArray(input.myProgramIds) ? input.myProgramIds : Array.isArray(completed.__myProgramIds) ? completed.__myProgramIds : [...customPrograms.map(program => program.id), currentProgramId])
    .filter(availableProgramId))].slice(0, 100);
  const activeProgramId = currentProgramId || myProgramIds[0] || '';
  const programProgress = {};
  if (plainObject(input.programProgress)) {
    for (const [programId, slots] of Object.entries(input.programProgress).slice(0, 100)) {
      if (!availableProgramId(programId) || !plainObject(slots)) continue;
      programProgress[programId] = {};
      for (const [slot, progress] of Object.entries(slots).slice(0, 100)) {
        const match = slot.match(/^([1-4]):(\d{1,3})$/);
        const planIndex = match ? Number(match[2]) : -1;
        if (!match || planIndex < 0 || planIndex >= 200 || !plainObject(progress) || !Array.isArray(progress.completedExerciseIds)) continue;
        programProgress[programId][slot] = { completedExerciseIds: [...new Set(progress.completedExerciseIds.filter(id => typeof id === 'string').map(id => id.slice(0, 80)))].slice(0, 60) };
      }
    }
  }
  return {
    sessions: Array.isArray(input.sessions) ? input.sessions.filter(plainObject).slice(-3000) : [],
    entries: plainObject(input.entries) ? Object.fromEntries(Object.entries(input.entries).filter(([, items]) => Array.isArray(items)).map(([id, items]) => [id.slice(0, 80), items.filter(plainObject).slice(-5000)])) : {},
    profile: { name: String(profile.name || '').slice(0, 60), weight: String(profile.weight || '').slice(0, 20), goal: String(profile.goal || 'Набор мышечной массы').slice(0, 100) },
    appSettings: normalizeAppSettings(input.appSettings),
    bodyMeasurements: normalizeBodyMeasurements(input.bodyMeasurements),
    customPrograms,
    targets: { weeklySessions: Number.isInteger(weeklySessions) && weeklySessions >= 1 && weeklySessions <= 14 ? weeklySessions : 0 },
    programId: activeProgramId,
    myProgramIds,
    programProgress: plainObject(input.programProgress) ? programProgress : null,
    week: [1, 2, 3, 4].includes(Number(input.week)) ? Number(input.week) : 1,
    completed: { ...completed, __myProgramIds: myProgramIds.slice() },
    activeSession: validActive ? { id: active.id.slice(0, 100), plan: active.plan, programId: typeof active.programId === 'string' && customPrograms.some(program => program.id === active.programId) ? active.programId : '', week: [1, 2, 3, 4].includes(Number(active.week)) ? Number(active.week) : 1, startedAt: typeof active.startedAt === 'string' ? active.startedAt.slice(0, 40) : new Date().toISOString(), done: active.done.filter(id => typeof id === 'string').slice(0, 100), exerciseIds: Array.isArray(active.exerciseIds) ? [...new Set(active.exerciseIds.filter(id => typeof id === 'string').map(id => id.slice(0, 80)))].slice(0, 60) : [], restTimer: plainObject(active.restTimer) ? { durationSeconds: Math.min(1800, Math.max(30, Number(active.restTimer.durationSeconds) || 120)), endsAt: typeof active.restTimer.endsAt === 'string' ? active.restTimer.endsAt.slice(0, 40) : '', pausedRemainingSeconds: Math.min(1800, Math.max(0, Number(active.restTimer.pausedRemainingSeconds) || 0)), completedAt: typeof active.restTimer.completedAt === 'string' ? active.restTimer.completedAt.slice(0, 40) : '', notifiedAt: typeof active.restTimer.notifiedAt === 'string' ? active.restTimer.notifiedAt.slice(0, 40) : '' } : null } : null,
    nutrition: normalizeNutrition(input.nutrition)
  };
}
function avatarKeyFor(login) {
  const key = state.users[login]?.data?.profile?.avatarKey;
  return typeof key === 'string' && /^[0-9a-f-]{36}$/.test(key) ? key : '';
}
async function readAvatarBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxAvatarBytes) throw Object.assign(new Error('Аватар должен быть не больше 1 МБ'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function validAvatarJpeg(buffer) {
  if (buffer.length < 16 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer.at(-2) !== 0xff || buffer.at(-1) !== 0xd9) return false;
  let offset = 2;
  let dimensions = null, sawScan = false;
  while (offset < buffer.length - 1) {
    if (buffer[offset++] !== 0xff) return false;
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xd9) return sawScan && Boolean(dimensions) && offset === buffer.length;
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return false;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return false;
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      if (length < 7) return false;
      const height = buffer.readUInt16BE(offset + 3), width = buffer.readUInt16BE(offset + 5);
      if (!width || !height || width > 1024 || height > 1024 || width * height > 1_048_576) return false;
      dimensions = { width, height };
    }
    if (marker === 0xda) {
      if (!dimensions || length < 6) return false;
      sawScan = true;
      offset += length;
      let foundNextMarker = false;
      while (offset < buffer.length - 1) {
        if (buffer[offset++] !== 0xff) continue;
        const nextMarkerStart = offset - 1;
        while (buffer[offset] === 0xff) offset++;
        const nextMarker = buffer[offset];
        if (nextMarker === 0x00 || (nextMarker >= 0xd0 && nextMarker <= 0xd7)) { offset++; continue; }
        offset = nextMarkerStart;
        foundNextMarker = true;
        break;
      }
      if (!foundNextMarker) return false;
      continue;
    }
    offset += length;
  }
  return false;
}
async function removeUnusedAvatar(key) {
  if (!key || Object.values(state.users).some(user => user.data?.profile?.avatarKey === key)) return;
  try { await unlink(path.join(avatarDir, `${key}.jpg`)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function writeState() {
  const snapshot = JSON.stringify(state);
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const temp = `${storeFile}.${process.pid}.tmp`;
    await writeFile(temp, snapshot, { mode: 0o600 });
    await rename(temp, storeFile);
    if (telegramConfigured) queueMicrotask(() => { void drainTelegramOutbox(); });
  });
  return writeQueue;
}
async function telegramApi(method, payload = {}) {
  if (!telegramBotToken) return { ok: false, status: 0 };
  try {
    const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(7000)
    });
    const result = await response.json().catch(() => null);
    return {
      ok: response.ok && result?.ok === true,
      status: Number(result?.error_code) || response.status,
      retryAfter: Number(result?.parameters?.retry_after) || 0,
      result: result?.result
    };
  } catch { return { ok: false, status: 0 }; }
}
async function telegramWebhookIsReady() {
  if (!telegramConfigured) return false;
  if (Date.now() - telegramWebhookStatusCache.checkedAt < 5_000) return telegramWebhookStatusCache.ready;
  const result = await telegramApi('getWebhookInfo');
  telegramWebhookStatusCache = { checkedAt: Date.now(), ready: result.ok && result.result?.url === telegramWebhookUrl };
  return telegramWebhookStatusCache.ready;
}
function telegramLinkRateAllowed(req, login) {
  const key = `${login}:${req.socket.remoteAddress || 'unknown'}`;
  const now = Date.now();
  const current = telegramLinkAttempts.get(key);
  if (!current || current.resetAt <= now) {
    telegramLinkAttempts.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  current.count++;
  return current.count <= 5;
}
function telegramOutboxFor(login) {
  state.telegramOutbox = Array.isArray(state.telegramOutbox) ? state.telegramOutbox : [];
  return state.telegramOutbox.filter(item => item?.login === login);
}
function removeTelegramOutboxFor(login) {
  state.telegramOutbox = (Array.isArray(state.telegramOutbox) ? state.telegramOutbox : []).filter(item => item?.login !== login);
}
async function drainTelegramOutbox() {
  if (!telegramConfigured || telegramOutboxDraining || !Array.isArray(state?.telegramOutbox)) return;
  telegramOutboxDraining = true;
  try {
    while (true) {
      const now = Date.now();
      const index = state.telegramOutbox.findIndex(item => item?.status === 'pending' && Number(item.nextAttemptAt) <= now);
      if (index < 0) {
        const nextAttemptAt = Math.min(...state.telegramOutbox.filter(item => item?.status === 'pending').map(item => Number(item.nextAttemptAt)).filter(Number.isFinite));
        if (Number.isFinite(nextAttemptAt) && nextAttemptAt > now && telegramRetryTimer === null) {
          telegramRetryTimer = setTimeout(() => { telegramRetryTimer = null; void drainTelegramOutbox(); }, nextAttemptAt - now);
          telegramRetryTimer.unref?.();
        }
        break;
      }
      const item = state.telegramOutbox[index];
      const category = telegramCategoryForType(item.type);
      const subscription = state.telegramAccounts?.[item.login];
      const notificationExists = (Array.isArray(state.notifications?.[item.login]) ? state.notifications[item.login] : []).some(entry => entry?.id === item.notificationId);
      if (!notificationExists || !category || !subscription?.chatId || subscription.enabled !== true || subscription.preferences?.[category] !== true) {
        state.telegramOutbox.splice(index, 1);
        await writeState();
        continue;
      }
      const chatId = subscription.chatId;
      item.status = 'sending';
      item.attempts = Math.min(9, (Number(item.attempts) || 0) + 1);
      await writeState();
      const queuedIndex = state.telegramOutbox.findIndex(candidate => candidate?.notificationId === item.notificationId);
      const latestSubscription = state.telegramAccounts?.[item.login];
      if (queuedIndex < 0 || latestSubscription?.chatId !== chatId || latestSubscription.enabled !== true || latestSubscription.preferences?.[category] !== true) {
        if (queuedIndex >= 0) state.telegramOutbox.splice(queuedIndex, 1);
        await writeState();
        continue;
      }
      const result = await telegramApi('sendMessage', { chat_id: Number(chatId), text: telegramNotificationText(item.type), link_preview_options: { is_disabled: true } });
      const currentLink = state.telegramAccounts?.[item.login];
      if (result.ok) {
        const sentIndex = state.telegramOutbox.findIndex(candidate => candidate?.notificationId === item.notificationId);
        if (sentIndex >= 0) state.telegramOutbox.splice(sentIndex, 1);
        if (currentLink) delete currentLink.deliveryStatus;
        await writeState();
        continue;
      }
      if (result.status === 429 && item.attempts < 4 && currentLink?.chatId === chatId && currentLink.enabled === true) {
        item.status = 'pending';
        const retryDelay = Math.max(1, Math.min(3600, result.retryAfter || 30)) * 1000;
        item.nextAttemptAt = Date.now() + retryDelay;
        await writeState();
        break;
      }
      if (currentLink?.chatId === chatId) {
        if (result.status === 400 || result.status === 403) {
          currentLink.enabled = false;
          currentLink.deliveryStatus = 'needs-attention';
        } else if (result.status === 401) {
          for (const subscription of Object.values(state.telegramAccounts)) {
            if (subscription?.enabled === true) {
              subscription.enabled = false;
              subscription.deliveryStatus = 'server-configuration';
            }
          }
          state.telegramOutbox = [];
          await writeState();
          continue;
        }
      }
      if (currentLink?.deliveryStatus === 'needs-attention') removeTelegramOutboxFor(item.login);
      const failedIndex = state.telegramOutbox.findIndex(candidate => candidate?.notificationId === item.notificationId);
      if (failedIndex >= 0) state.telegramOutbox.splice(failedIndex, 1);
      await writeState();
    }
  } catch (error) {
    console.error('Не удалось обработать очередь Telegram-уведомлений.');
  } finally { telegramOutboxDraining = false; }
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error('Слишком большой запрос'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Проверь данные формы'), { status: 400 }); }
}
function json(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers });
  res.end(JSON.stringify(payload));
}
function cookieValue(req) {
  const part = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`));
  return part ? decodeURIComponent(part.slice(cookieName.length + 1)) : '';
}
function cookieHeader(token, clear = false) {
  const parts = [`${cookieName}=${clear ? '' : encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${clear ? 0 : Math.floor(sessionMaxAge / 1000)}`];
  if (secureCookie) parts.push('Secure');
  return parts.join('; ');
}
function isAdmin(login) { return Boolean(adminLogin && login === adminLogin); }
function userHasRole(user, role) {
  if (Array.isArray(user?.roles)) return user.roles.includes(role);
  return role === 'trainer' && user?.trainerMode === true;
}
function logAdminAction(login, action) {
  state.adminAudit = Array.isArray(state.adminAudit) ? state.adminAudit : [];
  state.adminAudit.push({ login, action, at: new Date().toISOString() });
  state.adminAudit = state.adminAudit.slice(-1000);
  return writeState();
}
function adminSummary(periodDays = 30) {
  const users = Object.values(state.users || {});
  const now = Date.now();
  const activeUsers = new Set(users.filter(user => user.lastSeenAt && now - Date.parse(user.lastSeenAt) < periodDays * 86_400_000).map(user => user.login));
  const programUsage = new Map();
  const exerciseUsage = new Map();
  let workouts = 0;
  let nutritionEntries = 0;
  let usersWithWorkout = 0;
  let nutritionUsers = 0;
  for (const user of users) {
    const data = plainObject(user.data) ? user.data : {};
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    workouts += sessions.length;
    if (sessions.length) usersWithWorkout++;
    if (data.programId) programUsage.set(String(data.programId), (programUsage.get(String(data.programId)) || 0) + 1);
    const entrySets = plainObject(data.entries) ? data.entries : {};
    for (const [id, records] of Object.entries(entrySets)) if (Array.isArray(records) && records.length) exerciseUsage.set(id, (exerciseUsage.get(id) || 0) + records.length);
    const nutrition = plainObject(data.nutrition) ? data.nutrition : {};
    const entries = plainObject(nutrition.entries) ? nutrition.entries : {};
    const userNutritionEntries = Object.values(entries).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
    nutritionEntries += userNutritionEntries;
    if (userNutritionEntries) nutritionUsers++;
  }
  const moscowDateKey = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
  const registrationsByDay = Array.from({ length: periodDays }, (_, index) => {
    const date = new Date(now - (periodDays - index - 1) * 86_400_000);
    const key = moscowDateKey(date);
    return { date: key, count: users.filter(user => typeof user.createdAt === 'string' && user.createdAt.slice(0, 10) === key).length };
  });
  const registrations7d = users.filter(user => Date.parse(user.createdAt) >= now - 7 * 86_400_000).length;
  const registrations30d = users.filter(user => Date.parse(user.createdAt) >= now - 30 * 86_400_000).length;
  const todayKey = moscowDateKey(new Date(now));
  const registeredToday = users.filter(user => user.createdAt && moscowDateKey(new Date(user.createdAt)) === todayKey).length;
  return {
    generatedAt: new Date().toISOString(),
    periodDays,
    users: { total: users.length, active: activeUsers.size, withWorkout: usersWithWorkout, registrationsToday: registeredToday, registrations7d, registrations30d },
    workouts: { total: workouts, averagePerUser: users.length ? Math.round(workouts / users.length * 10) / 10 : 0 },
    nutrition: { entries: nutritionEntries, users: nutritionUsers },
    programs: [...programUsage.entries()].map(([id, count]) => ({ id, name: programNames.get(id) || `Программа ${id}`, users: count })).sort((a, b) => b.users - a.users).slice(0, 10),
    exercises: [...exerciseUsage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, entries]) => ({ id, name: exerciseNames.get(id) || id, entries })),
    registrationsByDay: periodDays <= 90 ? registrationsByDay : registrationsByDay.filter((_, index) => index % 7 === 6 || index === registrationsByDay.length - 1),
    trackingSince: state.metricsStartedAt || null
  };
}
function coachRateLimit(req, action, max = 12) {
  const key = `${req.socket.remoteAddress || 'unknown'}:${action}`;
  const now = Date.now();
  const current = coachAttempts.get(key);
  if (!current || current.resetAt <= now) {
    coachAttempts.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  current.count++;
  return current.count <= max;
}
function coachScopes(input) {
  const value = plainObject(input) ? input : {};
  return { workouts: value.workouts === true, nutrition: value.nutrition === true, nutritionGoals: value.nutritionGoals === true, progress: value.progress === true, programs: value.programs === true };
}
function activeCoachLink(id) {
  const link = state.coachLinks?.[id];
  return link?.status === 'active' ? link : null;
}
function addNotification(login, type, title, body, href = 'coach') {
  if (!login || !state.users?.[login]) return;
  state.notifications = plainObject(state.notifications) ? state.notifications : {};
  const list = Array.isArray(state.notifications[login]) ? state.notifications[login] : [];
  const notification = { id: randomUUID(), type, title: String(title).slice(0, 100), body: String(body).slice(0, 240), href, createdAt: new Date().toISOString(), readAt: null };
  list.push(notification);
  state.notifications[login] = list.slice(-200);
  const category = telegramCategoryForType(type);
  const subscription = state.telegramAccounts?.[login];
  if (telegramConfigured && category && subscription?.chatId && subscription.enabled === true && subscription.preferences?.[category] === true) {
    state.telegramOutbox = Array.isArray(state.telegramOutbox) ? state.telegramOutbox : [];
    if (!state.telegramOutbox.some(item => item?.notificationId === notification.id)) {
      state.telegramOutbox.push({ notificationId: notification.id, login, type, status: 'pending', attempts: 0, nextAttemptAt: Date.now() });
      state.telegramOutbox = state.telegramOutbox.slice(-2000);
    }
  }
}
function dataRevisionFor(login) {
  const value = Number(state.users?.[login]?.dataRevision);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function bumpDataRevision(login) {
  if (!state.users?.[login]) return 0;
  state.users[login].dataRevision = dataRevisionFor(login) + 1;
  return state.users[login].dataRevision;
}
function coachPeer(link, login) {
  if (link.trainerLogin === login) return link.clientLogin;
  if (link.clientLogin === login) return link.trainerLogin;
  return '';
}
async function logCoachAction(login, action, linkId = '') {
  state.coachAudit = Array.isArray(state.coachAudit) ? state.coachAudit : [];
  state.coachAudit.push({ login, action, linkId, at: new Date().toISOString() });
  state.coachAudit = state.coachAudit.slice(-1500);
  await writeState();
}
function coachRelationshipView(link, actorLogin) {
  const role = link.trainerLogin === actorLogin ? 'trainer' : 'client';
  const peerLogin = coachPeer(link, actorLogin);
  const peer = state.users[peerLogin];
  const permissions = coachScopes(link.permissions);
  const result = {
    id: link.id,
    role,
    peer: { login: peerLogin, name: String(peer?.data?.profile?.name || '').slice(0, 60) },
    permissions,
    createdAt: link.acceptedAt || link.createdAt,
    messages: (Array.isArray(link.messages) ? link.messages : []).slice(-60).map(message => ({ id: message.id, from: message.from, text: message.text, at: message.at })),
    assignments: (role === 'client' || permissions.programs ? (Array.isArray(link.assignments) ? link.assignments : []) : []).slice(-20).map(item => ({ id: item.id, programId: item.programId, programName: programNames.get(item.programId) || '', status: item.status, createdAt: item.createdAt, acceptedAt: item.acceptedAt || null }))
  };
  result.workoutAssignments = (role === 'client' || permissions.workouts ? (Array.isArray(link.workoutAssignments) ? link.workoutAssignments : []) : []).slice(-20).map(item => ({ id: item.id, title: String(item.title || 'Тренировка').slice(0, 80), date: item.date || '', exerciseIds: Array.isArray(item.exerciseIds) ? item.exerciseIds.slice(0, 20) : [], exerciseNames: Array.isArray(item.exerciseIds) ? item.exerciseIds.slice(0, 20).map(id => exerciseNames.get(String(id)) || '').filter(Boolean) : [], exerciseSpecs: Array.isArray(item.exerciseSpecs) ? item.exerciseSpecs.slice(0, 20) : [], note: String(item.note || '').slice(0, 500), status: item.status, createdAt: item.createdAt, acceptedAt: item.acceptedAt || null, customProgramId: item.customProgramId || '' }));
  result.workoutAssignments = result.workoutAssignments.map(item => {
    const stored = (Array.isArray(link.workoutAssignments) ? link.workoutAssignments : []).find(candidate => candidate.id === item.id);
    const checkIn = plainObject(stored?.checkIn) ? stored.checkIn : null;
    return { ...item, completedSessionId: typeof stored?.completedSessionId === 'string' ? stored.completedSessionId : '', completedAt: stored?.completedAt || null, checkIn: checkIn ? { effort: boundedNumber(checkIn.effort, 10), wellbeing: ['good', 'okay', 'poor'].includes(checkIn.wellbeing) ? checkIn.wellbeing : 'okay', note: String(checkIn.note || '').slice(0, 500), submittedAt: checkIn.submittedAt || null, trainerReply: String(checkIn.trainerReply || '').slice(0, 500), repliedAt: checkIn.repliedAt || null } : null };
  });
  const maySeeRecommendations = role === 'client' || permissions.workouts || permissions.nutrition;
  const maySeeGoalProposals = role === 'client' || permissions.nutritionGoals;
  result.recommendations = maySeeRecommendations ? (Array.isArray(link.recommendations) ? link.recommendations : []).slice(-30).map(item => ({ id: item.id, text: String(item.text || '').slice(0, 1000), status: item.status === 'acknowledged' ? 'acknowledged' : 'new', createdAt: item.createdAt, acknowledgedAt: item.acknowledgedAt || null, author: item.author === actorLogin ? 'me' : 'peer' })) : [];
  result.nutritionGoalProposals = maySeeGoalProposals ? (Array.isArray(link.nutritionGoalProposals) ? link.nutritionGoalProposals : []).slice(-20).map(item => ({ id: item.id, goals: item.goals, note: String(item.note || '').slice(0, 500), status: item.status, createdAt: item.createdAt, startDate: item.startDate || '', decidedAt: item.decidedAt || null, author: item.author === actorLogin ? 'me' : 'peer' })) : [];
  if (role !== 'trainer' || !peer?.data) return result;
  result.trainerNote = String(link.trainerNote || '').slice(0, 500);
  const data = peer.data;
  if (permissions.workouts) {
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    result.workouts = {
      count: sessions.length,
      recent: sessions.slice(-5).reverse().map(session => ({
        date: typeof session.date === 'string' ? session.date.slice(0, 40) : '',
        planName: String(session.planName || programNames.get(String(session.plan || '')) || 'Тренировка').slice(0, 80),
        durationSeconds: boundedNumber(session.durationSeconds ?? session.duration, 86400),
        exercises: boundedNumber(session.exercises, 100),
        exerciseNames: (Array.isArray(session.exerciseIds) ? session.exerciseIds : []).slice(0, 20).map(id => exerciseNames.get(String(id)) || '').filter(Boolean)
      }))
    };
  }
  if (permissions.progress) result.progress = {
    weight: String(data.profile?.weight || '').slice(0, 20),
    measurements: normalizeBodyMeasurements(data.bodyMeasurements).slice(-50).reverse().map(item => ({ date: item.date, values: item.values }))
  };
  if (permissions.nutrition) {
    const entries = plainObject(data.nutrition?.entries) ? data.nutrition.entries : {};
    result.nutrition = Object.keys(entries).sort().slice(-7).reverse().map(date => {
      const items = Array.isArray(entries[date]) ? entries[date] : [];
      const total = key => items.every(item => item?.[key] !== null && item?.[key] !== undefined && Number.isFinite(Number(item[key]))) ? Math.round(items.reduce((sum, item) => sum + Number(item[key]), 0)) : null;
      return { date, kcal: total('kcal'), protein: total('protein'), fat: total('fat'), carbs: total('carbs'), entries: items.length };
    });
  }
  if (permissions.nutritionGoals) result.nutritionGoals = { ...normalizeNutrition(data.nutrition).goals };
  return result;
}
function currentUser(req) {
  const token = cookieValue(req);
  if (!token) return null;
  const key = digest(token);
  const session = state.sessions[key];
  if (!session) return null;
  if (session.expiresAt <= Date.now()) { delete state.sessions[key]; return null; }
  const user = state.users[session.login];
  if (!user) return null;
  const now = Date.now();
  if (!user.lastSeenAt || now - Date.parse(user.lastSeenAt) >= 60 * 60_000) {
    user.lastSeenAt = new Date(now).toISOString();
    writeState().catch(() => {});
  }
  return { key, login: session.login, isAdmin: isAdmin(session.login) };
}
function allowAttempt(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const current = attempts.get(ip);
  if (!current || current.resetAt < now) { attempts.set(ip, { count: 1, resetAt: now + 60_000 }); return true; }
  current.count++;
  return current.count <= 12;
}
function validateLogin(login, password) {
  const normalized = typeof login === 'string' ? login.trim().toLowerCase() : '';
  if (!/^[a-z0-9._-]{3,32}$/.test(normalized)) throw Object.assign(new Error('Логин: 3–32 латинских буквы, цифры, точка, дефис или подчёркивание'), { status: 400 });
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw Object.assign(new Error('Пароль должен содержать от 8 до 128 символов'), { status: 400 });
  return normalized;
}
async function passwordMatches(user, password) {
  if (!user || typeof password !== 'string') return false;
  const actual = await scrypt(password, user.salt || 'ritm-invalid-account-salt', 64);
  const expected = Buffer.from(user.passwordHash || '', 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
async function updatePassword(login, password, res = null) {
  const user = state.users[login];
  const previous = { salt: user.salt, passwordHash: user.passwordHash, passwordReset: user.passwordReset, sessions: state.sessions };
  const salt = randomBytes(16).toString('hex');
  const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
  const nextSessions = Object.fromEntries(Object.entries(state.sessions).filter(([, session]) => session.login !== login));
  let token = '';
  if (res) {
    token = randomBytes(32).toString('base64url');
    nextSessions[digest(token)] = { login, expiresAt: Date.now() + sessionMaxAge };
  }
  user.salt = salt;
  user.passwordHash = passwordHash;
  delete user.passwordReset;
  user.lastSeenAt = new Date().toISOString();
  state.sessions = nextSessions;
  try { await writeState(); }
  catch (error) {
    user.salt = previous.salt;
    user.passwordHash = previous.passwordHash;
    if (previous.passwordReset === undefined) delete user.passwordReset;
    else user.passwordReset = previous.passwordReset;
    state.sessions = previous.sessions;
    throw error;
  }
  if (res) res.setHeader('Set-Cookie', cookieHeader(token));
}
async function issueSession(res, login) {
  const token = randomBytes(32).toString('base64url');
  state.sessions[digest(token)] = { login, expiresAt: Date.now() + sessionMaxAge };
  if (state.users[login]) state.users[login].lastSeenAt = new Date().toISOString();
  await writeState();
  res.setHeader('Set-Cookie', cookieHeader(token));
}
async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Метод не поддерживается' }, { Allow: 'GET, HEAD' });
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return json(res, 400, { error: 'Некорректный путь' }); }
  if (decoded.includes('\\') || decoded.split('/').some(part => part.startsWith('.'))) return json(res, 404, { error: 'Не найдено' });
  if (decoded === '/') decoded = '/index.html';
  if (decoded === '/privacy' || decoded === '/privacy-policy') decoded = '/privacy.html';
  const isPublicFile = publicFiles.has(decoded);
  const assetsRoot = path.join(root, 'assets');
  const relative = decoded.replace(/^\/+/, '');
  const target = path.resolve(root, relative);
  const assetRelative = path.relative(assetsRoot, target);
  const isPublicAsset = decoded.startsWith('/assets/') && assetRelative !== '' && assetRelative !== '..' && !assetRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(assetRelative) && publicAssetExtensions.has(path.extname(target).toLowerCase());
  if (!isPublicFile && !isPublicAsset) return json(res, 404, { error: 'Не найдено' });
  try {
    const [realRoot, realAssetsRoot, realTarget] = await Promise.all([realpath(root), realpath(assetsRoot), realpath(target)]);
    const rootRelative = path.relative(realRoot, realTarget);
    const assetRealRelative = path.relative(realAssetsRoot, realTarget);
    const inside = relativePath => relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
    if (!inside(rootRelative) || (isPublicAsset && !inside(assetRealRelative))) return json(res, 404, { error: 'Не найдено' });
    const body = await readFile(realTarget);
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { json(res, 404, { error: 'Не найдено' }); }
}

async function handleTelegramWebhook(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Метод не поддерживается' }, { Allow: 'POST' });
  if (!telegramConfigured) return json(res, 503, { error: 'Webhook не настроен' });
  const suppliedSecret = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] || ''));
  const expectedSecret = Buffer.from(telegramWebhookSecret);
  if (suppliedSecret.length !== expectedSecret.length || !timingSafeEqual(suppliedSecret, expectedSecret)) return json(res, 403, { error: 'Запрос отклонён' });

  const update = await readBody(req);
  if (!plainObject(update) || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return json(res, 400, { error: 'Некорректное событие Telegram' });
  state.telegramUpdates = plainObject(state.telegramUpdates) ? state.telegramUpdates : {};
  const updateId = String(update.update_id);
  if (Object.hasOwn(state.telegramUpdates, updateId)) return json(res, 200, { ok: true });
  state.telegramUpdates[updateId] = Date.now();
  state.telegramUpdates = Object.fromEntries(Object.entries(state.telegramUpdates).sort((a, b) => Number(a[1]) - Number(b[1])).slice(-1000));

  let reply = '';
  const message = plainObject(update.message) ? update.message : null;
  if (message && message.chat?.type === 'private' && message.from?.is_bot !== true) {
    const chatNumber = Number(message.chat.id);
    const chatId = Number.isSafeInteger(chatNumber) && chatNumber > 0 ? String(chatNumber) : '';
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const command = text.match(/^\/(start|stop|help)(?:@[A-Za-z0-9_]+)?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*$/i);
    if (chatId && command) {
      const action = command[1].toLowerCase();
      const payload = command[2] || '';
      state.telegramAccounts = plainObject(state.telegramAccounts) ? state.telegramAccounts : {};
      state.telegramLinkCodes = plainObject(state.telegramLinkCodes) ? state.telegramLinkCodes : {};
      if (action === 'start' && payload) {
        const codeHash = digest(payload);
        const invite = state.telegramLinkCodes[codeHash];
        if (!/^[A-Za-z0-9_-]{32}$/.test(payload) || !invite || Number(invite.expiresAt) <= Date.now() || !state.users?.[invite.login]) {
          if (invite) delete state.telegramLinkCodes[codeHash];
          reply = 'Ссылка недействительна или устарела. Создай новую в настройках приложения.';
        } else {
          const linkedElsewhere = Object.entries(state.telegramAccounts).some(([login, account]) => login !== invite.login && account?.chatId === chatId);
          const existing = state.telegramAccounts[invite.login];
          if (linkedElsewhere) reply = 'Этот Telegram уже связан с другим профилем приложения. Сначала отключи его в настройках того профиля.';
          else if (existing?.chatId && existing.chatId !== chatId) reply = 'Сначала отключи текущий Telegram в настройках приложения, затем создай новую ссылку.';
          else {
            state.telegramAccounts[invite.login] = { chatId, linkedAt: new Date().toISOString(), enabled: false, preferences: normalizeTelegramPreferences({}), deliveryStatus: 'off' };
            for (const [key, item] of Object.entries(state.telegramLinkCodes)) if (item?.login === invite.login) delete state.telegramLinkCodes[key];
            reply = 'Профиль приложения привязан. Уведомления пока выключены — выбери нужные типы в настройках приложения.';
          }
        }
      } else if (action === 'stop') {
        const linked = Object.entries(state.telegramAccounts).find(([, account]) => account?.chatId === chatId);
        if (linked) {
          linked[1].enabled = false;
          linked[1].preferences = normalizeTelegramPreferences({});
          linked[1].deliveryStatus = 'off';
          removeTelegramOutboxFor(linked[0]);
        }
        reply = 'Уведомления Слабого тела выключены. Включить их снова можно в настройках приложения.';
      } else {
        reply = `Чтобы привязать профиль, открой ${telegramPublicUrl || 'сайт slaboetelo.ru'} → «Ещё» → «Настройки приложения» → «Уведомления в Telegram». Для отключения отправь /stop.`;
      }
    }
  }

  await writeState();
  if (reply) {
    const messageChatId = String(Number(message.chat.id));
    const sent = await telegramApi('sendMessage', { chat_id: Number(messageChatId), text: reply, link_preview_options: { is_disabled: true } });
    if (!sent.ok) console.error('Не удалось отправить ответ Telegram-бота.');
  }
  return json(res, 200, { ok: true });
}

async function handleTelegramApi(req, res, url) {
  const actor = currentUser(req);
  if (!actor) return json(res, 401, { error: 'Войди в профиль' });
  if (!['GET', 'HEAD'].includes(req.method)) {
    const origin = req.headers.origin;
    try { if (!origin || new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Запрос отклонён' }); }
    catch { return json(res, 403, { error: 'Запрос отклонён' }); }
  }
  state.telegramAccounts = plainObject(state.telegramAccounts) ? state.telegramAccounts : {};
  state.telegramLinkCodes = plainObject(state.telegramLinkCodes) ? state.telegramLinkCodes : {};
  state.telegramOutbox = Array.isArray(state.telegramOutbox) ? state.telegramOutbox : [];
  const account = state.telegramAccounts[actor.login];

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/telegram/settings') {
    const webhookReady = await telegramWebhookIsReady();
    return json(res, 200, {
      configured: telegramConfigured,
      webhookReady,
      canLink: telegramConfigured && webhookReady,
      botUsername: telegramBotUsername,
      linked: Boolean(account?.chatId),
      enabled: account?.enabled === true,
      preferences: normalizeTelegramPreferences(account?.preferences),
      deliveryStatus: ['needs-attention', 'server-configuration'].includes(account?.deliveryStatus) ? account.deliveryStatus : ''
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/telegram/link') {
    if (!telegramConfigured) return json(res, 503, { error: 'Подключение Telegram ещё не настроено на сервере.' });
    if (!telegramLinkRateAllowed(req, actor.login)) return json(res, 429, { error: 'Слишком много ссылок. Подожди минуту и попробуй снова.' });
    if (!await telegramWebhookIsReady()) return json(res, 503, { error: 'Webhook Telegram ещё не настроен для сайта.' });
    if (account?.chatId) return json(res, 409, { error: 'Telegram уже подключён. Сначала отключи текущую связь.' });
    const code = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + 10 * 60_000;
    for (const [key, item] of Object.entries(state.telegramLinkCodes)) if (item?.login === actor.login || Number(item?.expiresAt) <= Date.now()) delete state.telegramLinkCodes[key];
    state.telegramLinkCodes[digest(code)] = { login: actor.login, expiresAt };
    await writeState();
    return json(res, 200, { url: `https://t.me/${telegramBotUsername}?start=${code}`, expiresAt: new Date(expiresAt).toISOString() });
  }

  if (req.method === 'PUT' && url.pathname === '/api/telegram/settings') {
    if (!telegramConfigured) return json(res, 503, { error: 'Уведомления Telegram ещё не настроены на сервере.' });
    if (!account?.chatId) return json(res, 409, { error: 'Сначала подключи Telegram к профилю.' });
    const body = await readBody(req);
    if (!plainObject(body) || !plainObject(body.preferences)) return json(res, 400, { error: 'Проверь настройки Telegram.' });
    const preferences = normalizeTelegramPreferences(body.preferences);
    account.preferences = preferences;
    account.enabled = body.enabled === true;
    if (account.enabled && telegramCategories.some(category => preferences[category])) account.deliveryStatus = 'on';
    else account.deliveryStatus = 'off';
    if (!account.enabled || !telegramCategories.some(category => preferences[category])) removeTelegramOutboxFor(actor.login);
    await writeState();
    return json(res, 200, { ok: true, enabled: account.enabled, preferences });
  }

  if (req.method === 'DELETE' && url.pathname === '/api/telegram/link') {
    delete state.telegramAccounts[actor.login];
    for (const [key, item] of Object.entries(state.telegramLinkCodes)) if (item?.login === actor.login) delete state.telegramLinkCodes[key];
    removeTelegramOutboxFor(actor.login);
    await writeState();
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Не найдено' });
}

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return json(res, 400, { error: 'Некорректный запрос' }); }
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

  if (url.pathname === '/api/telegram/webhook') return handleTelegramWebhook(req, res);
  if (url.pathname.startsWith('/api/telegram/')) return handleTelegramApi(req, res, url);

  if (url.pathname === '/api/notifications') {
    const actor = currentUser(req);
    if (!actor) return json(res, 401, { error: 'Войди в профиль' });
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origin = req.headers.origin;
      try { if (!origin || new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Запрос отклонён' }); }
      catch { return json(res, 403, { error: 'Запрос отклонён' }); }
    }
    state.notifications = plainObject(state.notifications) ? state.notifications : {};
    const list = Array.isArray(state.notifications[actor.login]) ? state.notifications[actor.login] : [];
    if (req.method === 'GET' || req.method === 'HEAD') {
      const notifications = list.slice().reverse().slice(0, 100);
      return json(res, 200, { notifications, unreadCount: list.filter(item => !item.readAt).length });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body?.all === true) {
        const now = new Date().toISOString();
        for (const item of list) if (!item.readAt) item.readAt = now;
      } else {
        const ids = new Set(Array.isArray(body?.ids) ? body.ids.filter(id => typeof id === 'string').slice(0, 100) : []);
        const now = new Date().toISOString();
        for (const item of list) if (ids.has(item.id) && !item.readAt) item.readAt = now;
      }
      await writeState();
      return json(res, 200, { ok: true, unreadCount: list.filter(item => !item.readAt).length });
    }
    if (req.method === 'DELETE') {
      state.notifications[actor.login] = [];
      await writeState();
      return json(res, 200, { ok: true, unreadCount: 0 });
    }
    return json(res, 405, { error: 'Метод не поддерживается' }, { Allow: 'GET, HEAD, POST, DELETE' });
  }

  if (url.pathname.startsWith('/api/coach/')) {
    const actor = currentUser(req);
    if (!actor) return json(res, 401, { error: 'Войди в профиль' });
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origin = req.headers.origin;
      try { if (!origin || new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Запрос отклонён' }); }
      catch { return json(res, 403, { error: 'Запрос отклонён' }); }
    }
    state.coachInvitations = plainObject(state.coachInvitations) ? state.coachInvitations : {};
    state.coachLinks = plainObject(state.coachLinks) ? state.coachLinks : {};
    state.coachApplications = plainObject(state.coachApplications) ? state.coachApplications : {};
    state.coachAudit = Array.isArray(state.coachAudit) ? state.coachAudit : [];

    if (req.method === 'GET' && url.pathname === '/api/coach/applications') {
      const application = Object.values(state.coachApplications)
        .filter(item => item?.login === actor.login)
        .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))[0] || null;
      return json(res, 200, { application: application ? {
        id: application.id, fullName: application.fullName, experienceYears: application.experienceYears,
        about: application.about, specialization: application.specialization, education: application.education,
        status: application.status,
        createdAt: application.createdAt, reviewedAt: application.reviewedAt || null,
        decisionNote: application.decisionNote || ''
      } : null, trainerMode: userHasRole(state.users[actor.login], 'trainer') });
    }

    if (req.method === 'POST' && url.pathname === '/api/coach/applications') {
      if (userHasRole(state.users[actor.login], 'trainer')) return json(res, 409, { error: 'У этого аккаунта уже включён режим тренера.' });
      if (!coachRateLimit(req, 'application-submit', 4)) return json(res, 429, { error: 'Слишком много заявок. Попробуй позже.' });
      const body = await readBody(req);
      const fullName = typeof body?.fullName === 'string' ? body.fullName.trim().replace(/\s+/g, ' ') : '';
      const about = typeof body?.about === 'string' ? body.about.trim() : '';
      const specialization = typeof body?.specialization === 'string' ? body.specialization.trim().slice(0, 160) : '';
      const education = typeof body?.education === 'string' ? body.education.trim().slice(0, 240) : '';
      const experienceYears = body?.experienceYears;
      if (fullName.length < 5 || fullName.length > 120) return json(res, 400, { error: 'Укажи ФИО длиной от 5 до 120 символов.' });
      if (!Number.isInteger(experienceYears) || experienceYears < 0 || experienceYears > 60) return json(res, 400, { error: 'Стаж должен быть целым числом от 0 до 60 лет.' });
      if (about.length < 20 || about.length > 800) return json(res, 400, { error: 'Расскажи о себе: от 20 до 800 символов.' });
      const pending = Object.values(state.coachApplications).some(item => item?.login === actor.login && item.status === 'pending');
      if (pending) return json(res, 409, { error: 'У тебя уже есть заявка на рассмотрении.' });
      if (Object.values(state.coachApplications).filter(item => item?.login === actor.login).length >= 20) return json(res, 429, { error: 'Достигнут лимит истории заявок для этого аккаунта.' });
      const application = {
        id: randomUUID(), login: actor.login, fullName, experienceYears, about, specialization, education,
        status: 'pending', createdAt: new Date().toISOString(), reviewedAt: null,
        reviewedBy: '', decisionNote: ''
      };
      const auditLength = state.coachAudit.length;
      state.coachApplications[application.id] = application;
      addNotification(adminLogin, 'trainer-application', 'Новая заявка на тренерство', `${fullName} (@${actor.login}) отправил заявку.`, 'admin');
      try { await logCoachAction(actor.login, 'trainer-application:submit'); }
      catch (error) { delete state.coachApplications[application.id]; state.coachAudit.length = auditLength; throw error; }
      return json(res, 201, { application: { id: application.id, status: application.status, createdAt: application.createdAt } });
    }

    if (req.method === 'DELETE' && url.pathname === '/api/coach/applications') {
      const application = Object.values(state.coachApplications)
        .filter(item => item?.login === actor.login && item.status === 'pending')
        .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))[0];
      if (!application) return json(res, 404, { error: 'Ожидающая заявка не найдена.' });
      const previous = { status: application.status, withdrawnAt: application.withdrawnAt, auditLength: state.coachAudit.length };
      application.status = 'withdrawn';
      application.withdrawnAt = new Date().toISOString();
      try { await logCoachAction(actor.login, 'trainer-application:withdraw'); }
      catch (error) {
        application.status = previous.status;
        if (previous.withdrawnAt === undefined) delete application.withdrawnAt; else application.withdrawnAt = previous.withdrawnAt;
        state.coachAudit.length = previous.auditLength;
        throw error;
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/coach/overview') {
      const relationships = Object.values(state.coachLinks).filter(link => link?.status === 'active' && (link.trainerLogin === actor.login || link.clientLogin === actor.login)).map(link => coachRelationshipView(link, actor.login));
      const invitations = Object.values(state.coachInvitations).filter(invite => invite?.trainerLogin === actor.login && invite.status === 'pending' && Date.parse(invite.expiresAt) > Date.now()).map(invite => ({ id: invite.id, createdAt: invite.createdAt, expiresAt: invite.expiresAt }));
      return json(res, 200, { trainerMode: userHasRole(state.users[actor.login], 'trainer'), relationships, invitations });
    }

    if (req.method === 'POST' && url.pathname === '/api/coach/invitations') {
      if (!userHasRole(state.users[actor.login], 'trainer')) return json(res, 403, { error: 'Режим тренера выдаёт администратор приложения.' });
      if (!coachRateLimit(req, 'create-invitation', 5)) return json(res, 429, { error: 'Слишком много приглашений. Попробуй позже.' });
      const token = randomBytes(24).toString('base64url');
      const tokenHash = digest(token);
      const now = new Date();
      const invite = { id: randomUUID(), trainerLogin: actor.login, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(), status: 'pending' };
      state.coachInvitations[tokenHash] = invite;
      await logCoachAction(actor.login, 'invitation:create');
      return json(res, 201, { invitation: { id: invite.id, token, expiresAt: invite.expiresAt } });
    }

    if (req.method === 'POST' && url.pathname === '/api/coach/invitations/preview') {
      if (!coachRateLimit(req, 'preview-invitation', 12)) return json(res, 429, { error: 'Слишком много попыток. Подожди минуту и попробуй снова.' });
      const body = await readBody(req);
      const token = typeof body?.token === 'string' ? body.token.trim() : '';
      if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return json(res, 400, { error: 'Проверь код приглашения' });
      const invite = state.coachInvitations[digest(token)];
      if (!invite || invite.status !== 'pending' || Date.parse(invite.expiresAt) <= Date.now()) return json(res, 404, { error: 'Код не найден, уже использован или истёк' });
      const trainer = state.users[invite.trainerLogin];
      return json(res, 200, { trainer: { login: invite.trainerLogin, name: String(trainer?.data?.profile?.name || '').slice(0, 60) }, expiresAt: invite.expiresAt });
    }

    if (req.method === 'POST' && url.pathname === '/api/coach/invitations/accept') {
      if (!coachRateLimit(req, 'accept-invitation', 8)) return json(res, 429, { error: 'Слишком много попыток. Подожди минуту и попробуй снова.' });
      const body = await readBody(req);
      const token = typeof body?.token === 'string' ? body.token.trim() : '';
      if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return json(res, 400, { error: 'Проверь код приглашения' });
      const invite = state.coachInvitations[digest(token)];
      if (!invite || invite.status !== 'pending' || Date.parse(invite.expiresAt) <= Date.now()) return json(res, 404, { error: 'Код не найден, уже использован или истёк' });
      if (invite.trainerLogin === actor.login) return json(res, 409, { error: 'Нельзя связать профиль с самим собой' });
      const exists = Object.values(state.coachLinks).some(link => link?.status === 'active' && link.trainerLogin === invite.trainerLogin && link.clientLogin === actor.login);
      if (exists) return json(res, 409, { error: 'Связь с этим тренером уже существует' });
      const scopes = coachScopes(body.permissions);
      const link = { id: randomUUID(), trainerLogin: invite.trainerLogin, clientLogin: actor.login, status: 'active', permissions: scopes, createdAt: new Date().toISOString(), acceptedAt: new Date().toISOString(), messages: [], assignments: [] };
      state.coachLinks[link.id] = link;
      invite.status = 'accepted';
      invite.acceptedAt = new Date().toISOString();
      invite.acceptedBy = actor.login;
      addNotification(invite.trainerLogin, 'coach-link', 'Подопечный подключился', `Пользователь @${actor.login} принял приглашение и подключился к тебе.`, 'coach');
      await logCoachAction(actor.login, 'invitation:accept', link.id);
      return json(res, 201, { relationship: coachRelationshipView(link, actor.login) });
    }

    const invitationMatch = url.pathname.match(/^\/api\/coach\/invitations\/([0-9a-f-]{36})$/i);
    if (req.method === 'DELETE' && invitationMatch) {
      const invite = Object.values(state.coachInvitations).find(item => item?.id === invitationMatch[1]);
      if (!invite || invite.trainerLogin !== actor.login || invite.status !== 'pending') return json(res, 404, { error: 'Приглашение не найдено' });
      invite.status = 'revoked';
      invite.revokedAt = new Date().toISOString();
      await logCoachAction(actor.login, 'invitation:revoke');
      return json(res, 200, { ok: true });
    }

    const linkMatch = url.pathname.match(/^\/api\/coach\/links\/([0-9a-f-]{36})$/i);
    const noteMatch = url.pathname.match(/^\/api\/coach\/links\/([0-9a-f-]{36})\/note$/i);
    const permissionMatch = url.pathname.match(/^\/api\/coach\/links\/([0-9a-f-]{36})\/permissions$/i);
    const assignmentMatch = url.pathname.match(/^\/api\/coach\/links\/([0-9a-f-]{36})\/assignments$/i);
    const acceptAssignmentMatch = url.pathname.match(/^\/api\/coach\/links\/([0-9a-f-]{36})\/assignments\/([0-9a-f-]{36})\/accept$/i);
    const declineAssignmentMatch = url.pathname.match(/^\/api\/coach\/links\/([0-9a-f-]{36})\/assignments\/([0-9a-f-]{36})\/decline$/i);
    const workoutAssignmentMatch = url.pathname.match(/^\/api\/coach\/links\/([0-9a-f-]{36})\/workout-assignments$/i);
    const clientWorkoutAssignmentMatch = url.pathname.match(/^\/api\/coach\/links\/([0-9a-f-]{36})\/workout-assignments\/([0-9a-f-]{36})\/(accept|decline)$/i);
    const workoutCheckInMatch = url.pathname.match(/^\/api\/coach\/links\/([0-9a-f-]{36})\/workout-assignments\/([0-9a-f-]{36})\/check-in(\/reply)?$/i);
    const messageMatch = url.pathname.match(/^\/api\/coach\/links\/([0-9a-f-]{36})\/messages$/i);
    const recommendationMatch = url.pathname.match(/^\/api\/coach\/links\/([0-9a-f-]{36})\/recommendations(?:\/([0-9a-f-]{36})\/ack)?$/i);
    const nutritionGoalMatch = url.pathname.match(/^\/api\/coach\/links\/([0-9a-f-]{36})\/nutrition-goals(?:\/([0-9a-f-]{36})\/(accept|decline))?$/i);
    if (linkMatch && req.method === 'DELETE') {
      const link = activeCoachLink(linkMatch[1]);
      if (!link || !coachPeer(link, actor.login)) return json(res, 404, { error: 'Связь не найдена' });
      link.status = 'revoked';
      link.revokedAt = new Date().toISOString();
      link.revokedBy = actor.login;
      addNotification(coachPeer(link, actor.login), 'coach-link', 'Связь с тренером отключена', `Пользователь @${actor.login} отключил связь.`, 'coach');
      await logCoachAction(actor.login, 'relationship:revoke', link.id);
      return json(res, 200, { ok: true });
    }
    if (noteMatch && req.method === 'PUT') {
      const link = activeCoachLink(noteMatch[1]);
      if (!link || link.trainerLogin !== actor.login || !userHasRole(state.users[actor.login], 'trainer')) return json(res, 404, { error: 'Связь не найдена' });
      const body = await readBody(req);
      if (typeof body?.note !== 'string' || body.note.length > 500) return json(res, 400, { error: 'Заметка должна содержать не более 500 символов.' });
      link.trainerNote = body.note.trim();
      await logCoachAction(actor.login, 'trainer-note:update', link.id);
      return json(res, 200, { ok: true, note: link.trainerNote });
    }
    if (permissionMatch && req.method === 'PUT') {
      const link = activeCoachLink(permissionMatch[1]);
      if (!link || link.clientLogin !== actor.login) return json(res, 404, { error: 'Связь не найдена' });
      const body = await readBody(req);
      const permissions = coachScopes(body?.permissions);
      if (!permissions.workouts) for (const item of link.workoutAssignments || []) if (item.status === 'pending') { item.status = 'cancelled'; item.cancelledAt = new Date().toISOString(); }
      if (!permissions.programs) for (const item of link.assignments || []) if (item.status === 'pending') { item.status = 'cancelled'; item.cancelledAt = new Date().toISOString(); }
      if (!permissions.nutritionGoals) for (const item of link.nutritionGoalProposals || []) if (item.status === 'pending') { item.status = 'cancelled'; item.cancelledAt = new Date().toISOString(); }
      link.permissions = permissions;
      await logCoachAction(actor.login, 'permissions:update', link.id);
      return json(res, 200, { ok: true, permissions: link.permissions });
    }
    if (assignmentMatch && req.method === 'POST') {
      const link = activeCoachLink(assignmentMatch[1]);
      if (!userHasRole(state.users[actor.login], 'trainer')) return json(res, 403, { error: 'Режим тренера выдаёт администратор приложения.' });
      if (!link || link.trainerLogin !== actor.login || link.permissions?.programs !== true) return json(res, 403, { error: 'Клиент не разрешил назначать программы' });
      const body = await readBody(req);
      const programId = typeof body?.programId === 'string' ? body.programId : '';
      if (!programNames.has(programId)) return json(res, 400, { error: 'Выбери программу из каталога' });
      link.assignments = Array.isArray(link.assignments) ? link.assignments : [];
      if (link.assignments.filter(item => item.status === 'pending').length >= 10) return json(res, 409, { error: 'Слишком много ожидающих назначений' });
      const assignment = { id: randomUUID(), programId, status: 'pending', createdAt: new Date().toISOString() };
      link.assignments.push(assignment);
      addNotification(link.clientLogin, 'program-assignment', 'Тренер предложил программу', `Нужно принять или отклонить программу «${programNames.get(programId)}».`, 'coach');
      await logCoachAction(actor.login, 'program:assign', link.id);
      return json(res, 201, { assignment: { ...assignment, programName: programNames.get(programId) } });
    }
    if (acceptAssignmentMatch && req.method === 'POST') {
      const link = activeCoachLink(acceptAssignmentMatch[1]);
      if (!link || link.clientLogin !== actor.login) return json(res, 404, { error: 'Связь не найдена' });
      const assignment = (link.assignments || []).find(item => item.id === acceptAssignmentMatch[2] && item.status === 'pending');
      if (!assignment) return json(res, 404, { error: 'Назначение не найдено или уже обработано' });
      const data = state.users[actor.login].data;
      data.myProgramIds = Array.isArray(data.myProgramIds) ? data.myProgramIds : [];
      if (!data.myProgramIds.includes(assignment.programId)) data.myProgramIds.push(assignment.programId);
      data.completed = plainObject(data.completed) ? data.completed : {};
      data.completed.__myProgramIds = data.myProgramIds.slice();
      bumpDataRevision(actor.login);
      assignment.status = 'accepted';
      assignment.acceptedAt = new Date().toISOString();
      addNotification(link.trainerLogin, 'program-decision', 'Подопечный принял программу', `Пользователь @${actor.login} добавил предложенную программу.`, 'coach');
      await logCoachAction(actor.login, 'program:accept', link.id);
      return json(res, 200, { ok: true, programId: assignment.programId });
    }
    if (declineAssignmentMatch && req.method === 'POST') {
      const link = activeCoachLink(declineAssignmentMatch[1]);
      if (!link || link.clientLogin !== actor.login) return json(res, 404, { error: 'Связь не найдена' });
      const assignment = (link.assignments || []).find(item => item.id === declineAssignmentMatch[2] && item.status === 'pending');
      if (!assignment) return json(res, 404, { error: 'Назначение не найдено или уже обработано' });
      assignment.status = 'declined';
      assignment.declinedAt = new Date().toISOString();
      addNotification(link.trainerLogin, 'program-decision', 'Подопечный отклонил программу', `Пользователь @${actor.login} отклонил предложенную программу.`, 'coach');
      await logCoachAction(actor.login, 'program:decline', link.id);
      return json(res, 200, { ok: true });
    }
    if (workoutAssignmentMatch && req.method === 'POST') {
      const link = activeCoachLink(workoutAssignmentMatch[1]);
      if (!userHasRole(state.users[actor.login], 'trainer')) return json(res, 403, { error: 'Режим тренера выдаёт администратор приложения.' });
      if (!link || link.trainerLogin !== actor.login || link.permissions?.workouts !== true) return json(res, 403, { error: 'Клиент не разрешил назначения тренировок.' });
      const body = await readBody(req), title = typeof body?.title === 'string' ? body.title.trim().slice(0, 80) : '';
      const date = typeof body?.date === 'string' ? body.date : '';
      const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T12:00:00Z`) : NaN;
      if (title.length < 2) return json(res, 400, { error: 'Укажи название тренировки.' });
      if (!Number.isFinite(parsedDate) || new Date(parsedDate).toISOString().slice(0, 10) !== date || parsedDate < Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) || parsedDate > Date.now() + 366 * 86_400_000) return json(res, 400, { error: 'Выбери дату от сегодня до следующего года.' });
      const ids = Array.isArray(body?.exerciseIds) ? [...new Set(body.exerciseIds.filter(id => typeof id === 'string' && exerciseNames.has(id)))].slice(0, 20) : [];
      if (!ids.length) return json(res, 400, { error: 'Выбери от 1 до 20 упражнений из каталога.' });
      const sets = Number(body?.sets);
      const reps = typeof body?.reps === 'string' ? body.reps.trim().slice(0, 20) : '';
      const rest = typeof body?.rest === 'string' ? body.rest.trim().slice(0, 20) : '';
      if (!Number.isInteger(sets) || sets < 1 || sets > 20 || !reps || !rest) return json(res, 400, { error: 'Проверь подходы, повторы и время отдыха.' });
      link.workoutAssignments = Array.isArray(link.workoutAssignments) ? link.workoutAssignments : [];
      if (link.workoutAssignments.filter(item => item.status === 'pending').length >= 10) return json(res, 409, { error: 'У клиента уже есть 10 тренировок на согласовании.' });
      const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';
      const exerciseSpecs = ids.map(exerciseId => ({ exerciseId, sets: String(sets), reps, rest }));
      const assignment = { id: randomUUID(), title, date, exerciseIds: ids, exerciseSpecs, note, status: 'pending', createdAt: new Date().toISOString() };
      link.workoutAssignments.push(assignment);
      link.workoutAssignments = link.workoutAssignments.slice(-40);
      addNotification(link.clientLogin, 'workout-assignment', 'Тренер назначил тренировку', `«${title}» · ${new Date(`${date}T12:00:00`).toLocaleDateString('ru-RU')}. Открой кабинет тренера, чтобы принять или отклонить.`, 'coach');
      await logCoachAction(actor.login, 'workout:propose', link.id);
      return json(res, 201, { assignment: { id: assignment.id, status: assignment.status, date: assignment.date } });
    }
    if (clientWorkoutAssignmentMatch && req.method === 'POST') {
      const link = activeCoachLink(clientWorkoutAssignmentMatch[1]);
      if (!link || link.clientLogin !== actor.login) return json(res, 404, { error: 'Связь не найдена' });
      if (link.permissions?.workouts !== true) return json(res, 403, { error: 'Доступ к назначениям тренировок отозван.' });
      const assignment = (link.workoutAssignments || []).find(item => item.id === clientWorkoutAssignmentMatch[2] && item.status === 'pending');
      if (!assignment) return json(res, 404, { error: 'Тренировка не найдена или уже обработана' });
      if (clientWorkoutAssignmentMatch[3] === 'accept') {
        const account = state.users[actor.login], data = account.data;
        data.customPrograms = Array.isArray(data.customPrograms) ? data.customPrograms : [];
        data.myProgramIds = Array.isArray(data.myProgramIds) ? data.myProgramIds : [];
        if (data.customPrograms.length >= 100) return json(res, 409, { error: 'Список программ клиента заполнен. Клиенту нужно убрать одну программу перед принятием.' });
        const programId = `cp-${randomUUID()}`;
        const program = { id: programId, name: assignment.title, description: assignment.note || 'План тренировки от тренера.', schedule: assignment.date, exerciseIds: assignment.exerciseIds.slice(), exerciseSpecs: assignment.exerciseSpecs.map(spec => ({ ...spec })) };
        data.customPrograms.push(program);
        data.customPrograms = data.customPrograms.slice(-100);
        data.myProgramIds = [...new Set([...data.myProgramIds, programId])].slice(-100);
        data.completed = plainObject(data.completed) ? data.completed : {};
        data.completed.__myProgramIds = data.myProgramIds.slice();
        if (!data.programId) data.programId = programId;
        bumpDataRevision(actor.login);
        assignment.customProgramId = programId;
        assignment.status = 'accepted';
        assignment.acceptedAt = new Date().toISOString();
      } else {
        assignment.status = 'declined';
        assignment.declinedAt = new Date().toISOString();
      }
      addNotification(link.trainerLogin, 'workout-decision', `Подопечный ${assignment.status === 'accepted' ? 'принял' : 'отклонил'} тренировку`, `Пользователь @${actor.login} ${assignment.status === 'accepted' ? 'добавил в планы' : 'отклонил'} «${assignment.title}».`, 'coach');
      await logCoachAction(actor.login, `workout:${assignment.status}`, link.id);
      return json(res, 200, { ok: true, status: assignment.status, programId: assignment.customProgramId || '', program: clientWorkoutAssignmentMatch[3] === 'accept' ? state.users[actor.login].data.customPrograms.find(item => item.id === assignment.customProgramId) : null });
    }
    if (workoutCheckInMatch && req.method === 'POST') {
      const link = activeCoachLink(workoutCheckInMatch[1]);
      if (!link || link.permissions?.workouts !== true) return json(res, 404, { error: 'Связь не найдена или доступ к тренировкам отключён.' });
      const assignment = (link.workoutAssignments || []).find(item => item.id === workoutCheckInMatch[2] && item.status === 'accepted');
      if (!assignment || !assignment.completedSessionId) return json(res, 409, { error: 'Сначала заверши назначенную тренировку в обычном журнале.' });
      if (!workoutCheckInMatch[3]) {
        if (link.clientLogin !== actor.login) return json(res, 403, { error: 'Отправить отзыв может только подопечный.' });
        const session = (state.users[actor.login].data.sessions || []).find(item => item.id === assignment.completedSessionId && item.programId === assignment.customProgramId);
        if (!session) return json(res, 409, { error: 'Не удалось подтвердить завершённую тренировку.' });
        if (assignment.checkIn) return json(res, 409, { error: 'Отзыв по этой тренировке уже отправлен.' });
        const body = await readBody(req);
        const effort = Number(body?.effort), wellbeing = String(body?.wellbeing || ''), note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';
        if (!Number.isInteger(effort) || effort < 1 || effort > 10 || !['good', 'okay', 'poor'].includes(wellbeing)) return json(res, 400, { error: 'Оцени нагрузку от 1 до 10 и выбери самочувствие.' });
        assignment.checkIn = { effort, wellbeing, note, submittedAt: new Date().toISOString(), trainerReply: '', repliedAt: null };
        addNotification(link.trainerLogin, 'workout-check-in', 'Отзыв по тренировке', `Подопечный @${actor.login} оставил отзыв по плану «${String(assignment.title || 'Тренировка').slice(0, 80)}».`, 'coach');
        await logCoachAction(actor.login, 'workout:check-in', link.id);
        return json(res, 201, { ok: true });
      }
      if (link.trainerLogin !== actor.login || !userHasRole(state.users[actor.login], 'trainer')) return json(res, 403, { error: 'Ответить на отзыв может только связанный тренер.' });
      if (!assignment.checkIn) return json(res, 409, { error: 'Подопечный ещё не отправил отзыв.' });
      const body = await readBody(req), reply = typeof body?.reply === 'string' ? body.reply.trim().slice(0, 500) : '';
      if (reply.length < 2) return json(res, 400, { error: 'Напиши ответ длиной от 2 до 500 символов.' });
      assignment.checkIn.trainerReply = reply;
      assignment.checkIn.repliedAt = new Date().toISOString();
      addNotification(link.clientLogin, 'workout-check-in-reply', 'Тренер ответил на отзыв', `Тренер @${actor.login} ответил по плану «${String(assignment.title || 'Тренировка').slice(0, 80)}».`, 'coach');
      await logCoachAction(actor.login, 'workout:check-in-reply', link.id);
      return json(res, 200, { ok: true });
    }
    if (recommendationMatch && !recommendationMatch[2] && req.method === 'POST') {
      const link = activeCoachLink(recommendationMatch[1]);
      if (!userHasRole(state.users[actor.login], 'trainer')) return json(res, 403, { error: 'Режим тренера выдаёт администратор приложения.' });
      if (!link || link.trainerLogin !== actor.login || !(link.permissions?.workouts || link.permissions?.nutrition)) return json(res, 403, { error: 'Клиент не разрешил получать рекомендации по тренировкам или питанию.' });
      const body = await readBody(req);
      const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 1000) : '';
      if (text.length < 3) return json(res, 400, { error: 'Напиши рекомендацию длиной от 3 до 1000 символов.' });
      link.recommendations = Array.isArray(link.recommendations) ? link.recommendations : [];
      if (link.recommendations.filter(item => item.status === 'new').length >= 20) return json(res, 409, { error: 'У клиента слишком много непрочитанных рекомендаций.' });
      const recommendation = { id: randomUUID(), author: actor.login, text, status: 'new', createdAt: new Date().toISOString() };
      link.recommendations.push(recommendation);
      link.recommendations = link.recommendations.slice(-100);
      addNotification(link.clientLogin, 'coach-recommendation', 'Новая рекомендация тренера', `Тренер @${actor.login} оставил рекомендацию.`, 'coach');
      await logCoachAction(actor.login, 'recommendation:create', link.id);
      return json(res, 201, { recommendation: { id: recommendation.id, status: recommendation.status, createdAt: recommendation.createdAt } });
    }
    if (recommendationMatch && recommendationMatch[2] && req.method === 'POST') {
      const link = activeCoachLink(recommendationMatch[1]);
      if (!link || link.clientLogin !== actor.login) return json(res, 404, { error: 'Связь не найдена' });
      const recommendation = (link.recommendations || []).find(item => item.id === recommendationMatch[2] && item.status === 'new');
      if (!recommendation) return json(res, 404, { error: 'Рекомендация не найдена или уже отмечена' });
      recommendation.status = 'acknowledged';
      recommendation.acknowledgedAt = new Date().toISOString();
      addNotification(link.trainerLogin, 'recommendation-ack', 'Подопечный прочитал рекомендацию', `Пользователь @${actor.login} отметил рекомендацию как учтённую.`, 'coach');
      await logCoachAction(actor.login, 'recommendation:acknowledge', link.id);
      return json(res, 200, { ok: true });
    }
    if (nutritionGoalMatch && !nutritionGoalMatch[2] && req.method === 'POST') {
      const link = activeCoachLink(nutritionGoalMatch[1]);
      if (!userHasRole(state.users[actor.login], 'trainer')) return json(res, 403, { error: 'Режим тренера выдаёт администратор приложения.' });
      if (!link || link.trainerLogin !== actor.login || link.permissions?.nutritionGoals !== true) return json(res, 403, { error: 'Клиент не разрешил предложения целей КБЖУ.' });
      const body = await readBody(req), goals = plainObject(body?.goals) ? body.goals : {};
      const normalizedGoals = { kcal: boundedNumber(goals.kcal, 10000), protein: boundedNumber(goals.protein, 2000), fat: boundedNumber(goals.fat, 2000), carbs: boundedNumber(goals.carbs, 2000) };
      if (!normalizedGoals.kcal || !normalizedGoals.protein || !normalizedGoals.fat || !normalizedGoals.carbs) return json(res, 400, { error: 'Заполни дневные цели: калории, белки, жиры и углеводы должны быть больше нуля.' });
      const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';
      link.nutritionGoalProposals = Array.isArray(link.nutritionGoalProposals) ? link.nutritionGoalProposals : [];
      if (link.nutritionGoalProposals.filter(item => item.status === 'pending').length >= 5) return json(res, 409, { error: 'У клиента уже есть несколько предложений КБЖУ на рассмотрении.' });
      const proposal = { id: randomUUID(), author: actor.login, goals: normalizedGoals, note, startDate: /^\d{4}-\d{2}-\d{2}$/.test(body?.startDate || '') ? body.startDate : new Date().toISOString().slice(0, 10), status: 'pending', createdAt: new Date().toISOString() };
      link.nutritionGoalProposals.push(proposal);
      link.nutritionGoalProposals = link.nutritionGoalProposals.slice(-30);
      addNotification(link.clientLogin, 'nutrition-goals', 'Тренер предложил цели КБЖУ', 'Проверь дневные ориентиры и подтверди или отклони их в кабинете тренера.', 'coach');
      await logCoachAction(actor.login, 'nutrition-goal:propose', link.id);
      return json(res, 201, { proposal: { id: proposal.id, status: proposal.status, createdAt: proposal.createdAt } });
    }
    if (nutritionGoalMatch && nutritionGoalMatch[2] && req.method === 'POST') {
      const link = activeCoachLink(nutritionGoalMatch[1]);
      if (!link || link.clientLogin !== actor.login) return json(res, 404, { error: 'Связь не найдена' });
      if (link.permissions?.nutritionGoals !== true) return json(res, 403, { error: 'Доступ к предложениям целей КБЖУ отозван.' });
      const proposal = (link.nutritionGoalProposals || []).find(item => item.id === nutritionGoalMatch[2] && item.status === 'pending');
      if (!proposal) return json(res, 404, { error: 'Предложение не найдено или уже обработано' });
      if (nutritionGoalMatch[3] === 'accept') {
        const account = state.users[actor.login];
        account.data.nutrition.goals = { ...proposal.goals };
        bumpDataRevision(actor.login);
        proposal.status = 'accepted';
        proposal.acceptedAt = new Date().toISOString();
      } else {
        proposal.status = 'declined';
        proposal.declinedAt = new Date().toISOString();
      }
      proposal.decidedAt = new Date().toISOString();
      addNotification(link.trainerLogin, 'nutrition-goals-decision', `Подопечный ${proposal.status === 'accepted' ? 'принял' : 'отклонил'} цели КБЖУ`, `Пользователь @${actor.login} ${proposal.status === 'accepted' ? 'применил' : 'отклонил'} предложенные цели.`, 'coach');
      await logCoachAction(actor.login, `nutrition-goal:${proposal.status}`, link.id);
      return json(res, 200, { ok: true, status: proposal.status });
    }
    if (messageMatch && req.method === 'POST') {
      const link = activeCoachLink(messageMatch[1]);
      if (!link || !coachPeer(link, actor.login)) return json(res, 404, { error: 'Связь не найдена' });
      const body = await readBody(req);
      const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 1200) : '';
      if (!text) return json(res, 400, { error: 'Напиши сообщение до 1200 символов' });
      link.messages = Array.isArray(link.messages) ? link.messages : [];
      const message = { id: randomUUID(), from: actor.login, text, at: new Date().toISOString() };
      link.messages.push(message);
      link.messages = link.messages.slice(-200);
      addNotification(coachPeer(link, actor.login), 'coach-message', `Новое сообщение от @${actor.login}`, text.slice(0, 160), 'coach');
      await logCoachAction(actor.login, 'message:send', link.id);
      return json(res, 201, { message });
    }
    return json(res, 404, { error: 'Не найдено' });
  }

  if (url.pathname.startsWith('/api/admin/')) {
    const actor = currentUser(req);
    if (!actor) return json(res, 401, { error: 'Войди в профиль' });
    if (!actor.isAdmin) return json(res, 403, { error: 'Недостаточно прав' });
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origin = req.headers.origin;
      try { if (!origin || new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Запрос отклонён' }); }
      catch { return json(res, 403, { error: 'Запрос отклонён' }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/summary') {
      const days = [7, 30, 90].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 30;
      await logAdminAction(actor.login, `summary:${days}`);
      return json(res, 200, { summary: { ...adminSummary(days), programsCount: programNames.size + Object.values(state.users).reduce((sum, user) => sum + (Array.isArray(user.data?.customPrograms) ? user.data.customPrograms.length : 0), 0) } });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/coach-applications') {
      const pendingApplications = Object.values(state.coachApplications || {})
        .filter(item => item?.status === 'pending')
        .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
      if (url.searchParams.get('count') === '1') return json(res, 200, { pendingCount: pendingApplications.length });
      const applications = pendingApplications.slice(0, 100)
        .map(item => ({
          id: item.id, login: item.login, fullName: item.fullName, experienceYears: item.experienceYears,
          about: item.about, specialization: item.specialization, education: item.education,
          status: item.status, createdAt: item.createdAt
        }));
      await logAdminAction(actor.login, `coach-applications:list:${applications.length}`);
      return json(res, 200, { applications, pendingCount: applications.length });
    }
    const coachApplicationReviewMatch = url.pathname.match(/^\/api\/admin\/coach-applications\/([0-9a-f-]{36})\/review$/i);
    if (req.method === 'POST' && coachApplicationReviewMatch) {
      const application = state.coachApplications?.[coachApplicationReviewMatch[1]];
      if (!application) return json(res, 404, { error: 'Заявка не найдена.' });
      if (application.status !== 'pending') return json(res, 409, { error: 'Эта заявка уже обработана.' });
      const body = await readBody(req);
      if (!['approved', 'rejected'].includes(body?.decision)) return json(res, 400, { error: 'Выбери решение: одобрить или отклонить.' });
      const decisionNote = typeof body?.decisionNote === 'string' ? body.decisionNote.trim().slice(0, 500) : '';
      const target = state.users[application.login];
      if (!target) return json(res, 409, { error: 'Аккаунт автора заявки больше не существует.' });
      const previous = { status: application.status, reviewedAt: application.reviewedAt, reviewedBy: application.reviewedBy, decisionNote: application.decisionNote, roles: target.roles, trainerMode: target.trainerMode };
      application.status = body.decision;
      application.reviewedAt = new Date().toISOString();
      application.reviewedBy = actor.login;
      application.decisionNote = decisionNote;
      if (body.decision === 'approved') {
        const roles = Array.isArray(target.roles) ? [...new Set(target.roles.filter(role => typeof role === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(role)))] : (target.trainerMode === true ? ['trainer'] : []);
        target.roles = [...new Set([...roles, 'trainer'])];
        target.trainerMode = true;
      }
      const previousAdminAudit = state.adminAudit;
      state.adminAudit = Array.isArray(state.adminAudit) ? state.adminAudit : [];
      const adminAuditLength = state.adminAudit.length;
      state.adminAudit.push({ login: actor.login, action: `coach-application:${body.decision}:${application.login}`, at: new Date().toISOString() });
      state.adminAudit = state.adminAudit.slice(-1000);
      const previousNotifications = (state.notifications?.[application.login] || []).length;
      addNotification(application.login, `trainer-application-${body.decision}`, body.decision === 'approved' ? 'Заявка на тренерство одобрена' : 'Заявка на тренерство отклонена', decisionNote || (body.decision === 'approved' ? 'Тебе доступен режим тренера.' : 'Администратор рассмотрел твою заявку.'), 'coach');
      try { await writeState(); }
      catch (error) {
        application.status = previous.status;
        application.reviewedAt = previous.reviewedAt;
        application.reviewedBy = previous.reviewedBy;
        application.decisionNote = previous.decisionNote;
        if (previous.roles === undefined) delete target.roles; else target.roles = previous.roles;
        if (previous.trainerMode === undefined) delete target.trainerMode; else target.trainerMode = previous.trainerMode;
        if (Array.isArray(previousAdminAudit)) previousAdminAudit.length = adminAuditLength;
        state.adminAudit = previousAdminAudit;
        if (state.notifications?.[application.login]) state.notifications[application.login].length = previousNotifications;
        throw error;
      }
      return json(res, 200, { ok: true, application: { id: application.id, login: application.login, status: application.status, reviewedAt: application.reviewedAt } });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/users') {
      const query = String(url.searchParams.get('q') || '').trim().toLocaleLowerCase('ru').slice(0, 60);
      const users = Object.values(state.users).filter(user => !query || `${user.login} ${user.data?.profile?.name || ''}`.toLocaleLowerCase('ru').includes(query)).slice(0, 100).map(user => {
        const data = plainObject(user.data) ? user.data : {};
        const sessions = Array.isArray(data.sessions) ? data.sessions : [];
        return { login: user.login, name: String(data.profile?.name || ''), trainerMode: userHasRole(user, 'trainer'), createdAt: user.createdAt || null, lastSeenAt: user.lastSeenAt || null, workouts: sessions.length, program: programNames.get(String(data.programId || '')) || (data.programId ? `Программа ${data.programId}` : ''), nutritionEntries: Object.values(data.nutrition?.entries || {}).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0) };
      });
      await logAdminAction(actor.login, `users:list:${query ? 'search' : 'all'}`);
      return json(res, 200, { users });
    }
    const passwordRecoveryMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/password-recovery$/);
    if (req.method === 'POST' && passwordRecoveryMatch) {
      const login = decodeURIComponent(passwordRecoveryMatch[1]).toLowerCase();
      const target = state.users[login];
      if (!target) return json(res, 404, { error: 'Аккаунт не найден' });
      const code = randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      target.passwordReset = { tokenHash: digest(code), expiresAt, issuedBy: actor.login };
      await logAdminAction(actor.login, `password-recovery:issue:${login}`);
      return json(res, 200, { login, code, expiresAt });
    }
    const userStatsMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/stats$/);
    if (req.method === 'GET' && userStatsMatch) {
      const login = decodeURIComponent(userStatsMatch[1]).toLowerCase();
      const target = state.users[login];
      if (!target) return json(res, 404, { error: 'Аккаунт не найден' });
      const data = plainObject(target.data) ? target.data : {};
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      const nutritionDays = plainObject(data.nutrition?.entries) ? Object.values(data.nutrition.entries).filter(items => Array.isArray(items) && items.length > 0).length : 0;
      const nutritionEntries = Object.values(data.nutrition?.entries || {}).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
      const stats = {
        login: target.login,
        name: String(data.profile?.name || ''),
        createdAt: target.createdAt || null,
        lastSeenAt: target.lastSeenAt || null,
        trainerMode: userHasRole(target, 'trainer'),
        goal: String(data.profile?.goal || ''),
        weight: String(data.profile?.weight || ''),
        workouts: sessions.length,
        recentWorkouts: sessions.slice(-5).reverse().map(session => ({ date: typeof session.date === 'string' ? session.date.slice(0, 40) : '', planName: String(session.planName || programNames.get(String(session.plan || '')) || 'Тренировка').slice(0, 80), durationSeconds: boundedNumber(session.durationSeconds ?? session.duration, 86_400), exercises: boundedNumber(session.exercises, 100) })),
        program: programNames.get(String(data.programId || '')) || (data.programId ? `Программа ${String(data.programId).slice(0, 80)}` : ''),
        customPrograms: Array.isArray(data.customPrograms) ? data.customPrograms.length : 0,
        nutritionEntries,
        nutritionDays
      };
      await logAdminAction(actor.login, `user:stats:${login}`);
      return json(res, 200, { stats });
    }
    const userRolesMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/roles$/);
    if (req.method === 'POST' && userRolesMatch) {
      const login = decodeURIComponent(userRolesMatch[1]).toLowerCase();
      const target = state.users[login];
      if (!target) return json(res, 404, { error: 'Аккаунт не найден' });
      const body = await readBody(req);
      if (body?.role !== 'trainer' || typeof body.enabled !== 'boolean') return json(res, 400, { error: 'Можно назначить или снять только роль тренера.' });
      const roles = Array.isArray(target.roles) ? [...new Set(target.roles.filter(role => typeof role === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(role))) ] : (target.trainerMode === true ? ['trainer'] : []);
      const nextRoles = body.enabled ? [...new Set([...roles, 'trainer'])] : roles.filter(role => role !== 'trainer');
      target.roles = nextRoles;
      target.trainerMode = nextRoles.includes('trainer');
      let endedLinks = 0, revokedInvitations = 0;
      if (!body.enabled && roles.includes('trainer')) {
        for (const invite of Object.values(state.coachInvitations || {})) {
          if (invite?.trainerLogin === login && invite.status === 'pending') {
            invite.status = 'revoked'; invite.revokedAt = new Date().toISOString(); revokedInvitations++;
          }
        }
        for (const link of Object.values(state.coachLinks || {})) {
          if (link?.trainerLogin === login && link.status === 'active') {
            link.status = 'revoked'; link.revokedAt = new Date().toISOString(); link.revokedBy = actor.login; endedLinks++;
            addNotification(link.clientLogin, 'coach-link', 'Режим тренера отключён', 'Администратор снял роль тренера; связь с этим тренером завершена.', 'coach');
          }
        }
      }
      addNotification(login, body.enabled ? 'trainer-role-granted' : 'trainer-role-revoked', body.enabled ? 'Тебе открыт режим тренера' : 'Роль тренера снята', body.enabled ? 'Открой раздел «Тренер и клиент», чтобы создать приглашение и вести подопечных.' : 'Тренерские связи и ожидающие приглашения завершены.', 'coach');
      if (body.enabled) {
        for (const application of Object.values(state.coachApplications || {})) {
          if (application?.login === login && application.status === 'pending') {
            application.status = 'approved';
            application.reviewedAt = new Date().toISOString();
            application.reviewedBy = actor.login;
            application.decisionNote = 'Одобрено администратором.';
          }
        }
      }
      await logAdminAction(actor.login, `role:trainer:${body.enabled ? 'grant' : 'revoke'}:${login}:links-${endedLinks}:invites-${revokedInvitations}`);
      return json(res, 200, { login, roles: nextRoles, trainerMode: target.trainerMode });
    }
    return json(res, 404, { error: 'Не найдено' });
  }

  if (req.method === 'POST' && ['/api/login', '/api/register', '/api/logout'].includes(url.pathname)) {
    const origin = req.headers.origin;
    if (origin) {
      try { if (new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Запрос отклонён' }); }
      catch { return json(res, 403, { error: 'Запрос отклонён' }); }
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/password/recover') {
    const origin = req.headers.origin;
    try { if (!origin || new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Запрос отклонён' }); }
    catch { return json(res, 403, { error: 'Запрос отклонён' }); }
    if (!allowAttempt(req)) return json(res, 429, { error: 'Слишком много попыток. Подожди минуту и попробуй снова.' });
    const body = await readBody(req);
    const login = typeof body?.login === 'string' ? body.login.trim().toLowerCase() : '';
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    try { validateLogin(login, body?.newPassword); }
    catch (error) { return json(res, error.status || 400, { error: error.message }); }
    const account = state.users[login];
    const reset = account?.passwordReset;
    const suppliedHash = Buffer.from(digest(code), 'hex');
    const savedHash = Buffer.from(reset?.tokenHash || '', 'hex');
    const validCode = /^[A-Za-z0-9_-]{32}$/.test(code) && savedHash.length === suppliedHash.length && timingSafeEqual(savedHash, suppliedHash);
    if (!validCode || !reset || !Number.isFinite(Date.parse(reset.expiresAt)) || Date.parse(reset.expiresAt) <= Date.now()) {
      return json(res, 400, { error: 'Код восстановления недействителен или истёк. Обратись к администратору приложения за новым кодом.' });
    }
    await updatePassword(login, body.newPassword);
    return json(res, 200, { ok: true, message: 'Пароль обновлён. Теперь войди с новым паролем.' });
  }

  if (req.method === 'PUT' && url.pathname === '/api/account/password') {
    const actor = currentUser(req);
    if (!actor) return json(res, 401, { error: 'Войди в профиль' });
    const origin = req.headers.origin;
    try { if (!origin || new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Запрос отклонён' }); }
    catch { return json(res, 403, { error: 'Запрос отклонён' }); }
    if (!allowAttempt(req)) return json(res, 429, { error: 'Слишком много попыток. Подожди минуту и попробуй снова.' });
    const body = await readBody(req);
    if (typeof body?.newPassword !== 'string' || body.newPassword.length < 8 || body.newPassword.length > 128) return json(res, 400, { error: 'Новый пароль должен содержать от 8 до 128 символов.' });
    if (!(await passwordMatches(state.users[actor.login], body.currentPassword))) return json(res, 403, { error: 'Текущий пароль не подошёл.' });
    await updatePassword(actor.login, body.newPassword, res);
    return json(res, 200, { ok: true, message: 'Пароль изменён. Остальные сессии завершены.' });
  }

  if (req.method === 'DELETE' && url.pathname === '/api/account') {
    const actor = currentUser(req);
    if (!actor) return json(res, 401, { error: 'Войди в профиль' });
    const origin = req.headers.origin;
    try { if (!origin || new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Запрос отклонён' }); }
    catch { return json(res, 403, { error: 'Запрос отклонён' }); }
    if (actor.isAdmin) return json(res, 403, { error: 'Сначала переназначь RITM_ADMIN_LOGIN на другой аккаунт, затем удали этот профиль.' });
    const body = await readBody(req);
    if (typeof body?.confirmLogin !== 'string' || body.confirmLogin.trim().toLowerCase() !== actor.login || !(await passwordMatches(state.users[actor.login], body.password))) {
      return json(res, 403, { error: 'Проверь пароль и введи логин аккаунта полностью.' });
    }
    const avatarKey = avatarKeyFor(actor.login);
    const previous = {
      users: state.users, sessions: state.sessions, coachInvitations: state.coachInvitations,
      coachLinks: state.coachLinks, coachApplications: state.coachApplications, coachAudit: state.coachAudit,
      adminAudit: state.adminAudit, notifications: state.notifications, telegramAccounts: state.telegramAccounts,
      telegramLinkCodes: state.telegramLinkCodes, telegramOutbox: state.telegramOutbox
    };
    state.users = { ...state.users };
    delete state.users[actor.login];
    state.sessions = Object.fromEntries(Object.entries(state.sessions).filter(([, session]) => session.login !== actor.login));
    state.coachInvitations = Object.fromEntries(Object.entries(state.coachInvitations || {}).filter(([, invite]) => invite?.trainerLogin !== actor.login && invite?.acceptedBy !== actor.login));
    state.coachLinks = Object.fromEntries(Object.entries(state.coachLinks || {}).filter(([, link]) => link?.trainerLogin !== actor.login && link?.clientLogin !== actor.login));
    state.coachApplications = Object.fromEntries(Object.entries(state.coachApplications || {}).filter(([, application]) => application?.login !== actor.login));
    state.coachAudit = (Array.isArray(state.coachAudit) ? state.coachAudit : []).filter(item => item?.login !== actor.login);
    state.adminAudit = (Array.isArray(state.adminAudit) ? state.adminAudit : []).filter(item => item?.login !== actor.login && !String(item?.action || '').split(':').includes(actor.login));
    const accountMention = `@${actor.login}`.toLocaleLowerCase('en-US');
    state.notifications = Object.fromEntries(Object.entries(plainObject(state.notifications) ? state.notifications : {}).flatMap(([recipient, items]) => {
      if (recipient === actor.login) return [];
      if (!Array.isArray(items)) return [[recipient, items]];
      const retained = items.filter(item => ![item?.title, item?.body].some(value => String(value || '').toLocaleLowerCase('en-US').includes(accountMention)));
      return retained.length ? [[recipient, retained]] : [];
    }));
    state.telegramAccounts = Object.fromEntries(Object.entries(plainObject(state.telegramAccounts) ? state.telegramAccounts : {}).filter(([login]) => login !== actor.login));
    state.telegramLinkCodes = Object.fromEntries(Object.entries(plainObject(state.telegramLinkCodes) ? state.telegramLinkCodes : {}).filter(([, item]) => item?.login !== actor.login));
    removeTelegramOutboxFor(actor.login);
    try { await writeState(); }
    catch (error) { Object.assign(state, previous); throw error; }
    try { await removeUnusedAvatar(avatarKey); }
    catch (error) { console.error(`Не удалось удалить неиспользуемый аватар после удаления аккаунта: ${error.message}`); }
    return json(res, 200, { ok: true, message: 'Аккаунт и связанные с ним данные удалены.' }, { 'Set-Cookie': cookieHeader('', true) });
  }

  if (req.method === 'POST' && (url.pathname === '/api/login' || url.pathname === '/api/register')) {
    if (!allowAttempt(req)) return json(res, 429, { error: 'Слишком много попыток. Подожди минуту и попробуй снова.' });
    const body = await readBody(req);
    if (!plainObject(body)) return json(res, 400, { error: 'Проверь логин и пароль' });
    const login = validateLogin(body.login, body.password);
    const existing = state.users[login];
    if (url.pathname === '/api/register') {
      if (existing) return json(res, 409, { error: 'Этот логин уже занят' });
      const salt = randomBytes(16).toString('hex');
      const passwordHash = (await scrypt(body.password, salt, 64)).toString('hex');
      let data = body.initialData === undefined ? normalizeData({}) : normalizeData(body.initialData);
      state.users[login] = { login, salt, passwordHash, createdAt: new Date().toISOString(), roles: [], trainerMode: false, data };
      try { await issueSession(res, login); }
      catch (error) { delete state.users[login]; throw error; }
      return json(res, 201, { user: { login, isAdmin: isAdmin(login), trainerMode: false }, data });
    }
    const salt = existing?.salt || 'ritm-invalid-account-salt';
    const actual = await scrypt(body.password, salt, 64);
    const expected = existing ? Buffer.from(existing.passwordHash, 'hex') : Buffer.alloc(64);
    if (!existing || expected.length !== actual.length || !timingSafeEqual(expected, actual)) return json(res, 401, { error: 'Неверный логин или пароль' });
    state.sessions = Object.fromEntries(Object.entries(state.sessions).filter(([, session]) => session.expiresAt > Date.now()));
    await issueSession(res, login);
    if (existing && (!existing.lastSeenAt || Date.now() - Date.parse(existing.lastSeenAt) >= 60 * 60_000)) existing.lastSeenAt = new Date().toISOString();
    await writeState();
    return json(res, 200, { user: { login, isAdmin: isAdmin(login), trainerMode: userHasRole(existing, 'trainer') } });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const user = currentUser(req);
    if (user) { delete state.sessions[user.key]; await writeState(); }
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', true) });
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    const user = currentUser(req);
    return user ? json(res, 200, { user: { login: user.login, isAdmin: user.isAdmin, trainerMode: userHasRole(state.users[user.login], 'trainer') } }) : json(res, 401, { error: 'Войди в профиль' });
  }

  if (req.method === 'GET' && (url.pathname === '/api/nutrition/search' || url.pathname === '/api/nutrition/barcode')) {
    if (!currentUser(req)) return json(res, 401, { error: 'Войди в профиль' });
    try {
      if (url.pathname === '/api/nutrition/search') {
        const query = String(url.searchParams.get('q') || '').trim().replace(/\s+/g, ' ');
        if (query.length < 2 || query.length > 80) return json(res, 400, { error: 'Введи от 2 до 80 символов для поиска' });
        try {
          const latestCatalog = JSON.parse(await readFile(nutritionCatalogFile, 'utf8'));
          if (Array.isArray(latestCatalog?.products)) nutritionCatalog = latestCatalog.products.filter(product => product && ['openfoodfacts', 'rospotrebnadzor'].includes(product.source) && typeof product.id === 'string' && typeof product.name === 'string');
        } catch (error) {
          if (error.code !== 'ENOENT') console.error(`Не удалось обновить локальный каталог продуктов: ${error.message}`);
        }
        const normalizedQuery = query.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е');
        const localProducts = nutritionCatalog.filter(product => `${product.name} ${product.originalName || ''} ${product.brand || ''} ${product.barcode || ''} ${product.category || ''} ${product.searchAliases || ''}`.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е').includes(normalizedQuery)).slice(0, 20);
        if (localProducts.length >= 8) return json(res, 200, { products: localProducts, source: 'catalog', catalogCount: localProducts.length, externalCount: 0 });
        const cacheKey = `search:${query.toLocaleLowerCase('ru')}`;
        let externalProducts = [];
        let apiUnavailable = false;
        try {
          externalProducts = await cachedOpenFoodFacts(cacheKey, async () => {
            if (!allowOpenFoodFactsRequest('search', 8)) throw Object.assign(new Error('Достигнут лимит поиска. Подожди минуту и попробуй снова.'), { status: 429 });
            const data = await fetchOpenFoodFacts(openFoodFactsSearchUrl(query), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(openFoodFactsSearchBody(query))
            });
            const unique = new Map();
            for (const raw of Array.isArray(data.hits) ? data.hits : Array.isArray(data.products) ? data.products : []) {
              const product = normalizeOpenFoodFactsProduct(raw);
              if (product && !unique.has(product.id)) unique.set(product.id, product);
            }
            return [...unique.values()].slice(0, 20);
          });
        } catch (error) {
          if (!localProducts.length) throw error;
          apiUnavailable = true;
        }
        const merged = new Map();
        for (const product of [...localProducts, ...externalProducts]) {
          const key = product.barcode || product.id;
          if (!merged.has(key)) merged.set(key, product);
        }
        const products = [...merged.values()].slice(0, 20);
        return json(res, 200, { products, source: localProducts.length ? 'catalog+openfoodfacts' : 'openfoodfacts', catalogCount: localProducts.length, externalCount: externalProducts.length, apiUnavailable });
      }

      const code = String(url.searchParams.get('code') || '').replace(/\D/g, '');
      if (!/^\d{8,14}$/.test(code)) return json(res, 400, { error: 'Штрихкод должен содержать от 8 до 14 цифр' });
      const product = await cachedOpenFoodFacts(`barcode:${code}`, async () => {
        if (!allowOpenFoodFactsRequest('barcode', 12)) throw Object.assign(new Error('Сканер временно ограничил запросы. Подожди минуту.'), { status: 429 });
        const data = await fetchOpenFoodFacts(openFoodFactsBarcodeUrl(code));
        const normalized = normalizeOpenFoodFactsProduct(data.product);
        return data.status === 'success' ? normalized : null;
      }, 60 * 60_000);
      return product ? json(res, 200, { product, source: 'openfoodfacts' }) : json(res, 404, { error: 'В Open Food Facts нет продукта с таким штрихкодом или его пищевая ценность неполная. Попробуй поиск по названию или добавь данные с упаковки.' });
    } catch (error) {
      if (error.status === 429) return json(res, 429, { error: error.message });
      return json(res, 503, { error: 'Не удалось связаться с Open Food Facts. Попробуй позже или добавь продукт вручную.' });
    }
  }

  if (['GET', 'PUT', 'DELETE'].includes(req.method) && url.pathname === '/api/profile/avatar') {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: 'Войди в профиль' });
    const existingKey = avatarKeyFor(user.login);
    if (req.method === 'GET') {
      if (!existingKey) return json(res, 404, { error: 'Аватар не установлен' });
      try {
        const image = await readFile(path.join(avatarDir, `${existingKey}.jpg`));
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': image.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
        return res.end(image);
      } catch (error) {
        if (error.code === 'ENOENT') return json(res, 404, { error: 'Аватар не найден' });
        throw error;
      }
    }
    if (req.method === 'DELETE') {
      if (!existingKey) return json(res, 200, { ok: true, avatar: null });
      delete state.users[user.login].data.profile.avatarKey;
      try { await writeState(); }
      catch (error) { state.users[user.login].data.profile.avatarKey = existingKey; throw error; }
      await removeUnusedAvatar(existingKey);
      return json(res, 200, { ok: true, avatar: null });
    }
    const image = await readAvatarBody(req);
    if (!validAvatarJpeg(image)) return json(res, 400, { error: 'Не удалось проверить изображение. Выбери другой файл и попробуй снова.' });
    await mkdir(avatarDir, { recursive: true, mode: 0o700 });
    const newKey = randomUUID();
    const newFile = path.join(avatarDir, `${newKey}.jpg`);
    await writeFile(newFile, image, { flag: 'wx', mode: 0o600 });
    state.users[user.login].data.profile.avatarKey = newKey;
    try { await writeState(); }
    catch (error) {
      if (existingKey) state.users[user.login].data.profile.avatarKey = existingKey;
      else delete state.users[user.login].data.profile.avatarKey;
      await unlink(newFile).catch(() => {});
      throw error;
    }
    await removeUnusedAvatar(existingKey);
    return json(res, 200, { ok: true, avatar: newKey });
  }

  if ((req.method === 'GET' || req.method === 'PUT') && url.pathname === '/api/data') {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: 'Войди в профиль' });
    if (req.method === 'GET') return json(res, 200, { data: state.users[user.login].data, revision: dataRevisionFor(user.login) });
    const currentRevision = dataRevisionFor(user.login);
    const ifMatch = req.headers['if-match'];
    if (ifMatch === undefined) return json(res, 428, { code: 'data_revision_required', error: 'Обнови страницу, чтобы продолжить безопасное сохранение профиля.' });
    const expectedRevision = Number(String(ifMatch).replace(/^"|"$/g, ''));
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== currentRevision) return json(res, 409, { code: 'data_revision_conflict', error: 'Данные профиля изменились в другом окне. Обнови страницу и повтори последнее действие.' });
    const body = await readBody(req);
    const latestRevision = dataRevisionFor(user.login);
    if (expectedRevision !== latestRevision) return json(res, 409, { code: 'data_revision_conflict', error: 'Данные профиля изменились в другом окне. Обнови страницу и повтори последнее действие.' });
    const data = normalizeData(body);
    if (!Object.hasOwn(body, 'programProgress') && plainObject(state.users[user.login].data?.programProgress)) data.programProgress = state.users[user.login].data.programProgress;
    const avatarKey = avatarKeyFor(user.login);
    if (avatarKey) data.profile.avatarKey = avatarKey;
    const activeSessionId = state.users[user.login].data?.activeSession?.id;
    const completedSession = activeSessionId ? data.sessions.find(session => session.id === activeSessionId) : null;
    if (completedSession) {
      for (const link of Object.values(state.coachLinks || {})) {
        if (link?.status === 'active' && link.clientLogin === user.login && link.permissions?.workouts === true) {
          const assignment = (Array.isArray(link.workoutAssignments) ? link.workoutAssignments : []).find(item => item.status === 'accepted' && item.customProgramId && item.customProgramId === completedSession.programId);
          if (assignment && !assignment.completedSessionId) {
            assignment.completedSessionId = completedSession.id;
            assignment.completedAt = new Date().toISOString();
          }
          addNotification(link.trainerLogin, 'client-workout-complete', 'Подопечный завершил тренировку', `Пользователь @${user.login} закончил «${String(completedSession.planName || 'тренировку').slice(0, 80)}».`, 'coach');
        }
      }
    }
    state.users[user.login].data = data;
    const revision = bumpDataRevision(user.login);
    await writeState();
    return json(res, 200, { ok: true, revision });
  }

  return json(res, 404, { error: 'Не найдено' });
}

await mkdir(dataDir, { recursive: true });
try {
  const librarySource = await readFile(path.join(root, 'program-library.js'), 'utf8');
  const libraryJson = librarySource.slice(librarySource.indexOf('=') + 1).trim().replace(/;\s*$/, '');
  const library = JSON.parse(libraryJson);
  for (const exercise of Array.isArray(library.exercises) ? library.exercises : []) exerciseNames.set(String(exercise.id), String(exercise.name));
} catch (error) {
  console.error(`Не удалось прочитать названия упражнений для аналитики: ${error.message}`);
}
try {
  const catalog = JSON.parse(await readFile(nutritionCatalogFile, 'utf8'));
  nutritionCatalog = Array.isArray(catalog?.products) ? catalog.products.filter(product => product && ['openfoodfacts', 'rospotrebnadzor'].includes(product.source) && typeof product.id === 'string' && typeof product.name === 'string') : [];
} catch (error) {
  if (error.code !== 'ENOENT') console.error(`Не удалось прочитать локальный каталог продуктов: ${error.message}`);
}
try {
  state = JSON.parse(await readFile(storeFile, 'utf8'));
  if (!plainObject(state) || !plainObject(state.users) || !plainObject(state.sessions)) throw new Error('Неверный формат базы аккаунтов');
  if (!Array.isArray(state.adminAudit)) state.adminAudit = [];
  let coachStateChanged = false;
  if (!plainObject(state.notifications)) { state.notifications = {}; coachStateChanged = true; }
  if (!plainObject(state.coachInvitations)) { state.coachInvitations = {}; coachStateChanged = true; }
  if (!plainObject(state.coachLinks)) { state.coachLinks = {}; coachStateChanged = true; }
  if (!plainObject(state.coachApplications)) { state.coachApplications = {}; coachStateChanged = true; }
  if (!Array.isArray(state.coachAudit)) { state.coachAudit = []; coachStateChanged = true; }
  if (!plainObject(state.telegramAccounts)) { state.telegramAccounts = {}; coachStateChanged = true; }
  if (!plainObject(state.telegramLinkCodes)) { state.telegramLinkCodes = {}; coachStateChanged = true; }
  if (!Array.isArray(state.telegramOutbox)) { state.telegramOutbox = []; coachStateChanged = true; }
  if (!plainObject(state.telegramUpdates)) { state.telegramUpdates = {}; coachStateChanged = true; }
  for (const [login, account] of Object.entries(state.telegramAccounts)) {
    const chatId = String(account?.chatId || '');
    if (!state.users[login] || !/^[1-9]\d{0,19}$/.test(chatId)) {
      delete state.telegramAccounts[login];
      coachStateChanged = true;
      continue;
    }
    const preferences = normalizeTelegramPreferences(account.preferences);
    if (JSON.stringify(preferences) !== JSON.stringify(account.preferences) || account.chatId !== chatId || account.enabled !== (account.enabled === true)) coachStateChanged = true;
    state.telegramAccounts[login] = { chatId, linkedAt: typeof account.linkedAt === 'string' ? account.linkedAt : new Date().toISOString(), enabled: account.enabled === true, preferences, ...(account.deliveryStatus === 'needs-attention' || account.deliveryStatus === 'server-configuration' ? { deliveryStatus: account.deliveryStatus } : {}) };
  }
  for (const [codeHash, invite] of Object.entries(state.telegramLinkCodes)) {
    if (!/^[a-f0-9]{64}$/.test(codeHash) || !state.users[invite?.login] || !Number.isFinite(Number(invite?.expiresAt)) || Number(invite.expiresAt) <= Date.now()) {
      delete state.telegramLinkCodes[codeHash];
      coachStateChanged = true;
    }
  }
  const telegramOutbox = state.telegramOutbox.filter(item => item?.status === 'pending' && state.users[item.login] && item.notificationId && telegramCategoryForType(item.type) && Number(item.nextAttemptAt) > Date.now() - 24 * 60 * 60_000).slice(-2000);
  if (telegramOutbox.length !== state.telegramOutbox.length) coachStateChanged = true;
  state.telegramOutbox = telegramOutbox;
  const telegramUpdates = Object.fromEntries(Object.entries(state.telegramUpdates).filter(([, at]) => Number.isFinite(Number(at))).sort((a, b) => Number(a[1]) - Number(b[1])).slice(-1000));
  if (Object.keys(telegramUpdates).length !== Object.keys(state.telegramUpdates).length) coachStateChanged = true;
  state.telegramUpdates = telegramUpdates;
  const legacyTrainers = new Set([
    ...Object.values(state.coachInvitations).map(invite => invite?.trainerLogin),
    ...Object.values(state.coachLinks).map(link => link?.trainerLogin)
  ].filter(login => typeof login === 'string'));
  for (const [login, user] of Object.entries(state.users)) {
    if (!Array.isArray(user.roles)) {
      // Older trainer links are the only legacy evidence retained as a role;
      // the former self-service boolean alone is not an admin grant.
      user.roles = legacyTrainers.has(login) ? ['trainer'] : [];
      coachStateChanged = true;
    }
    const cleanRoles = [...new Set(user.roles.filter(role => typeof role === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(role)))];
    if (cleanRoles.length !== user.roles.length) coachStateChanged = true;
    user.roles = cleanRoles;
    const trainerMode = user.roles.includes('trainer');
    if (user.trainerMode !== trainerMode) { user.trainerMode = trainerMode; coachStateChanged = true; }
  }
  if (coachStateChanged) await writeState();
  if (!state.metricsStartedAt) { state.metricsStartedAt = new Date().toISOString(); await writeState(); }
} catch (error) {
  if (error.code === 'ENOENT') { state = emptyState(); await writeState(); }
  else throw new Error(`Не удалось безопасно прочитать базу аккаунтов (${storeFile}): ${error.message}`);
}
if (!state.metricsStartedAt) { state.metricsStartedAt = new Date().toISOString(); await writeState(); }

createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error('Request failed:', error);
    json(res, error.status || 500, { error: error.status ? error.message : 'Ошибка сервера. Повтори попытку.' });
  });
}).listen(port, host, () => {
  console.log(`СЛАБОЕ ТЕЛО запущено: http://localhost:${port}`);
  console.log('Данные аккаунтов хранятся в папке data. Для публикации снаружи используй HTTPS reverse proxy.');
  queueMicrotask(() => { void drainTelegramOutbox(); });
});
