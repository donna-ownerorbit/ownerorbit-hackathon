export type Status = 'available' | 'sold_out_today' | 'sold_out' | 'hidden'

export interface Size {
  id: string
  name: string
  price: number
}

export interface Item {
  id: string
  categoryId: string
  name: string
  description: string
  price: number
  image?: string
  status: Status
  tax: string
  sizes: Size[]
  sku: string
  unit: string
  stock: number
  barcodes: string[]
  trackInventory: boolean
  modifierGroupIds: string[]
  isNew?: boolean
  orders30d: number
}

export interface Category {
  id: string
  name: string
  description: string
  links: number
  collapsed?: boolean
  status: Status
}

export interface ModifierOption {
  id: string
  name: string
  price: number
}

export interface ModifierGroup {
  id: string
  name: string
  min: number
  max: number
  required: boolean
  options: ModifierOption[]
}

export const STATUS_META: Record<Status, { label: string; color: string }> = {
  available: { label: 'Available', color: '#67ad5b' },
  sold_out_today: { label: 'Sold out today', color: '#f0b130' },
  sold_out: { label: 'Sold out indefinitely', color: '#e5483b' },
  hidden: { label: 'Hidden', color: '#9e9eac' },
}

export const UNITS = ['Piece', 'Plate', 'Order', 'Basket', 'Serving', 'Pound', 'Ounce', 'Bottle', 'Can', 'Each']

export const STORES = [
  { id: 'hayward', name: 'Falafel Flare Hayward', address: '22648 Mission Blvd, Hayward, CA 94541' },
  { id: 'fremont', name: 'Falafel Flare Fremont', address: '39150 Fremont Hub, Fremont, CA 94538' },
  { id: 'sanleandro', name: 'Falafel Flare San Leandro', address: '1400 E 14th St, San Leandro, CA 94577' },
]

export const PROVIDERS = [
  { id: 'website', name: 'Online Ordering Website', color: '#f28c28', short: 'W' },
  { id: 'doordash', name: 'DoorDash', color: '#eb1700', short: 'DD' },
  { id: 'ubereats', name: 'Uber Eats', color: '#06c167', short: 'UE' },
  { id: 'grubhub', name: 'Grubhub', color: '#ff8000', short: 'GH' },
]

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
const skuFor = (s: string) => 'SKU-' + hash(s).toString(16).toUpperCase().padStart(8, '0').slice(0, 8)

type Seed = [name: string, price: number, description?: string, image?: string, extra?: Partial<Item>]

const MEAL_NOTE = ' Make it a meal with fries + soda for $4.99.'
const ENTREE_NOTE = ' Comes with hummus or special sauce, salad, pita & rice.'

