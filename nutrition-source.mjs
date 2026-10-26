const OFF_ORIGIN = 'https://world.openfoodfacts.org';
const SEARCH_ORIGIN = 'https://search.openfoodfacts.org';

function numericNutrient(value, max = 100) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= max
    ? Math.round(number * 10) / 10
    : null;
}

function localizedText(product, key) {
  const candidates = [product?.[`${key}_ru`], product?.[key], product?.[`${key}_en`]];
  return candidates.find(value => typeof value === 'string' && value.trim())?.trim() || '';
}

export function normalizeOpenFoodFactsProduct(product) {
  if (!product || typeof product !== 'object') return null;

  const code = String(product.code || product._id || '').replace(/\D/g, '').slice(0, 32);
  const name = localizedText(product, 'product_name')
    || localizedText(product, 'generic_name');
  const nutriments = product.nutriments && typeof product.nutriments === 'object'
    ? product.nutriments
    : {};
  const energyKcal = numericNutrient(nutriments['energy-kcal_100g'], 1000);
  const energyKj = numericNutrient(nutriments['energy-kj_100g'], 4184);
  const kcal = energyKcal ?? (energyKj === null ? null : Math.round((energyKj / 4.184) * 10) / 10);

  // A usable diary product needs a real name and a reported/convertible energy value.
  // Missing macros stay null so the UI can show “—” instead of inventing zeroes.
  if (!name || kcal === null || kcal > 1000) return null;

  const brandValue = Array.isArray(product.brands)
    ? product.brands.find(value => typeof value === 'string' && value.trim()) || ''
    : String(product.brands || '').split(',')[0];
  const brand = String(brandValue).trim().slice(0, 60);
  const sourceId = code || String(product._id || '').replace(/\D/g, '').slice(0, 32);
  if (!sourceId) return null;

  return {
    id: `off-${sourceId}`,
    source: 'openfoodfacts',
    sourceId,
    sourceUrl: `${OFF_ORIGIN}/product/${encodeURIComponent(sourceId)}`,
    name: name.slice(0, 80),
    originalName: localizedText(product, 'product_name') || localizedText(product, 'generic_name') || name,
    brand,
    barcode: code,
    category: String(product.categories || product.categories_tags?.[0] || '').split(',')[0].trim().slice(0, 80),
    quantity: String(product.quantity || '').slice(0, 40),
    unit: 'g',
    updatedAt: Number.isFinite(Number(product.last_modified_t)) ? new Date(Number(product.last_modified_t) * 1000).toISOString() : '',
    kcal,
    protein: numericNutrient(nutriments.proteins_100g),
    fat: numericNutrient(nutriments.fat_100g),
    carbs: numericNutrient(nutriments.carbohydrates_100g),
    fiber: numericNutrient(nutriments.fiber_100g),
    imageKey: 'custom',
    kind: 'product'
  };
}

export function openFoodFactsSearchUrl(query) {
  return new URL('/search', SEARCH_ORIGIN);
}

export function openFoodFactsSearchBody(query) {
  return {
    q: query,
    page: 1,
    page_size: 20,
    langs: ['ru', 'en'],
    fields: ['code', 'product_name', 'product_name_ru', 'product_name_en', 'generic_name', 'generic_name_ru', 'brands', 'nutriments', 'quantity', 'categories', 'categories_tags', 'last_modified_t', 'lc']
  };
}

export function openFoodFactsBarcodeUrl(code) {
  const url = new URL(`/api/v3/product/${encodeURIComponent(code)}`, OFF_ORIGIN);
  url.searchParams.set('fields', 'code,product_name,product_name_ru,product_name_en,generic_name,generic_name_ru,brands,nutriments,quantity,lc');
  return url;
}
