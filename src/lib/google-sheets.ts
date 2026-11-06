import type { PublicProduct, InternalProduct } from "./types";

export interface CatalogResult {
  products: PublicProduct[];
  categories: string[];
  fetchedAt: string;
  fromFallbackCache: boolean;
  error?: string;
}

export interface InternalCatalogResult {
  products: InternalProduct[];
  categories: string[];
  fetchedAt: string;
  fromFallbackCache: boolean;
  error?: string;
}

const SPREADSHEET_ID = "14G5H-cFTOfmW0dHS_OEbz05cuQTbWuEvn8pMgk81Z88";
const WORKSHEET_NAME = "Sheet1";
// استخدام رابط API مباشر وآمن يتجاوز حظر وحماية جوجل
const API_URL = `https://opensheet.elk.sh/${SPREADSHEET_ID}/${WORKSHEET_NAME}`;

const CACHE_TTL_MS = 15 * 1000;

let cachedInternalCatalog: {
  data: InternalCatalogResult;
  timestamp: number;
} | null = null;

export const FALLBACK_PRODUCTS: InternalProduct[] = [];

function parseNumericPrice(raw: any): number | null {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^\d.-]/g, "").trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function parseNumericProfit(raw: any): number | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (trimmed.includes("%")) return null;
  const cleaned = trimmed.replace(/[^\d.-]/g, "").trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function extractUrls(rawCells: any[]): string[] {
  const urls: string[] = [];
  for (const cell of rawCells) {
    if (!cell) continue;
    const parts = String(cell)
      .split(/[\s,\n\r|;]+/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith("http://") || s.startsWith("https://"));
    for (const url of parts) {
      if (!urls.includes(url)) {
        urls.push(url);
      }
    }
  }
  return urls;
}

export async function fetchInternalCatalog(options?: {
  forceFresh?: boolean;
}): Promise<InternalCatalogResult> {
  const now = Date.now();
  if (
    !options?.forceFresh &&
    cachedInternalCatalog &&
    now - cachedInternalCatalog.timestamp < CACHE_TTL_MS
  ) {
    return cachedInternalCatalog.data;
  }

  try {
    const response = await fetch(API_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`API returned HTTP ${response.status}`);
    }

    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error("Empty or invalid data received from sheet");
    }

    const products: InternalProduct[] = [];
    const categoriesSet = new Set<string>();
    let currentCategory = "";

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;

      const getVal = (keys: string[]) => {
        for (const key of Object.keys(row)) {
          const cleanKey = key.trim().toLowerCase();
          if (keys.includes(cleanKey)) {
            return row[key];
          }
        }
        return "";
      };

      const rawCat = String(getVal(["category", "فئة", "القسم", "التصنيف"])).trim();
      if (rawCat) currentCategory = rawCat;
      const effectiveCategory = rawCat || currentCategory;

      const rawName = String(getVal(["product name", "name", "اسم المنتج", "المنتج"])).trim();
      const rawPrice = String(getVal(["price", "السعر"])).trim();

      if (!effectiveCategory || !rawName || !rawPrice) continue;

      const price = parseNumericPrice(rawPrice);
      if (price === null) continue;

      const rawProfit = getVal(["profit", "الربح"]);
      const profit = parseNumericProfit(rawProfit);

      const description = String(getVal(["description", "الوصف"])).trim();

      const primaryImageRaw = String(getVal(["primary image", "image", "الصورة", "الصورة الرئيسية"])).trim();
      const primaryUrls = extractUrls([primaryImageRaw]);
      const primaryImage = primaryUrls[0] || "";

      const extraImagesRaw = String(getVal(["extra images", "صور اضافية"])).trim();
      const extraImages = extractUrls([extraImagesRaw]).filter((u) => u !== primaryImage);
      const allImages = primaryImage ? [primaryImage, ...extraImages] : [...extraImages];

      const id = `${effectiveCategory}__${rawName}__${i}`
        .toLowerCase()
        .replace(/\s+/g, "-");

      products.push({
        id,
        category: effectiveCategory,
        name: rawName,
        price,
        priceFormatted: `${price}`,
        profit,
        description,
        image: primaryImage,
        extraImages,
        allImages,
      });

      categoriesSet.add(effectiveCategory);
    }

    const result: InternalCatalogResult = {
      products,
      categories: categoriesSet.size > 0 ? Array.from(categoriesSet) : [],
      fetchedAt: new Date().toISOString(),
      fromFallbackCache: false,
    };

    cachedInternalCatalog = {
      data: result,
      timestamp: now,
    };

    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Error fetching sheet data";
    if (cachedInternalCatalog) {
      return {
        ...cachedInternalCatalog.data,
        fromFallbackCache: true,
        error: errorMsg,
      };
    }

    return {
      products: [],
      categories: [],
      fetchedAt: new Date().toISOString(),
      fromFallbackCache: true,
      error: errorMsg,
    };
  }
}

export function stripProfitFromProduct(p: InternalProduct): PublicProduct {
  return {
    id: p.id,
    category: p.category,
    name: p.name,
    price: p.price,
    priceFormatted: p.priceFormatted,
    description: p.description,
    image: p.image,
    extraImages: p.extraImages,
    allImages: p.allImages,
  };
}

export async function fetchPublicCatalog(options?: {
  forceFresh?: boolean;
}): Promise<CatalogResult> {
  const internal = await fetchInternalCatalog(options);
  return {
    products: internal.products.map(stripProfitFromProduct),
    categories: internal.categories,
    fetchedAt: internal.fetchedAt,
    fromFallbackCache: internal.fromFallbackCache,
    error: internal.error,
  };
}