const SEED: { id: string; name: string; description: string; links: number; items: Seed[] }[] = [
  {
    id: 'starters', name: 'Starters', description: 'Shareable small plates to start your meal.', links: 4,
    items: [
      ['Dolma', 8.99, 'A delightful appetizer of vegetables delicately stuffed in tender grape leaves, seasoned with aromatic herbs.', '/food/dolma.jpg', { stock: -159 }],
      ['Baba Ganoush', 8.99, 'A smooth, smoky roasted eggplant dip, perfect for pairing with warm pita bread.', '/food/baba-ganoush.jpg'],
      ['Chicken Tenders with Fries', 14.99, ''],
      ['Fried Calamari', 12.99, ''],
      ['Quesadilla', 12.99, 'A mouth-watering quesadilla stuffed with melted cheese and your choice of chicken, gyro or veggie.', undefined, { modifierGroupIds: ['quesadilla-protein'] }],
      ['Wings (8 pcs)', 17.99, 'Eight crispy chicken wings tossed in your choice of BBQ, teriyaki, or buffalo sauce.', undefined, { modifierGroupIds: ['wing-sauce'] }],
      ['Butterfly Shrimp with Fries', 12.99, 'Golden butterflied shrimp fried crisp and served with a side of fries.', undefined, { isNew: true }],
    ],
  },
  {
    id: 'wraps', name: 'Wraps', description: 'Make it a meal (fries + soda) for $4.99.', links: 4,
    items: [
      ['Falafel Wrap', 10.99, 'Crispy house-made falafel, lettuce, tomato, pickles and tahini wrapped in warm lavash.' + MEAL_NOTE],
      ['Gyro Wrap', 12.99, 'Thin-sliced seasoned gyro meat with onions, tomato and creamy tzatziki.' + MEAL_NOTE],
      ['Chicken Wrap', 12.99, 'Marinated grilled chicken with garlic sauce, pickles and fresh veggies.' + MEAL_NOTE],
      ['Jumbo Wrap', 13.99, 'Our biggest wrap, loaded with a double portion of your favorite protein.' + MEAL_NOTE],
      ['Club Wrap', 13.99, 'Grilled chicken, beef bacon, lettuce, tomato and ranch.' + MEAL_NOTE],
      ['Philly Wrap', 13.99, 'Shaved steak, grilled peppers and onions with melted provolone.' + MEAL_NOTE],
    ],
  },
  {
    id: 'entrees', name: 'Entrees', description: 'Comes with hummus/special sauce, salad, pita & rice.', links: 4,
    items: [
      ['Chicken Kabab', 22.99, 'Two skewers of saffron-marinated chicken, charbroiled to order.' + ENTREE_NOTE],
      ['Beef Kabab', 24.99, 'Tender cubes of seasoned beef grilled over open flame.' + ENTREE_NOTE],
      ['Lamb Kabab', 24.99, 'Juicy marinated lamb skewers with grilled tomato and onion.' + ENTREE_NOTE],
      ['Chapli Kabab', 19.99, 'Spiced minced beef patties, pan-seared Peshawar style.' + ENTREE_NOTE],
      ['Combo Kabab', 34.99, 'Choice of 1. Chapli & beef tikka or 2. Chicken & lamb.' + ENTREE_NOTE, undefined, { modifierGroupIds: ['combo-choice', 'entree-sauce'] }],
      ['BBQ Lamb Chops', 34.99, 'Four bone-in lamb chops marinated overnight and grilled to perfection.' + ENTREE_NOTE, '/food/bbq-lamb-chops.jpg', { modifierGroupIds: ['entree-sauce'] }],
      ['Falafel Platter', 19.99, 'Six pieces of crispy falafel with tahini.' + ENTREE_NOTE],
      ['Chicken Platter', 21.99, 'Sliced chicken shawarma with garlic toum.' + ENTREE_NOTE],
      ['Gyro Platter', 21.99, 'A generous pile of sliced gyro with tzatziki.' + ENTREE_NOTE],
      ['Combo Platter', 24.99, 'Half chicken shawarma, half gyro.' + ENTREE_NOTE],
      ['Flame Platter', 28.99, 'Our signature mixed grill — chicken, beef and kofta.' + ENTREE_NOTE],
    ],
  },
  {
    id: 'burgers', name: 'Burgers', description: 'Make it a meal (fries + soda) for $4.99.', links: 4,
    items: [
      ['Classic Hamburger', 9.99, 'Quarter-pound halal beef patty, lettuce, tomato, onion and house sauce.'],
      ['Classic Cheese Burger', 10.99, 'Our classic burger topped with melted American cheese.'],
      ['Veggie Burger', 9.99, 'House-made veggie patty with fresh toppings on a toasted bun.'],
      ['Hawaiian Burger', 11.99, 'Grilled pineapple, teriyaki glaze and Swiss cheese.'],
      ['Crispy Chicken Burger', 11.99, 'Buttermilk fried chicken breast, slaw and spicy mayo.'],
      ['Texan Burger', 11.99, 'BBQ sauce, onion rings, pepper jack and jalapeños.'],
      ['Bacon Cheddar Burger', 14.99, 'Beef bacon, sharp cheddar and smoky aioli.'],
      ['Avocado Ranch Burger', 11.99, 'Fresh avocado, ranch and crisp lettuce.'],
      ['Salmon Burger', 12.99, 'Seared salmon patty with lemon-dill sauce.'],
      ['Flame Burger', 16.99, 'Double patty, ghost-pepper cheese, fried jalapeños and flame sauce. Not for the faint of heart.', '/food/flame-burger.jpg'],
      ['Double Cheeseburger', 12.99, 'Two smashed patties with double American cheese.'],
    ].map((s) => {
      const seed = s as Seed
      return [seed[0], seed[1], (seed[2] ?? '') + MEAL_NOTE, seed[3], { modifierGroupIds: ['make-it-a-meal'] }] as Seed
    }),
  },
  {
    id: 'kids', name: 'Kids Meal', description: 'Little portions for little appetites.', links: 3,
    items: [
      ['Chicken Nuggets with Fries', 11.99, 'Crispy golden chicken nuggets served with fries and ketchup.', '/food/chicken-nuggets.jpg'],
      ['Cheese Pizza with Fries', 11.99, 'Personal cheese pizza with a side of fries.'],
    ],
  },
  {
    id: 'sides', name: 'Sides', description: '', links: 4,
    items: [
      ['Side of Falafel', 5.99, 'Three pieces of crispy falafel.'],
      ['Fries', 3.99, '', undefined, { sizes: [{ id: 'fries-basket', name: 'Basket', price: 6.99 }] }],
      ['Curly Fries', 4.99, '', undefined, { sizes: [{ id: 'curly-basket', name: 'Basket', price: 8.99 }] }],
      ['Onion Rings', 6.99, ''],
      ['Side of Hummus', 6.99, 'Creamy chickpea hummus with olive oil, served with pita bread.'],
    ],
  },
]

