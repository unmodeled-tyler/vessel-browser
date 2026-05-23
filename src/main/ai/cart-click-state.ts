const ADD_TO_CART_PATTERNS = [
  "add to cart",
  "add to bag",
  "add to basket",
  "add to my cart",
  "add to my bag",
  "add to my basket",
  "add item to cart",
  "add item to bag",
  "add item to basket",
];

const CART_CLICK_COOLDOWN_MS = 15_000;
const CART_ADDED_TTL_MS = 30 * 60_000;

const recentCartClicks = new Map<string, number>();
const cartAddedProducts = new Map<string, { title: string; ts: number }>();

export function isAddToCartText(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  return ADD_TO_CART_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function recordCartClick(url: string): void {
  recentCartClicks.set(url, Date.now());
  pruneRecentCartClicks();
}

export function hasRecentCartClick(url: string): boolean {
  const recent = recentCartClicks.get(url);
  if (!recent) return false;
  if (Date.now() - recent > CART_CLICK_COOLDOWN_MS) {
    recentCartClicks.delete(url);
    return false;
  }
  return true;
}

export function isDuplicateCartClick(url: string, text: string): boolean {
  return hasRecentCartClick(url) && isAddToCartText(text);
}

export function recordProductAddedToCart(
  url: string,
  productName: string,
): void {
  pruneCartAddedProducts();
  cartAddedProducts.set(normalizeCartProductKey(url), {
    title: productName || url,
    ts: Date.now(),
  });
}

export function isProductAlreadyInCart(url: string): boolean {
  pruneCartAddedProducts();
  return cartAddedProducts.has(normalizeCartProductKey(url));
}

export function getCartAddedSummary(url?: string): string {
  pruneCartAddedProducts();
  const origin = cartOrigin(url);
  const items = Array.from(cartAddedProducts.entries())
    .filter(([key]) => !origin || key.startsWith(`${origin}/`))
    .map(([_path, info]) => `- ${info.title}`)
    .join("\n");

  if (!items) return "";
  const count = items.split("\n").length;
  return `\nAlready in cart (${count} items):\n${items}`;
}

export function clearCartClickState(): void {
  cartAddedProducts.clear();
  recentCartClicks.clear();
}

function pruneRecentCartClicks(now = Date.now()): void {
  for (const [key, ts] of recentCartClicks) {
    if (now - ts > CART_CLICK_COOLDOWN_MS) {
      recentCartClicks.delete(key);
    }
  }
}

function normalizeCartProductKey(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.origin}${pathname}`;
  } catch {
    return url;
  }
}

function pruneCartAddedProducts(now = Date.now()): void {
  for (const [key, entry] of cartAddedProducts) {
    if (now - entry.ts > CART_ADDED_TTL_MS) {
      cartAddedProducts.delete(key);
    }
  }
}

function cartOrigin(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
