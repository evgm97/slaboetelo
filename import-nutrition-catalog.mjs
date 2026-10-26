import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeOpenFoodFactsProduct, openFoodFactsSearchBody, openFoodFactsSearchUrl } from './nutrition-source.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
const catalogFile = path.join(dataDir, 'nutrition-catalog.json');
const userAgent = (process.env.RITM_OFF_USER_AGENT || 'SlaboeTelo/1.0 (nutrition catalog import; http://localhost:8766)').slice(0, 200);
const terms = [
  'гречка', 'овсянка', 'творог', 'куриная грудка', 'кефир', 'молоко', 'банан', 'рис',
  'бородинский хлеб', 'пельмени', 'колбаса докторская', 'ряженка', 'квас',
  'Простоквашино', 'Мираторг', 'ВкусВилл'
];
const searchDelayMs = 6500;

let previous = { products: [] };
try {
  previous = JSON.parse(await readFile(catalogFile, 'utf8'));
  if (!Array.isArray(previous.products)) previous = { products: [] };
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error(`Не удалось прочитать локальный каталог без риска перезаписи: ${error.message}`);
}

// Keep locally curated reference rows from other sources when refreshing OFF.
const preservedProducts = previous.products.filter(item => item?.source !== 'openfoodfacts');
const products = new Map(previous.products.filter(item => item?.source === 'openfoodfacts' && typeof item.sourceId === 'string').map(item => [item.sourceId, item]));
const knownBefore = new Set(products.keys());
const seenThisRun = new Set();
let added = 0;
let updated = 0;
let skipped = 0;
let failedQueries = 0;
let requestsMade = 0;

for (const term of terms) {
  try {
    if (requestsMade > 0) await new Promise(resolve => setTimeout(resolve, searchDelayMs));
    requestsMade++;
    const response = await fetch(openFoodFactsSearchUrl(term), {
      method: 'POST',
      headers: { 'User-Agent': userAgent, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(openFoodFactsSearchBody(term)),
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const hits = Array.isArray(data.hits) ? data.hits : [];
    for (const hit of hits) {
      const product = normalizeOpenFoodFactsProduct(hit);
      if (!product) { skipped++; continue; }
      const id = product.sourceId;
      if (seenThisRun.has(id)) { skipped++; continue; }
      seenThisRun.add(id);
      product.importedAt = new Date().toISOString();
      if (knownBefore.has(id)) updated++;
      else added++;
      products.set(id, product);
    }
    console.log(`«${term}»: найдено ${hits.length}, пригодно для каталога ${hits.filter(hit => normalizeOpenFoodFactsProduct(hit)).length}`);
  } catch (error) {
    failedQueries++;
    console.error(`Не удалось загрузить «${term}»: ${error.message}`);
  }
}

if (failedQueries === terms.length) throw new Error('Все запросы завершились ошибкой. Локальный каталог не перезаписан.');
if (products.size === 0) throw new Error('Не удалось получить ни одного пригодного продукта. Файл каталога не создан.');

const catalog = {
  title: 'Каталог продуктов для приложения «Слабое тело»',
  attribution: 'Open Food Facts contributors; Rospotrebnadzor food composition table',
  attributionUrl: 'https://zpp.rospotrebnadzor.ru/advices/57827',
  databaseLicense: 'Mixed; see source-specific licenses below',
  contentLicense: 'Mixed; see source-specific licenses below',
  sources: [
    { id: 'openfoodfacts', name: 'Open Food Facts contributors', url: 'https://world.openfoodfacts.org/', databaseLicense: 'ODbL-1.0', contentLicense: 'DbCL-1.0', note: 'Community-contributed product data; completeness and accuracy vary.' },
    { id: 'rospotrebnadzor', name: 'Rospotrebnadzor, Table 1: nutrient content and energy value of selected foods', url: 'https://zpp.rospotrebnadzor.ru/advices/57827', note: 'Published values per 100 g; fiber is not provided in the source.' }
  ],
  importedAt: new Date().toISOString(),
  searchTerms: terms,
  products: [...preservedProducts, ...products.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
};

await mkdir(dataDir, { recursive: true });
const temporaryFile = `${catalogFile}.${randomUUID()}.tmp`;
await writeFile(temporaryFile, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
await rename(temporaryFile, catalogFile);

console.log(`\nКаталог записан: ${catalog.products.length} продуктов.`);
console.log(`Добавлено: ${added}; обновлено: ${updated}; пропущено (нет калорийности/штрихкода или дубли): ${skipped}; запросов не удалось выполнить: ${failedQueries}.`);
console.log(`С полными КБЖУ: ${catalog.products.filter(product => [product.protein, product.fat, product.carbs].every(value => value !== null)).length}.`);
