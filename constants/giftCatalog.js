export const GIFT_CATEGORY_DEFINITIONS = [
  {
    id: 'trending',
    label: 'Trending Gifts',
    subtitle: 'Most-loved picks lighting up live calls',
  },
  {
    id: 'romantic',
    label: 'Romantic Gifts',
    subtitle: 'Soft, affectionate moments with heartfelt energy',
  },
  {
    id: 'celebration',
    label: 'Celebration Gifts',
    subtitle: 'Joyful surprises for milestones and wins',
  },
  {
    id: 'luxury',
    label: 'Luxury Gifts',
    subtitle: 'Statement pieces with high-status shine',
  },
  {
    id: 'funny',
    label: 'Funny Gifts',
    subtitle: 'Playful drops to keep the vibe lively',
  },
  {
    id: 'seasonal',
    label: 'Seasonal Gifts',
    subtitle: 'Limited-feel favorites for special moods',
  },
];

export const GIFT_CATALOG = [
  {
    id: 'coffee',
    name: 'Coffee',
    assetKey: 'coffee',
    rarity: 'common',
    coinAmount: 29,
    description: 'A warm caffeine boost for an easy, cozy moment.',
    categories: ['trending', 'funny'],
  },
  {
    id: 'rose',
    name: 'Rose',
    assetKey: 'rose',
    rarity: 'common',
    coinAmount: 39,
    description: 'A timeless red rose that says you made my day.',
    categories: ['romantic', 'trending'],
  },
  {
    id: 'chocolate',
    name: 'Chocolate',
    assetKey: 'chocolate',
    rarity: 'common',
    coinAmount: 49,
    description: 'A sweet premium treat to make the call feel warmer.',
    categories: ['romantic', 'seasonal'],
  },
  {
    id: 'teddy_bear',
    name: 'Teddy Bear',
    assetKey: 'teddy_bear',
    rarity: 'rare',
    coinAmount: 99,
    description: 'A soft plush surprise for comfort, cuteness, and charm.',
    categories: ['romantic', 'funny'],
  },
  {
    id: 'cake',
    name: 'Cake',
    assetKey: 'cake',
    rarity: 'rare',
    coinAmount: 129,
    description: 'A celebratory cake for birthdays, wins, and sweet moments.',
    categories: ['celebration', 'seasonal'],
  },
  {
    id: 'bouquet',
    name: 'Bouquet',
    assetKey: 'bouquet',
    rarity: 'rare',
    coinAmount: 159,
    description: 'A lush bouquet for elegant appreciation and admiration.',
    categories: ['romantic', 'celebration'],
  },
  {
    id: 'perfume',
    name: 'Perfume',
    assetKey: 'perfume',
    rarity: 'epic',
    coinAmount: 299,
    description: 'A designer fragrance drop with polished premium energy.',
    categories: ['luxury', 'romantic'],
  },
  {
    id: 'diamond_ring',
    name: 'Diamond Ring',
    assetKey: 'diamond_ring',
    rarity: 'epic',
    coinAmount: 399,
    description: 'A sparkling symbol of deep admiration and standout attention.',
    categories: ['luxury', 'romantic'],
  },
  {
    id: 'luxury_watch',
    name: 'Luxury Watch',
    assetKey: 'luxury_watch',
    rarity: 'epic',
    coinAmount: 499,
    description: 'A refined timepiece that feels exclusive, bold, and sharp.',
    categories: ['luxury', 'trending'],
  },
  {
    id: 'sports_car',
    name: 'Sports Car',
    assetKey: 'sports_car',
    rarity: 'legendary',
    coinAmount: 899,
    description: 'A blazing supercar gift for unforgettable grand entrances.',
    categories: ['luxury', 'funny'],
  },
  {
    id: 'private_jet',
    name: 'Private Jet',
    assetKey: 'private_jet',
    rarity: 'legendary',
    coinAmount: 1199,
    description: 'A sky-high flex that turns the moment instantly premium.',
    categories: ['luxury', 'celebration'],
  },
  {
    id: 'golden_crown',
    name: 'Golden Crown',
    assetKey: 'golden_crown',
    rarity: 'legendary',
    coinAmount: 1499,
    description: 'A royal tribute for listeners who made the call exceptional.',
    categories: ['luxury', 'trending'],
  },
  {
    id: 'palace',
    name: 'Palace',
    assetKey: 'palace',
    rarity: 'legendary',
    coinAmount: 1999,
    description: 'A majestic palace gift reserved for truly iconic moments.',
    categories: ['luxury', 'seasonal'],
  },
];

export const GIFT_BY_ID = new Map(
  GIFT_CATALOG.map((gift) => [gift.id, gift]),
);

export function getGiftById(giftId) {
  if (!giftId) return null;
  return GIFT_BY_ID.get(String(giftId).trim()) || null;
}

export function serializeGiftForClient(gift) {
  return {
    id: gift.id,
    name: gift.name,
    assetKey: gift.assetKey,
    rarity: gift.rarity,
    coinAmount: gift.coinAmount,
    description: gift.description,
    categories: [...gift.categories],
  };
}

export function getGiftCatalogPayload() {
  return {
    version: 'premium-call-gifts-v1',
    categories: GIFT_CATEGORY_DEFINITIONS.map((category) => ({ ...category })),
    gifts: GIFT_CATALOG.map(serializeGiftForClient),
  };
}
