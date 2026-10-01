/** Bot names and the species wheel. Bot names are reserved: a player cannot take one. */
export const BOT_NAMES = [
  "Ember", "Comet", "Tide", "Biscuit", "Noodle", "Plum", "Soba", "Miso", "Yuzu", "Mochi", "Dango", "Nori",
  "Taro", "Kiki", "Bao", "Udon", "Sesame", "Ginger", "Pepper", "Tofu", "Wasabi", "Panko", "Ramen", "Matcha",
  "Kombu", "Daikon", "Sumo", "Bento", "Tanuki", "Hoshi", "Fugu", "Sardine",
] as const;

export const BOT_NAME_SET: ReadonlySet<string> = new Set(BOT_NAMES.map((n) => n.toLowerCase()));

/** Number of fish looks the renderer knows. A fish keeps its look for life. */
export const SKIN_COUNT = 10;

export function skinForIndex(i: number): number {
  // Step by 3 so consecutive spawns never look alike.
  return (((i * 3) % SKIN_COUNT) + SKIN_COUNT) % SKIN_COUNT;
}

/** Player names: 2–14 visible characters, letters/digits/space/_-. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > 14) return null;
  if (!/^[\p{L}\p{N} _\-]+$/u.test(s)) return null;
  if (BOT_NAME_SET.has(s.toLowerCase())) return null;
  return s;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
