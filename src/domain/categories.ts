/** Supermarket categories, in roughly the order a shop is walked. Labels are user-facing copy. */
export const CATEGORIES = {
  produce: 'פירות וירקות',
  dairy: 'מוצרי חלב וביצים',
  bakery: 'לחם ומאפים',
  meat: 'בשר, עוף ודגים',
  pantry: 'מזווה',
  frozen: 'קפואים',
  drinks: 'משקאות',
  snacks: 'חטיפים ומתוקים',
  cleaning: 'ניקיון',
  hygiene: 'היגיינה וטיפוח',
  baby: 'תינוקות',
  household: 'בית ושונות',
} as const;

export type CategoryId = keyof typeof CATEGORIES;

export const CATEGORY_IDS = Object.keys(CATEGORIES) as CategoryId[];

export function isCategoryId(value: unknown): value is CategoryId {
  return typeof value === 'string' && value in CATEGORIES;
}