const POPULARITY: Record<string, number> = {
  'Chicken Platter': 412, 'Gyro Wrap': 388, 'Falafel Wrap': 341, 'Combo Kabab': 297, 'Flame Burger': 266,
  'Chicken Kabab': 244, 'Dolma': 231, 'Wings (8 pcs)': 219, 'Gyro Platter': 205, 'BBQ Lamb Chops': 188,
  'Fries': 176, 'Chicken Wrap': 171, 'Baba Ganoush': 154, 'Flame Platter': 149, 'Chicken Nuggets with Fries': 131,
}

export const MODIFIER_GROUPS: ModifierGroup[] = [
  { id: 'make-it-a-meal', name: 'Make it a Meal', min: 0, max: 1, required: false, options: [{ id: 'm1', name: 'Fries + Soda', price: 4.99 }] },
  { id: 'quesadilla-protein', name: 'Quesadilla Protein', min: 1, max: 1, required: true, options: [{ id: 'q1', name: 'Chicken', price: 0 }, { id: 'q2', name: 'Gyro', price: 0 }, { id: 'q3', name: 'Veggie', price: 0 }] },
  { id: 'wing-sauce', name: 'Wing Sauce', min: 1, max: 1, required: true, options: [{ id: 'w1', name: 'BBQ', price: 0 }, { id: 'w2', name: 'Teriyaki', price: 0 }, { id: 'w3', name: 'Buffalo', price: 0 }] },
  { id: 'combo-choice', name: 'Combo Kabab Choice', min: 1, max: 1, required: true, options: [{ id: 'c1', name: 'Chapli & Beef Tikka', price: 0 }, { id: 'c2', name: 'Chicken & Lamb', price: 0 }] },
  { id: 'entree-sauce', name: 'Entree Sauce', min: 1, max: 1, required: true, options: [{ id: 'e1', name: 'Hummus', price: 0 }, { id: 'e2', name: 'Special Sauce', price: 0 }] },
  { id: 'extras', name: 'Add Extras', min: 0, max: 5, required: false, options: [{ id: 'x1', name: 'Extra Garlic Sauce', price: 0.99 }, { id: 'x2', name: 'Extra Pita', price: 1.49 }, { id: 'x3', name: 'Add Feta', price: 1.99 }, { id: 'x4', name: 'Add Falafel (2 pc)', price: 2.99 }] },
]

export function buildSeed(): { categories: Category[]; items: Item[] } {
  const categories: Category[] = []
  const items: Item[] = []
  for (const c of SEED) {
    categories.push({ id: c.id, name: c.name, description: c.description, links: c.links, status: 'available' })
    c.items.forEach(([name, price, description = '', image, extra], i) => {
      const id = `${c.id}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')}`
      const sku = skuFor(id)
      items.push({
        id, categoryId: c.id, name, description, price, image,
        status: 'available', tax: '', sizes: [], sku, unit: c.id === 'sides' ? 'Order' : c.id === 'entrees' ? 'Plate' : 'Piece',
        stock: 40 + (hash(id) % 160) - (i === 0 ? 0 : 0), barcodes: [sku], trackInventory: true,
        modifierGroupIds: c.id === 'entrees' ? ['entree-sauce', 'extras'] : c.id === 'wraps' ? ['make-it-a-meal', 'extras'] : [],
        orders30d: POPULARITY[name] ?? 20 + (hash(name) % 110),
        ...extra,
      })
    })
  }
  return { categories, items }
}

export const fmt = (n: number) => '$' + n.toFixed(2)
