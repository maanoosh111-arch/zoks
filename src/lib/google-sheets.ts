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

const GOOGLE_SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/14G5H-cFTOfmW0dHS_OEbz05cuQTbWuEvn8pMgk81Z88/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
  WORKSHEET_NAME
)}`;

const CACHE_TTL_MS = 15 * 1000;

let cachedInternalCatalog: {
  data: InternalCatalogResult;
  timestamp: number;
} | null = null;

// All products must strictly come from the official Google Sheet only. No fake or mock products.
export const FALLBACK_PRODUCTS: InternalProduct[] = [];

export function parseCSV(csvText: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        currentField += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        currentRow.push(currentField);
        currentField = "";
      } else if (char === "\r" && nextChar === "\n") {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = "";
        i++;
      } else if (char === "\n" || char === "\r") {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = "";
      } else {
        currentField += char;
      }
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  return rows;
}

function parseNumericPrice(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.-]/g, "").trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function parseNumericProfit(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.includes("%")) return null;
  const cleaned = trimmed.replace(/[^\d.-]/g, "").trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function extractUrls(rawCells: string[]): string[] {
  const urls: string[] = [];
  for (const cell of rawCells) {
    if (!cell) continue;
    const parts = cell
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
    const response = await fetch(GOOGLE_SHEET_CSV_URL, {
      cache: "no-store",
      headers: {
        Accept: "text/csv,text/plain,*/*",
      },
    });

    if (!response.ok) {
      throw new Error(`Google Sheet returned HTTP ${response.status}`);
    }

    const csvText = await response.text();
    if (!csvText || !csvText.trim()) {
      throw new Error("Empty CSV received");
    }

    const rows = parseCSV(csvText);
    if (rows.length < 2) {
      throw new Error("Not enough rows in CSV");
    }

    const headerRow = rows[0].map((h) => h.trim().toLowerCase());
    const colIndex = {
      category: headerRow.findIndex((h) => h === "category"),
      productName: headerRow.findIndex((h) => h === "product name"),
      price: headerRow.findIndex((h) => h === "price"),
      profit: headerRow.findIndex((h) => h === "profit"),
      description: headerRow.findIndex((h) => h === "description"),
      primaryImage: headerRow.findIndex((h) => h === "primary image"),
      extraImages: headerRow.findIndex((h) => h === "extra images"),
    };

    if (colIndex.category === -1 || colIndex.productName === -1 || colIndex.price === -1) {
      throw new Error("Missing required columns in Sheet");
    }

    const products: InternalProduct[] = [];
    const categoriesSet = new Set<string>();
    let currentCategory = "";

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.every((c) => !c.trim())) continue;

      const rawCat = (row[colIndex.category] ?? "").trim();
      if (rawCat) currentCategory = rawCat;
      const effectiveCategory = rawCat || currentCategory;

      const rawName = (row[colIndex.productName] ?? "").trim();
      const rawPrice = (row[colIndex.price] ?? "").trim();

      if (!effectiveCategory || !rawName || !rawPrice) continue;

      const price = parseNumericPrice(rawPrice);
      if (price === null) continue;

      const rawProfit = colIndex.profit !== -1 ? row[colIndex.profit] : undefined;
      const profit = parseNumericProfit(rawProfit);

      const description =
        colIndex.description !== -1 ? (row[colIndex.description] ?? "").trim() : "";

      const primaryImageRaw =
        colIndex.primaryImage !== -1 ? (row[colIndex.primaryImage] ?? "").trim() : "";
      const primaryUrls = extractUrls([primaryImageRaw]);
      const primaryImage = primaryUrls[0] || "";

      const extraCells: string[] = [];
      if (colIndex.extraImages !== -1) {
        extraCells.push(row[colIndex.extraImages] ?? "");
        for (let c = colIndex.extraImages + 1; c < row.length; c++) {
          if (!headerRow[c]) {
            extraCells.push(row[c] ?? "");
          }
        }
      }

      const extraImages = extractUrls(extraCells).filter((u) => u !== primaryImage);
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
      categories:
        categoriesSet.size > 0
          ? Array.from(categoriesSet)
          : [],
      fetchedAt: new Date().toISOString(),
      fromFallbackCache: false,
    };

    cachedInternalCatalog = {
      data: result,
      timestamp: now,
    };

    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Error fetching sheet";
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
