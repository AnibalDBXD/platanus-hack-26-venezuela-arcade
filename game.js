// ─────────────────────────────────────────────────────────────────────────────
// ¡A CUÁNTO EL DÓLAR! (Bodega Tycoon) — Platanus Hack 26: Caracas
// Arcade de agilidad matemática: atiende clientes en tu bodega, convierte a
// Bolívares según el método de pago y cobra en el punto de venta antes de que
// se agote la paciencia.
//
// Secciones internas (arquitectura modular en archivo único):
//   1. Constantes y configuración
//   2. Modelos de datos del juego (typedefs + catálogos)
//   3. Motor matemático (tasas, totales, generateOptions)
//   4. Perks y tienda entre días
//   5. Storage (bridge platanusArcadeStorage + fallback)
//   6. Audio procedural (chiptune vía Web Audio)
//   7. Pixel art procedural (sprites por mapas de píxeles)
//   8. Escena principal y game loop
// ─────────────────────────────────────────────────────────────────────────────

// ══ 1. CONSTANTES Y CONFIGURACIÓN ═══════════════════════════════════════════

const GAME_WIDTH = 800;
const GAME_HEIGHT = 600;
const STORAGE_KEY = 'bodega-tycoon-highscores';
const MAX_HIGH_SCORES = 5;
const MAX_HEARTS = 3;
const IGTF_RATE = 0.03;

// Paleta global "Neon Arcade" (skill retro-tech-illustration): fondos
// azul-negro/púrpura, acentos neón rosa/cian/púrpura/amarillo, texto off-white.
const COLORS = {
  bg: 0x0b0b0f, // deep blue-black
  wall: 0x1a0f2e, // dark purple
  shelf: 0x3a2452,
  cardboard: 0xc9a35f, // el cartón sigue siendo cartón (diegético)
  cardboardDark: 0xa5813f,
  cardboardInk: '#3a2a12',
  counter: 0x2e1a34,
  counterTop: 0x4a2a52,
  counterTrim: 0x00f5ff, // filo neón cian del mostrador
  panel: 0x0b0b0f,
  panelEdge: 0x7b2cff, // neón púrpura
  button: 0x1a0f2e,
  buttonOff: 0x16121e,
  buttonHot: 0xffe600, // amarillo neón
  white: '#e7e7ff', // off-white
  ink: '#1a1408',
  accent: '#ffe600',
  good: '#00ff88',
  bad: '#ff003c',
  dim: '#8a86a8',
  patience: 0x00f5ff,
};

// DO NOT replace existing keys — they match the physical arcade cabinet wiring.
// To add local testing shortcuts, append extra keys to any array.
const CABINET_KEYS = {
  P1_U: ['w'],
  P1_D: ['s'],
  P1_L: ['a'],
  P1_R: ['d'],
  P1_1: ['u'],
  P1_2: ['i'],
  P1_3: ['o'],
  P1_4: ['j'],
  P1_5: ['k'],
  P1_6: ['l'],
  P2_U: ['ArrowUp'],
  P2_D: ['ArrowDown'],
  P2_L: ['ArrowLeft'],
  P2_R: ['ArrowRight'],
  P2_1: ['r'],
  P2_2: ['t'],
  P2_3: ['y'],
  P2_4: ['f'],
  P2_5: ['g'],
  P2_6: ['h'],
  START1: ['Enter'],
  START2: ['2'],
};

const KEYBOARD_TO_ARCADE = {};
for (const [arcadeCode, keys] of Object.entries(CABINET_KEYS)) {
  for (const key of keys) {
    KEYBOARD_TO_ARCADE[normalizeIncomingKey(key)] = arcadeCode;
  }
}

function normalizeIncomingKey(key) {
  return key.length === 1 ? key.toLowerCase() : key;
}

// Estado de entrada: `held` para niveles, `justPressed` para flancos (un disparo).
const held = Object.create(null);
const justPressed = Object.create(null);

function onKeyDown(e) {
  const code = KEYBOARD_TO_ARCADE[normalizeIncomingKey(e.key)];
  if (code) {
    if (!held[code]) justPressed[code] = true;
    held[code] = true;
  }
}

function onKeyUp(e) {
  const code = KEYBOARD_TO_ARCADE[normalizeIncomingKey(e.key)];
  if (code) held[code] = false;
}

// La dev UI envía eventos sintéticos tanto a window como a document del iframe;
// escuchamos ambos (la guarda de `held` evita dobles disparos por burbujeo).
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
  }
}

// Consume un flanco de botón: true una sola vez por pulsación.
function consumePressed(code) {
  if (justPressed[code]) {
    justPressed[code] = false;
    return true;
  }
  return false;
}

// Descarta flancos no consumidos al final del frame: evita que teclas
// presionadas en otra fase (feedback, tienda) disparen acciones fantasma.
function clearStalePresses() {
  for (const code of Object.keys(justPressed)) justPressed[code] = false;
}

// ══ 2. MODELOS DE DATOS DEL JUEGO ═══════════════════════════════════════════

/**
 * @typedef {{ id: string, name: string, priceUSD: number }} Product
 * Producto de la bodega. `priceUSD` es el precio de lista en divisas.
 * El `id` coincide con la textura pixel art generada en la sección 7.
 */
const PRODUCTS = [
  { id: 'pan', name: 'Harina PAN', priceUSD: 1.25 },
  { id: 'arroz', name: 'Arroz 1kg', priceUSD: 1.1 },
  { id: 'pasta', name: 'Pasta 500g', priceUSD: 0.95 },
  { id: 'aceite', name: 'Aceite 1L', priceUSD: 3.5 },
  { id: 'cafe', name: 'Cafe 250g', priceUSD: 2.75 },
  { id: 'malta', name: 'Malta', priceUSD: 0.85 },
  { id: 'queso', name: 'Queso 1kg', priceUSD: 6.4 },
  { id: 'papel', name: 'Papel x4', priceUSD: 2.3 },
  { id: 'leche', name: 'Leche 1L', priceUSD: 1.6 },
  { id: 'azucar', name: 'Azucar 1kg', priceUSD: 1.2 },
  { id: 'atun', name: 'Atun 170g', priceUSD: 1.45 },
  { id: 'jabon', name: 'Jabon', priceUSD: 0.9 },
];

/**
 * @typedef {{ id: string, label: string, rateKey: 'dolar' | 'euro', igtf: boolean }} PaymentMethod
 * Método de pago exigido por el cliente. `rateKey` indexa en ExchangeRates.
 * `igtf` marca si pagar con esa divisa causa el impuesto del 3%.
 */
const PAYMENT_METHODS = [
  { id: 'pm', label: 'Pago Movil', rateKey: 'dolar', igtf: false },
  { id: 'cash', label: 'Efectivo $', rateKey: 'dolar', igtf: true },
  { id: 'eur', label: 'Euros', rateKey: 'euro', igtf: true },
];

/**
 * @typedef {{ dolar: number, euro: number }} ExchangeRates
 * Tasas del día en Bs. por cada $1 del ticket. El euro solo entra en juego
 * en niveles altos (level.euroEnabled).
 */

/**
 * @typedef {{ name: string, look: string, items: Product[], method: PaymentMethod,
 *   patienceMs: number }} Client
 * `look` es la clave de textura pixel art del sprite del cliente.
 */
const CLIENT_LOOKS = ['cli_chamo', 'cli_abuela', 'cli_maria', 'cli_jose', 'cli_motorizado'];
const CLIENT_NAMES = {
  cli_chamo: ['Chamo', 'Ender', 'Yonaiker'],
  cli_abuela: ['Abuela', 'Carmen', 'Petra'],
  cli_maria: ['Maria', 'Yuleidis', 'Ana'],
  cli_jose: ['Jose', 'Ramon', 'Luis'],
  cli_motorizado: ['Motorizado', 'Pedro', 'El Goyo'],
};

/**
 * @typedef {{ day: number, items: [number, number], patienceMs: number, dolarRange: [number, number],
 *   roundRates: boolean, obvious: boolean, igtfEnabled: boolean, euroEnabled: boolean,
 *   events: string[], clients: number }} GameLevelConfig
 * `roundRates`: tasas redondas para cálculo mental fácil (niveles bajos).
 * `obvious`: distractores con diferencias grandes (niveles bajos).
 */
const LEVELS = [
  { day: 1, items: [1, 2], patienceMs: 32000, dolarRange: [50, 100], roundRates: true, obvious: true, igtfEnabled: false, euroEnabled: false, events: [], clients: 4 },
  { day: 2, items: [1, 2], patienceMs: 29000, dolarRange: [80, 150], roundRates: true, obvious: true, igtfEnabled: false, euroEnabled: false, events: [], clients: 5 },
  { day: 3, items: [2, 3], patienceMs: 26000, dolarRange: [120, 200], roundRates: true, obvious: false, igtfEnabled: true, euroEnabled: false, events: [], clients: 5 },
  { day: 4, items: [2, 3], patienceMs: 24000, dolarRange: [180, 300], roundRates: false, obvious: false, igtfEnabled: true, euroEnabled: true, events: [], clients: 6 },
  { day: 5, items: [3, 4], patienceMs: 21000, dolarRange: [300, 500], roundRates: false, obvious: false, igtfEnabled: true, euroEnabled: true, events: ['happyHour'], clients: 6 },
  { day: 6, items: [3, 5], patienceMs: 18000, dolarRange: [500, 900], roundRates: false, obvious: false, igtfEnabled: true, euroEnabled: true, events: ['happyHour', 'blackout'], clients: 7 },
];

/** Devuelve la config del día; para días > 6 escala la dificultad proceduralmente. */
function getLevel(day) {
  if (day <= LEVELS.length) return LEVELS[day - 1];
  const base = LEVELS[LEVELS.length - 1];
  const extra = day - LEVELS.length;
  return {
    day,
    items: [base.items[0], Math.min(6, base.items[1] + (extra % 2))],
    patienceMs: Math.max(10000, base.patienceMs - extra * 800),
    dolarRange: [base.dolarRange[0] * (1 + extra * 0.5), base.dolarRange[1] * (1 + extra * 0.5)],
    roundRates: false,
    obvious: false,
    igtfEnabled: true,
    euroEnabled: true,
    events: ['happyHour', 'blackout'],
    clients: Math.min(12, base.clients + extra),
  };
}

/** @typedef {{ id: 'happyHour' | 'blackout', durationMs: number }} SpecialEvent */

// ══ 3. MOTOR MATEMÁTICO ═════════════════════════════════════════════════════

function round2(n) {
  return Math.round(n * 100) / 100;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/**
 * Genera las tasas del día. Con `roundRates` el dólar sale en múltiplos de 10
 * y el euro en múltiplos de 5: totales redondos y cálculo mental amable.
 */
function genRates(level) {
  let dolar = rand(level.dolarRange[0], level.dolarRange[1]);
  let euro = dolar * rand(1.08, 1.2);
  if (level.roundRates) {
    dolar = Math.round(dolar / 10) * 10;
    euro = Math.round(euro / 5) * 5;
  } else {
    dolar = round2(dolar);
    euro = round2(euro);
  }
  return { dolar: Math.max(10, dolar), euro: Math.max(10, euro) };
}

function igtfFactor(method, level) {
  return level.igtfEnabled && method.igtf ? 1 + IGTF_RATE : 1;
}

/** Suma del ticket en divisas. */
function computeTotalUSD(items) {
  return round2(items.reduce((sum, p) => sum + p.priceUSD, 0));
}

/** Monto final en Bolívares: total USD × tasa del método × IGTF si aplica. */
function computeTotalBs(totalUSD, rateKey, rates, method, level) {
  return round2(totalUSD * rates[rateKey] * igtfFactor(method, level));
}

/** Arma el pedido de un cliente según el nivel. El euro solo aparece si el nivel lo permite. */
function genClient(level) {
  const count = randInt(level.items[0], level.items[1]);
  const items = [];
  const pool = PRODUCTS.slice();
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    items.push(pool.splice(idx, 1)[0]);
  }
  const methods = PAYMENT_METHODS.filter((m) => m.rateKey !== 'euro' || level.euroEnabled);
  const look = pick(CLIENT_LOOKS);
  return {
    name: pick(CLIENT_NAMES[look]),
    look,
    items,
    method: pick(methods),
    patienceMs: level.patienceMs,
  };
}

/** Inversión de dígitos decimales: 1234.56 → 1234.65. Null si no aplica. */
function swapDecimals(v) {
  const cents = Math.round(v * 100) % 100;
  const tens = Math.floor(cents / 10);
  const units = cents % 10;
  if (tens === units) return null;
  return Math.floor(v) + (units * 10 + tens) / 100;
}

/**
 * Genera las 4 opciones del punto de venta (en Bs.), barajadas:
 *  1. Correcta exacta.
 *  2. Trampa de tasa cruzada (dólar ↔ euro; solo cuando el euro está en juego).
 *  3. Trampa de redondeo/dígitos (desfase o decimales invertidos).
 *  4. Trampa de impuesto/descuido (IGTF falso, IGTF omitido o producto de menos).
 * En niveles `obvious` los desfases son grandes (±20–80 Bs) y no hay trampa de
 * decimales; en niveles altos son sutiles (±2.50–15 Bs).
 * Retorna { options: number[4], correctIndex } con valores únicos.
 */
function generateOptions(totalUSD, method, rates, level, items) {
  const correct = computeTotalBs(totalUSD, method.rateKey, rates, method, level);
  const values = [correct];
  const used = new Set([correct]);
  const minGap = level.obvious ? 12 : 0.5;
  const offsetSize = level.obvious ? [20, 80] : [2.5, 15];

  const push = (v) => {
    const r = round2(v);
    if (r > 0 && !used.has(r) && Math.abs(r - correct) >= minGap) {
      used.add(r);
      values.push(r);
      return true;
    }
    return false;
  };

  // 2. Tasa cruzada (solo si el euro está habilitado en este nivel).
  if (level.euroEnabled) {
    const otherKey = method.rateKey === 'dolar' ? 'euro' : 'dolar';
    push(totalUSD * rates[otherKey] * igtfFactor(method, level));
  } else {
    push(correct + (Math.random() < 0.5 ? -1 : 1) * rand(offsetSize[0], offsetSize[1]));
  }

  // 3. Redondeo/dígitos.
  const swapped = level.obvious ? null : swapDecimals(correct);
  if (!swapped || !push(swapped)) {
    push(correct + (Math.random() < 0.5 ? -1 : 1) * rand(offsetSize[0], offsetSize[1]));
  }

  // 4. Impuesto/descuido.
  const withIgtf = level.igtfEnabled && method.igtf;
  const igtfTrap = withIgtf
    ? totalUSD * rates[method.rateKey] // olvidó cobrar el IGTF
    : totalUSD * rates[method.rateKey] * (1 + IGTF_RATE); // cobró IGTF que no iba
  if (!push(igtfTrap) && items.length > 1) {
    const cheapest = items.reduce((a, b) => (a.priceUSD < b.priceUSD ? a : b));
    push((totalUSD - cheapest.priceUSD) * rates[method.rateKey] * igtfFactor(method, level));
  }

  // Relleno de seguridad ante colisiones improbables.
  while (values.length < 4) {
    push(correct + (Math.random() < 0.5 ? -1 : 1) * rand(offsetSize[0], offsetSize[1] * 1.5));
  }

  const final = shuffle(values.slice(0, 4));
  return { options: final, correctIndex: final.indexOf(correct) };
}

/** Formatea un monto como "1.234,56" (estilo venezolano). */
function fmtBs(n) {
  const fixed = n.toFixed(2);
  const parts = fixed.split('.');
  let int = parts[0];
  let out = '';
  while (int.length > 3) {
    out = '.' + int.slice(-3) + out;
    int = int.slice(0, -3);
  }
  return int + out + ',' + parts[1];
}

// ══ 4. PERKS Y TIENDA ENTRE DÍAS ════════════════════════════════════════════

/**
 * @typedef {{ hints: number, calcLevel: number }} PerkState
 * hints: cargas de pista (P1_2 elimina 2 opciones falsas).
 * calcLevel: 0 = sin calculadora; 1..4 = 20%/30%/40%/50% de probabilidad
 * de revelar el monto correcto al llegar un cliente.
 */
const CALC_PROBS = [0, 0.2, 0.3, 0.4, 0.5]; // índice = calcLevel, tope 50%
const MAX_CALC_LEVEL = 4;

const SHOP_PRICES = {
  hints: 20, // 3 pistas
  calcBuy: 60, // comprar calculadora (nivel 1)
  calcUp: 40, // cada mejora +10%
  heart: 80, // +1 corazón (hasta MAX_HEARTS)
};

function calcPrice(perks) {
  return perks.calcLevel === 0 ? SHOP_PRICES.calcBuy : SHOP_PRICES.calcUp;
}

/**
 * Lista de ítems de la tienda según el estado actual.
 * @returns {Array<{ id: string, label: string, price: number, disabled: boolean }>}
 */
function getShopItems(perks, hearts) {
  const items = [
    { id: 'hints', label: '3 Pistas (P1_2 quita 2 falsas)', price: SHOP_PRICES.hints, disabled: false },
    {
      id: 'calc',
      label: perks.calcLevel === 0
        ? 'Calculadora (revela 20%)'
        : 'Mejorar Calculadora a ' + Math.round(CALC_PROBS[perks.calcLevel + 1] * 100) + '%',
      price: calcPrice(perks),
      disabled: perks.calcLevel >= MAX_CALC_LEVEL,
    },
    { id: 'heart', label: '+1 Corazon', price: SHOP_PRICES.heart, disabled: hearts >= MAX_HEARTS },
  ];
  if (perks.calcLevel >= MAX_CALC_LEVEL) items[1].label = 'Calculadora (MAX 50%)';
  return items;
}

/** Intenta comprar un ítem; true si se aplicó. */
function buyShopItem(state, item) {
  if (item.disabled || state.coins < item.price) return false;
  state.coins -= item.price;
  if (item.id === 'hints') state.perks.hints += 3;
  if (item.id === 'calc') state.perks.calcLevel += 1;
  if (item.id === 'heart') state.hearts = Math.min(MAX_HEARTS, state.hearts + 1);
  return true;
}

// ══ 5. STORAGE (bridge arcade + fallback localStorage) ══════════════════════

function getStorage() {
  if (typeof window !== 'undefined' && window.platanusArcadeStorage) {
    return window.platanusArcadeStorage;
  }
  return {
    async get(key) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw === null
          ? { found: false, value: null }
          : { found: true, value: JSON.parse(raw) };
      } catch {
        return { found: false, value: null };
      }
    },
    async set(key, value) {
      window.localStorage.setItem(key, JSON.stringify(value));
    },
  };
}

async function loadData(key) {
  return getStorage().get(key);
}

async function saveData(key, value) {
  return getStorage().set(key, value);
}

// ══ 6. AUDIO PROCEDURAL (chiptune via Web Audio de Phaser) ══════════════════

/** Toca un tono estilo chiptune en `t0` (segundos del AudioContext). */
function toneAt(scene, freq, t0, dur, vol, type) {
  if (!scene.sound || !scene.sound.context) return;
  const ctx = scene.sound.context;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || 'square';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur);
}

/** Jingle de victoria al completar el día (arpegio chiptune). */
function playDayJingle(scene) {
  if (!scene.sound || !scene.sound.context) return;
  const t0 = scene.sound.context.currentTime + 0.05;
  const notes = [523, 659, 784, 1047, 784, 1047, 1319]; // C5 E5 G5 C6 G5 C6 E6
  notes.forEach((f, i) => toneAt(scene, f, t0 + i * 0.11, 0.16, 0.05));
}

/** Blip de caja registradora al comprar en la tienda. */
function playBuySound(scene) {
  if (!scene.sound || !scene.sound.context) return;
  const t0 = scene.sound.context.currentTime + 0.02;
  toneAt(scene, 1200, t0, 0.07, 0.06);
  toneAt(scene, 1600, t0 + 0.08, 0.1, 0.06);
}

/** Ding del punto de venta al cobrar bien. */
function playGoodSound(scene) {
  if (!scene.sound || !scene.sound.context) return;
  const t0 = scene.sound.context.currentTime + 0.02;
  toneAt(scene, 880, t0, 0.09, 0.06);
  toneAt(scene, 1319, t0 + 0.09, 0.16, 0.06);
}

/** Buzz grave de error / cliente perdido. */
function playBadSound(scene) {
  if (!scene.sound || !scene.sound.context) return;
  const t0 = scene.sound.context.currentTime + 0.02;
  toneAt(scene, 160, t0, 0.28, 0.07, 'sawtooth');
  toneAt(scene, 110, t0 + 0.05, 0.28, 0.05, 'sawtooth');
}

// ══ 7. PIXEL ART PROCEDURAL ═════════════════════════════════════════════════
// Cada sprite es un mapa de caracteres: cada letra es un píxel de la paleta
// (`pal`) y '.' es transparente. Se rasterizan con Graphics → generateTexture.
// Referencias venezolanas: Harina PAN, malta, queso llanero, motorizado con
// casco, abuela con rodete, señora con rolos, chamo con gorra tricolor...

// Dirección de arte (skill pixel-art-sprites):
// - Outline selectivo de 1px, color compartido K (near-black cálido), en TODOS
//   los sprites y props (consistencia de peso y color).
// - Fuente de luz única: arriba-izquierda. H = highlight (hue cálido),
//   M = midtone, S = sombra (hue frío/oscuro, abajo-derecha). Nada de pillow shading.
// - Bordes duros 1-bit, sin anti-aliasing. Silueta primero, detalle después.
// - Escalas enteras en pantalla: productos x4, clientes x3, corazón x3, moneda x2.
const OUTLINE = 0x160a24;

const PIXEL_SPRITES = {
  // ── Productos (canvas 16x16 salvo indicado) ──
  pan: { // Harina PAN: paquete amarillo, óvalo blanco con banda roja
    pal: { K: OUTLINE, H: 0xffe96a, M: 0xf7d117, S: 0xcf9b10, W: 0xffffff, R: 0xcf142b },
    px: [
      '....KKKKKKKK....',
      '...KHHHHHHHHK...',
      '..KHHMMMMMMMMK..',
      '..KHMMMMMMMMMK..',
      '..KMMWWWWWWMMK..',
      '..KMWWWWWWWWMK..',
      '..KMWRRRRRWMK...',
      '..KMWRRRRRWMK...',
      '..KMWWWWWWWMMK..',
      '..KMMWWWWWWMMK..',
      '..KMMMMMMMMMMK..',
      '..KMMMMMMMMSSK..',
      '..KMMMMMMMSSSK..',
      '..KMMMMMMSSSMK..',
      '...KMMMMSSSMK...',
      '....KKKKKKKK....',
    ],
  },
  arroz: { // saco blanco crema con banda verde
    pal: { K: OUTLINE, H: 0xffffff, M: 0xf0ead8, S: 0xc4b898, G: 0x2e8b57, g: 0x1f6a42 },
    px: [
      '....KKKKKKKK....',
      '...KHHHHHHHHK...',
      '..KHHMMMMMMMMK..',
      '..KHMMMMMMMMMK..',
      '..KMMMMMMMMMMK..',
      '..KGGGGGGGGGGK..',
      '..KGgGGGGgGGGK..',
      '..KGGGGGGGGGGK..',
      '..KMMMMMMMMMMK..',
      '..KMMMMMMMMMMK..',
      '..KMMMMMMMMSSK..',
      '..KMMMMMMMSSSK..',
      '..KMMMMMMSSSMK..',
      '..KMMMMMSSSMK...',
      '...KMMMMSSMK....',
      '....KKKKKKKK....',
    ],
  },
  pasta: { // paquete largo rojo/azul con ventana (16x10)
    pal: { K: OUTLINE, H: 0xe85a4a, R: 0xd0342c, r: 0xa82420, B: 0x7b2cff, b: 0x5520b0, W: 0xfff3d8 },
    px: [
      '.KKKKKKKKKKKKKK.',
      'KHHHHHHHHHHHHrrK',
      'KHRRRRRRRRRRRrrK',
      'KHRRWWWWWWRRRrrK',
      'KHRRWWWWWWRRRrrK',
      'KHRRRRRRRRRRRrrK',
      'KHBBBBBBBBBBBbbK',
      'KHBBWWWWWWBBBbbK',
      'KHBBBBBBBBBBBbbK',
      '.KKKKKKKKKKKKKK.',
    ],
  },
  aceite: { // botella de aceite con tapa verde (8x16)
    pal: { K: OUTLINE, C: 0x2e8b57, H: 0xffe96a, M: 0xf7c117, S: 0xc78c10, W: 0xfff6d8 },
    px: [
      '...KK...',
      '...KCK..',
      '...KCK..',
      '..KHHK..',
      '.KHHHHK.',
      '.KHMMMK.',
      'KHMMMMMK',
      'KHWWWWMK',
      'KHWWWWMK',
      'KHMMMMMK',
      'KHMMMMMK',
      'KHMSSSMK',
      'KHMSSSMK',
      'KHMMSSMK',
      '.KMMMMK.',
      '.KKKKKK.',
    ],
  },
  cafe: { // bolsa de café marrón con banda oscura (12x14)
    pal: { K: OUTLINE, H: 0x8a5a36, M: 0x6b4226, S: 0x452812, D: 0x2a1a0c, W: 0xf5e6c8 },
    px: [
      '..KKKKKKKK..',
      '.KHHHHHHHHK.',
      '.KHHMMMMMMMK'.slice(0, 12),
      '.KMMMMMMMMMK',
      '.KDDDDDDDDDK',
      '.KDDWWWWDDDK',
      '.KDDWWWWDDDK',
      '.KDDDDDDDDDK',
      '.KMMMMMMMMMK',
      '.KMMMMMMMMMK',
      '.KMMMMMMSSMK',
      '.KMMMMMSSSMK',
      '.KMMMMSSSMK.',
      '.KKKKKKKKKK.',
    ],
  },
  malta: { // botella de malta, etiqueta roja (8x16)
    pal: { K: OUTLINE, C: 0xf0e0c8, N: 0x3a2410, H: 0x7a5228, M: 0x4a2c12, S: 0x2e1a08, R: 0xcf142b, W: 0xffffff },
    px: [
      '...KK...',
      '...KCK..',
      '...KCK..',
      '..KNNK..',
      '..KHHK..',
      '.KHHHHK.',
      'KHHMMMMK',
      'KHMMMMMK',
      'KRRRRRRK',
      'KRWRRWMK',
      'KRRRRRRK',
      'KHMMMMMK',
      'KHMMMMMK',
      'KHMSSSMK',
      '.KMMMMK.',
      '.KKKKKK.',
    ],
  },
  queso: { // rueda de queso llanero (14x10)
    pal: { K: OUTLINE, H: 0xfff8dc, M: 0xffe9a8, S: 0xd8b878, O: 0xd4a860 },
    px: [
      '...KKKKKKKK...',
      '..KHHHHHHHHHK.',
      '.KHHMMMMMMMMMK',
      '.KHMMOMMMMMMMK',
      '.KMMMMMMOOMMMK',
      '.KMMMMMMMMMMMK',
      '.KMMMMOMMMMSSK',
      '.KMMMMMMMMSSSK',
      '.KSSSSSSSSSSSK',
      '..KKKKKKKKKKK.',
    ],
  },
  papel: { // pack de papel: 2x2 rollos con núcleo (15x14)
    pal: { K: OUTLINE, H: 0xffffff, M: 0xeeeeff, S: 0xbcbccf, C: 0xb89a6a },
    px: [
      '.KKKKKK..KKKKKK',
      'KHHHHHHKKHHHHHK',
      'KHHMMMMKKHMMMMK',
      'KHMCCMMKKMCCMMK',
      'KHHMMMMKKHMMMMK',
      'KHHHHHHKKHSSSSK',
      '.KKKKKK..KKKKKK',
      'KHHHHHHKKHHHHHK',
      'KHHMMMMKKHMMMMK',
      'KHMCCMMKKMCCMMK',
      'KHHMMMMKKHMMMMK',
      'KHHHHHHKKHSSSSK',
      '.KKKKKK..KKKKKK',
    ],
  },
  leche: { // cartón de leche con tapa y banda azul (12x15)
    pal: { K: OUTLINE, T: 0x00f5ff, H: 0xffffff, M: 0xf0f4f8, S: 0xb0b8d0, B: 0x7b2cff },
    px: [
      '...KKKKKK...',
      '...KTTTTK...',
      '..KTTTTTTK..',
      '.KKHHHHHHKK.',
      '.KHHHHHHHHK.',
      '.KHMMMMMMMMK',
      '.KMMMMMMMMMK',
      '.KMBBBBBBBMK',
      '.KMBBBBBBBMK',
      '.KMMMMMMMMMK',
      '.KMMMMMMSSMK',
      '.KMMMMMSSSMK',
      '.KMMMMSSSMK.',
      '.KKKKKKKKKK.',
    ],
  },
  azucar: { // saco crema con banda marrón (12x14)
    pal: { K: OUTLINE, H: 0xfffbf0, M: 0xf4e9d2, S: 0xcbb894, B: 0x8b5a2b, b: 0x6e4420 },
    px: [
      '..KKKKKKKK..',
      '.KHHHHHHHHK.',
      '.KHMMMMMMMMK',
      '.KMMMMMMMMMK',
      '.KBBBBBBBBBK',
      '.KBbbBBbBBBK',
      '.KBBBBBBBBBK',
      '.KMMMMMMMMMK',
      '.KMMMMMMMMMK',
      '.KMMMMMMSSMK',
      '.KMMMMMSSSMK',
      '.KMMMMSSSMK.',
      '.KKKKKKKKKK.',
    ],
  },
  atun: { // lata de atún plateada, etiqueta azul (14x10)
    pal: { K: OUTLINE, H: 0xf0f0ff, M: 0xb8b8d0, S: 0x7a7a9a, B: 0x7b2cff, W: 0xffffff },
    px: [
      '.KKKKKKKKKKKK.',
      'KHHHHHHHHHHSSK',
      'KHMMMMMMMMMMMK',
      'KMBBBBBBBBBBMK',
      'KMBWWWWWWWWBMK',
      'KMBBBBBBBBBBMK',
      'KHMMMMMMMMMMMK',
      'KMMMMMMMMMMSSK',
      'KSSSSSSSSSSSSK',
      '.KKKKKKKKKKKK.',
    ],
  },
  jabon: { // jabón rosa con espuma y burbujas (14x12)
    pal: { K: OUTLINE, B: 0x00f5ff, H: 0xff9ac8, M: 0xff2aa3, S: 0xb01870, W: 0xffffff },
    px: [
      '.KB.........',
      'KBKB....KB..',
      '.KB...KKKKKK',
      '....KHHHHHHK',
      '...KHHMMMMMMK'.slice(0, 14),
      '...KHMWWMMMMK'.slice(0, 14),
      '...KHMWWMMMMK'.slice(0, 14),
      '...KHMMMMMMMK',
      '...KMMMMMSSMK',
      '...KMMMMSSSMK',
      '....KKKKKKKK.',
    ],
  },

  // ── HUD ──
  heart: { // 10x8 con outline y brillo
    pal: { K: OUTLINE, H: 0xff8ac8, R: 0xff2aa3, S: 0xb01870 },
    px: [
      '.KKK...KKK.',
      'KHHHKKKRRRK',
      'KHHRRRRRRRK',
      'KHRRRRRRRRK',
      'KRRRRRRRSSK',
      '.KRRRRRSSK.',
      '..KRRRSSK..',
      '...KKKKK...',
    ],
  },
  coin: { // 8x8 con outline y brillo
    pal: { K: OUTLINE, H: 0xffe96a, M: 0xffd24a, S: 0xd4a017 },
    px: [
      '..KKKK..',
      '.KHHHHK.',
      'KHHMMMMK',
      'KHMMMMMK',
      'KHMMMMMK',
      'KHMSSSMK',
      '.KMSSSK.',
      '..KKKK..',
    ],
  },

  // ── Clientes (16x20, chibi: cabeza 40%, outline K, luz TL) ──
  cli_chamo: { // gorra tricolor, franela verde
    pal: { K: OUTLINE, Y: 0xf7d117, B: 0x00247d, R: 0xcf142b, S: 0xc68e5e, s: 0x9e6a40, M: 0x7a3a2a, T: 0x00d2a8, D: 0x009a78, P: 0x2b3a5f, F: 0x1a1424 },
    px: [
      '.....KKKKKK.....',
      '....KYYYYYYK....',
      '...KYYYYYYYYK...',
      '...KBBBBBBBBK...',
      '..KKRRRRRRRRKK..',
      '..KSSSSSSSSssK..',
      '..KSKSSSKSSssK..',
      '..KSSSSSSSSSsK..',
      '...KSSSMMSSsK...',
      '....KSSSSSsK....',
      '....KTTTTTTK....',
      '...KTTTTTTTTK...',
      '..KTTTTTTTTDTK..',
      '..KSTTTTTTTDsK..',
      '..KSTTTTTTTDsK..',
      '..KKTTTTTTTDKK..',
      '....KPPPPPPK....',
      '....KPPKKPPK....',
      '....KPPKKPPK....',
      '...KFFK..KFFK...',
    ],
  },
  cli_abuela: { // rodete gris, vestido morado
    pal: { K: OUTLINE, H: 0xe8e8e8, h: 0xbababa, S: 0xd9a066, s: 0xb87f4a, M: 0x8b3a3a, T: 0x8a5a9e, D: 0x6a4078, F: 0x1a1424 },
    px: [
      '......KKKK......',
      '.....KHHHHK.....',
      '....KHHHHHHK....',
      '...KHhhhhhhHK...',
      '..KHhSSSSSShHK..',
      '..KSKSSSKSSssK..',
      '..KSSSSSSSSSsK..',
      '...KSSSMMSSsK...',
      '....KSSSSSsK....',
      '....KTTTTTTK....',
      '...KTTTTTTTTK...',
      '..KTTTTTTTTDTK..',
      '..KSTTTTTTTDsK..',
      '..KKTTTTTTTDKK..',
      '...KTTTTTTTTK...',
      '...KTTTTTTTTK...',
      '....KTTTTTTK....',
      '....KSSKKSSK....',
      '....KSSKKSSK....',
      '...KFFK..KFFK...',
    ],
  },
  cli_maria: { // rolos rosados, franela naranja
    pal: { K: OUTLINE, R: 0xf070a0, H: 0x3a2410, S: 0x8d5524, s: 0x6e3f1a, M: 0xd05a5a, T: 0xff7a00, D: 0xc85e00, P: 0x5a3a6e, F: 0x1a1424 },
    px: [
      '....KKKKKKKK....',
      '...KRRRRRRRRK...',
      '...RKRKRKRKRK...',
      '..KHHSSSSSSHHK..',
      '..KSSSSSSSSssK..',
      '..KSKSSSKSSssK..',
      '..KSSSSSSSSSsK..',
      '...KSSSMMSSsK...',
      '....KSSSSSsK....',
      '....KTTTTTTK....',
      '...KTTTTTTTTK...',
      '..KTTTTTTTTDTK..',
      '..KSTTTTTTTDsK..',
      '..KSTTTTTTTDsK..',
      '..KKTTTTTTTDKK..',
      '....KPPPPPPK....',
      '....KPPKKPPK....',
      '....KPPKKPPK....',
      '....KPPKKPPK....',
      '...KFFK..KFFK...',
    ],
  },
  cli_jose: { // barba negra, franela azul
    pal: { K: OUTLINE, H: 0x1a1a1a, S: 0xa06a3a, s: 0x7f5028, B: 0x2a1a10, M: 0xe8c8a8, T: 0x00a8d8, D: 0x00789e, P: 0x3a3450, F: 0x1a1424 },
    px: [
      '....KKKKKKKK....',
      '...KHHHHHHHHK...',
      '..KHHHHHHHHHHK..',
      '..KHSSSSSSSSHK..',
      '..KSKSSSKSSssK..',
      '..KSSSSSSSSSsK..',
      '..KSBBBBBBBBSK..',
      '...KBBBMMBBBK...',
      '....KBBBBBBK....',
      '....KTTTTTTK....',
      '...KTTTTTTTTK...',
      '..KTTTTTTTTDTK..',
      '..KSTTTTTTTDsK..',
      '..KSTTTTTTTDsK..',
      '..KKTTTTTTTDKK..',
      '....KPPPPPPK....',
      '....KPPKKPPK....',
      '....KPPKKPPK....',
      '....KPPKKPPK....',
      '...KFFK..KFFK...',
    ],
  },
  cli_motorizado: { // casco rojo con visor, chaqueta gris
    pal: { K: OUTLINE, H: 0xe8304a, R: 0xcf142b, r: 0x9e0e20, V: 0x2a3542, S: 0xc68e5e, s: 0x9e6a40, M: 0x7a3a2a, T: 0x9a7ae8, D: 0x6a4ab0, P: 0x2a2038, F: 0x160a24 },
    px: [
      '....KKKKKKKK....',
      '...KHHHHHHHHK...',
      '..KHHHHHHHHHHK..',
      '..KHRRRRRRRRHK..',
      '..KVVVVVVVVVVK..',
      '..KVVVVVVVVVVK..',
      '..KKSSSSSSSSKK..',
      '...KSSSMMSSsK...',
      '....KSSSSSsK....',
      '....KTTTTTTK....',
      '...KTTTTTTTTK...',
      '..KTTTTTTTTDTK..',
      '..KSTTTTTTTDsK..',
      '..KSTTTTTTTDsK..',
      '..KKTTTTTTTDKK..',
      '....KPPPPPPK....',
      '....KPPKKPPK....',
      '....KPPKKPPK....',
      '....KPPKKPPK....',
      '...KFFK..KFFK...',
    ],
  },

  // ── Textura CRT: línea de escaneo 1x2 (tileado a pantalla completa) ──
  scan: {
    pal: { K: 0x000000 },
    px: ['.', 'K'],
  },
};

/** Rasteriza todos los mapas de píxeles a texturas de Phaser. */
function makePixelSprites(scene) {
  for (const [key, def] of Object.entries(PIXEL_SPRITES)) {
    const g = scene.add.graphics();
    const rows = def.px;
    const w = Math.max(...rows.map((r) => r.length));
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length; x++) {
        const c = def.pal[row[x]];
        if (c === undefined) continue;
        g.fillStyle(c, 1);
        g.fillRect(x, y, 1, 1);
      }
    }
    g.generateTexture(key, w, rows.length);
    g.destroy();
  }
}

// ══ 8. ESCENA PRINCIPAL Y GAME LOOP ═════════════════════════════════════════

function makeText(scene, x, y, size, color) {
  return scene.add.text(x, y, '', { fontFamily: 'monospace', fontSize: size + 'px', color });
}

function boot() {
  const config = {
    type: Phaser.AUTO,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    parent: 'game-root',
    backgroundColor: '#0b0b0f',
    pixelArt: true, // escalado NEAREST: píxeles duros
    render: { antialias: false, roundPixels: true },
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH, autoRound: true },
    scene: { create, update },
  };
  new Phaser.Game(config);
}

function create() {
  const scene = this;
  scene.state = {
    phase: 'start', // start | play | feedback | shop | gameover
    day: 1,
    hearts: MAX_HEARTS,
    coins: 0,
    streak: 0,
    score: 0,
    served: 0,
    level: getLevel(1),
    rates: null,
    client: null,
    totalUSD: 0,
    options: [],
    correctIndex: -1,
    eliminated: [false, false, false, false], // opciones tachadas por una pista
    calcRevealed: false, // la calculadora marcó la correcta este cliente
    perks: { hints: 0, calcLevel: 0 },
    sel: 0,
    shopSel: 0,
    patienceLeft: 0,
    dayCoins: 0, // monedas ganadas en el día (para el resumen del cierre)
    feedbackUntil: 0,
    feedbackOk: false,
    feedbackMsg: '',
  };

  makePixelSprites(scene);

  // ── Zona superior: pared, estantes, cartel de cartón, poster, bandera ──
  scene.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, COLORS.bg);
  scene.add.rectangle(GAME_WIDTH / 2, 130, GAME_WIDTH, 260, COLORS.wall);
  // estantes de la bodega (entre el cartel y el cliente)
  for (const y of [100, 160]) {
    scene.add.rectangle(415, y, 240, 6, COLORS.shelf);
  }
  // cartel de cartón con las tasas (izquierda)
  scene.add.rectangle(160, 130, 270, 150, COLORS.cardboard)
    .setStrokeStyle(4, COLORS.cardboardDark);
  scene.add.rectangle(160, 62, 14, 14, 0x8a8a8a); // tachuela
  // poster icónico de bodega
  scene.add.rectangle(712, 40, 130, 44, 0xf5f0e0).setStrokeStyle(3, 0xcf142b);
  scene.add.text(712, 40, 'NO FIAMOS', {
    fontFamily: 'monospace', fontSize: '17px', color: '#cf142b',
  }).setOrigin(0.5);
  // penón tricolor (bajo el poster)
  scene.add.rectangle(712, 225, 96, 8, 0xf7d117);
  scene.add.rectangle(712, 233, 96, 8, 0x00247d);
  scene.add.rectangle(712, 241, 96, 8, 0xcf142b);

  // ── Zona central: mostrador con filo neón cian (arcade) ──
  scene.add.rectangle(GAME_WIDTH / 2, 275, GAME_WIDTH, 30, COLORS.counterTop);
  scene.add.rectangle(GAME_WIDTH / 2, 262, GAME_WIDTH, 4, COLORS.counterTrim);
  scene.add.rectangle(GAME_WIDTH / 2, 355, GAME_WIDTH, 130, COLORS.counter);

  // ── Zona inferior: caja registradora + panel del punto de venta ──
  scene.add.rectangle(GAME_WIDTH / 2, 510, GAME_WIDTH, 180, COLORS.panel)
    .setStrokeStyle(4, COLORS.panelEdge);
  buildRegister(scene);

  // HUD: corazones + monedas + marcador
  scene.ui = {
    hearts: [],
    coinIcon: scene.add.image(116, 16, 'coin').setScale(2),
    coinText: makeText(scene, 132, 8, 16, COLORS.accent),
    hud: makeText(scene, 300, 12, 15, COLORS.white),
    perkHud: makeText(scene, 30, 220, 12, COLORS.accent),
    ratesTitle: makeText(scene, 45, 78, 13, COLORS.cardboardInk),
    rates: makeText(scene, 45, 98, 14, COLORS.cardboardInk),
    patienceBg: scene.add.rectangle(672, 152, 230, 12, 0x241a34),
    patienceBar: scene.add.rectangle(557, 152, 230, 12, COLORS.patience).setOrigin(0, 0.5),
    ticket: scene.add.rectangle(560, 355, 130, 110, 0xf8f4e8).setStrokeStyle(2, 0x999080),
    ticketText: makeText(scene, 500, 310, 10, '#333333'),
    ticketTotal: makeText(scene, 505, 392, 12, '#111111'),
    bubble: scene.add.rectangle(672, 92, 230, 64, 0xffffff).setStrokeStyle(3, 0x222222),
    bubbleTail: scene.add.triangle(552, 100, 0, 0, 0, 22, 20, 12, 0xffffff),
    bubbleText: makeText(scene, 565, 68, 12, '#1a1408'),
    feedback: makeText(scene, 400, 330, 20, COLORS.good).setOrigin(0.5),
    buttons: [],
  };
  for (let i = 0; i < MAX_HEARTS; i++) {
    scene.ui.hearts.push(scene.add.image(20 + i * 26, 16, 'heart').setScale(3));
  }
  scene.ui.patienceBg.setOrigin(0.5);

  for (let i = 0; i < 4; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 500 + col * 230;
    const y = 470 + row * 80;
    const rect = scene.add.rectangle(x, y, 210, 64, COLORS.button)
      .setStrokeStyle(3, COLORS.panelEdge)
      .setInteractive({ useHandCursor: true });
    const label = makeText(scene, x, y, 13, COLORS.white).setOrigin(0.5);
    rect.on('pointerdown', () => selectOption(scene, i));
    scene.ui.buttons.push({ rect, label });
  }

  scene.ui.center = makeText(scene, GAME_WIDTH / 2, GAME_HEIGHT / 2, 18, COLORS.white)
    .setOrigin(0.5).setAlign('center')
    .setInteractive({ useHandCursor: true });
  scene.ui.center.on('pointerdown', () => {
    const s = scene.state;
    if (s.phase === 'start' || s.phase === 'gameover') {
      scene.ui.center.setVisible(false);
      startGame(scene);
    }
  });

  // Tienda entre días: celebración + filas clickables + botón grande CONTINUAR.
  scene.ui.shop = {
    bg: scene.add.rectangle(400, 310, 780, 540, 0x000000, 0.88)
      .setStrokeStyle(4, COLORS.panelEdge),
    title: makeText(scene, 400, 90, 26, COLORS.accent).setOrigin(0.5),
    congrats: makeText(scene, 400, 128, 15, COLORS.good).setOrigin(0.5),
    stats: makeText(scene, 400, 160, 15, COLORS.white).setOrigin(0.5),
    rows: [],
    help: makeText(scene, 400, 415, 13, COLORS.dim).setOrigin(0.5).setAlign('center'),
    nextRect: scene.add.rectangle(400, 490, 320, 60, COLORS.button)
      .setStrokeStyle(4, COLORS.buttonHot)
      .setInteractive({ useHandCursor: true }),
    next: makeText(scene, 400, 490, 19, COLORS.accent).setOrigin(0.5),
  };
  for (let i = 0; i < 3; i++) {
    const row = makeText(scene, 400, 235 + i * 55, 16, COLORS.white)
      .setOrigin(0.5).setInteractive({ useHandCursor: true });
    row.on('pointerdown', () => {
      const s = scene.state;
      if (s.phase !== 'shop') return;
      s.shopSel = i;
      if (buyShopItem(s, getShopItems(s.perks, s.hearts)[i])) playBuySound(scene);
      renderShop(scene);
    });
    scene.ui.shop.rows.push(row);
  }
  scene.ui.shop.nextRect.on('pointerdown', () => {
    if (scene.state.phase === 'shop') advanceDay(scene);
  });
  scene.ui.shop.next.setInteractive({ useHandCursor: true });
  scene.ui.shop.next.on('pointerdown', () => {
    if (scene.state.phase === 'shop') advanceDay(scene);
  });
  setShopVisible(scene, false);

  // Sprites dinámicos del cliente y sus productos.
  scene.clientSprite = null;
  scene.productSprites = [];

  // Overlay CRT: scanlines sutiles sobre toda la pantalla (retro-tech).
  scene.add.tileSprite(400, 300, GAME_WIDTH, GAME_HEIGHT, 'scan')
    .setAlpha(0.09)
    .setDepth(1000);

  // Hook de depuración solo en desarrollo local (tests automatizados).
  if (typeof location !== 'undefined' && location.hostname === 'localhost') {
    window.__BODEGA_DEBUG = scene.state;
  }

  showStartScreen(scene);
}

/** Caja registradora pixelada (decorativa, zona inferior izquierda). */
function buildRegister(scene) {
  scene.add.rectangle(130, 500, 180, 110, 0x241a34).setStrokeStyle(3, 0x7b2cff);
  scene.add.rectangle(130, 452, 120, 30, 0x0b0b0f); // visor
  scene.add.text(130, 452, 'BODEGA', {
    fontFamily: 'monospace', fontSize: '14px', color: '#00ff88',
  }).setOrigin(0.5);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      scene.add.rectangle(70 + c * 40, 490 + r * 26, 30, 18, 0x4a3a6a);
    }
  }
  scene.add.rectangle(130, 566, 160, 12, 0x16121e); // gaveta
}

function setShopVisible(scene, visible) {
  const shop = scene.ui.shop;
  shop.bg.setVisible(visible);
  shop.title.setVisible(visible);
  shop.congrats.setVisible(visible);
  shop.stats.setVisible(visible);
  shop.help.setVisible(visible);
  shop.nextRect.setVisible(visible);
  shop.next.setVisible(visible);
  for (const row of shop.rows) row.setVisible(visible);
}

function setPlayUiVisible(scene, visible) {
  scene.ui.patienceBar.setVisible(visible);
  scene.ui.patienceBg.setVisible(visible);
  for (const btn of scene.ui.buttons) {
    btn.rect.setVisible(visible);
    btn.label.setVisible(visible);
  }
}

/** Destruye los sprites del cliente y sus productos (al cambiar de cliente/fase). */
/** Muestra/oculta la burbuja de diálogo y el ticket (fuera de play/feedback). */
function setClientUiVisible(scene, visible) {
  scene.ui.bubble.setVisible(visible);
  scene.ui.bubbleTail.setVisible(visible);
  scene.ui.bubbleText.setVisible(visible);
  scene.ui.ticket.setVisible(visible);
  scene.ui.ticketText.setVisible(visible);
  scene.ui.ticketTotal.setVisible(visible);
}

function clearClientVisuals(scene) {
  if (scene.clientSprite) {
    scene.clientSprite.destroy();
    scene.clientSprite = null;
  }
  for (const spr of scene.productSprites) spr.destroy();
  scene.productSprites = [];
}

function showStartScreen(scene) {
  scene.state.phase = 'start';
  setShopVisible(scene, false);
  setPlayUiVisible(scene, false);
  clearClientVisuals(scene);
  setClientUiVisible(scene, false);
  scene.ui.center.setVisible(true);
  scene.ui.center.setText(
    'A CUANTO EL DOLAR!\n(Bodega Tycoon)\n\n' +
    'Cobra en Bs. segun el metodo de pago.\n' +
    'Revisa el cartel de tasas del dia.\n\n' +
    'Joystick: elegir boton   P1_1: cobrar\n' +
    'P1_2: usar pista (si tienes)\n\n' +
    '[ START1 o CLIC para abrir la bodega ]'
  );
}

function startGame(scene) {
  const s = scene.state;
  s.day = 1;
  s.hearts = MAX_HEARTS;
  s.coins = 0;
  s.streak = 0;
  s.score = 0;
  s.served = 0;
  s.dayCoins = 0;
  s.perks = { hints: 0, calcLevel: 0 };
  s.level = getLevel(1);
  s.rates = genRates(s.level);
  scene.ui.center.setVisible(false);
  setShopVisible(scene, false);
  setPlayUiVisible(scene, true);
  nextClient(scene);
}

function nextClient(scene) {
  const s = scene.state;
  if (s.served >= s.level.clients) {
    openShop(scene);
    return;
  }
  s.level = getLevel(s.day);
  s.client = genClient(s.level);
  s.totalUSD = computeTotalUSD(s.client.items);
  const result = generateOptions(s.totalUSD, s.client.method, s.rates, s.level, s.client.items);
  s.options = result.options;
  s.correctIndex = result.correctIndex;
  s.eliminated = [false, false, false, false];
  // La calculadora decide al llegar el cliente.
  s.calcRevealed = s.perks.calcLevel > 0 && Math.random() < CALC_PROBS[s.perks.calcLevel];
  s.sel = 0;
  s.patienceLeft = s.client.patienceMs;
  s.phase = 'play';

  // El cliente entra caminando desde la derecha.
  clearClientVisuals(scene);
  scene.clientSprite = scene.add.image(880, 262, s.client.look)
    .setScale(3).setOrigin(0.5, 1);
  scene.tweens.add({
    targets: scene.clientSprite, x: 470, duration: 450, ease: 'Quad.easeOut',
  });
  // Los productos caen al mostrador uno a uno.
  s.client.items.forEach((p, i) => {
    const spr = scene.add.image(100 + i * 72, 200, p.id).setScale(4).setOrigin(0.5, 1);
    scene.tweens.add({
      targets: spr, y: 288, duration: 220, delay: 250 + i * 150, ease: 'Bounce.easeOut',
    });
    scene.productSprites.push(spr);
  });
  refreshUi(scene);
}

function openShop(scene) {
  const s = scene.state;
  s.phase = 'shop';
  s.shopSel = 0;
  clearClientVisuals(scene);
  scene.ui.center.setVisible(false);
  setClientUiVisible(scene, false);
  setPlayUiVisible(scene, false);
  setShopVisible(scene, true);
  playDayJingle(scene);
  scene.ui.shop.congrats.setText(pick([
    'La bodega sobrevive otro dia!',
    'Otro dia, otro dolar!',
    'El bodeguero no se rinde!',
    'Ni la inflacion te para!',
  ]));
  renderShop(scene);
}

function renderShop(scene) {
  const s = scene.state;
  const items = getShopItems(s.perks, s.hearts);
  scene.ui.shop.title.setText('DIA ' + s.day + ' COMPLETADO!');
  scene.ui.shop.stats.setText(
    'Clientes atendidos: ' + s.level.clients +
    '   Ganado hoy: +$' + s.dayCoins +
    '   Monedas: $' + s.coins
  );
  items.forEach((item, i) => {
    const row = scene.ui.shop.rows[i];
    const mark = i === s.shopSel ? '> ' : '   ';
    let tag = '$' + item.price;
    if (item.disabled) tag = item.id === 'calc' ? 'MAX' : '--';
    else if (s.coins < item.price) tag = '$' + item.price + ' (no alcanza)';
    row.setText(mark + item.label + '  ' + tag);
    row.setColor(item.disabled || s.coins < item.price ? COLORS.dim : COLORS.white);
  });
  scene.ui.shop.help.setText('Joystick: elegir   P1_1: comprar   (o clic en la fila)');
  scene.ui.shop.next.setText('CONTINUAR AL DIA ' + (s.day + 1));
}

function advanceDay(scene) {
  const s = scene.state;
  s.day += 1;
  s.served = 0;
  s.dayCoins = 0;
  s.level = getLevel(s.day);
  s.rates = genRates(s.level);
  scene.ui.center.setVisible(false);
  setShopVisible(scene, false);
  setPlayUiVisible(scene, true);
  nextClient(scene);
}

function useHint(scene) {
  const s = scene.state;
  if (s.phase !== 'play' || s.perks.hints <= 0) return;
  const wrongIdx = [];
  for (let i = 0; i < 4; i++) {
    if (i !== s.correctIndex && !s.eliminated[i]) wrongIdx.push(i);
  }
  if (wrongIdx.length === 0) return;
  shuffle(wrongIdx);
  for (let i = 0; i < Math.min(2, wrongIdx.length); i++) {
    s.eliminated[wrongIdx[i]] = true;
  }
  s.perks.hints -= 1;
  refreshUi(scene);
}

function selectOption(scene, i) {
  const s = scene.state;
  if (s.phase !== 'play' || s.eliminated[i]) return;
  if (i === s.correctIndex) {
    s.streak += 1;
    const earned = 5 + s.client.items.length * 2 + Math.min(5, s.streak);
    s.coins += earned;
    s.dayCoins += earned;
    s.score += 100 + s.streak * 25 + Math.round(s.patienceLeft / 500);
    s.feedbackOk = true;
    s.feedbackMsg = 'COBRADO! +$' + earned;
    s.served += 1;
    playGoodSound(scene);
  } else {
    s.streak = 0;
    s.hearts -= 1;
    s.feedbackOk = false;
    s.feedbackMsg = 'ERA Bs. ' + fmtBs(s.options[s.correctIndex]);
    playBadSound(scene);
  }
  s.phase = 'feedback';
  s.feedbackUntil = 1500;
  refreshUi(scene);
}

function onPatienceOut(scene) {
  const s = scene.state;
  s.streak = 0;
  s.hearts -= 1;
  s.feedbackOk = false;
  s.feedbackMsg = 'SE FUE! ERA Bs. ' + fmtBs(s.options[s.correctIndex]);
  playBadSound(scene);
  s.phase = 'feedback';
  s.feedbackUntil = 1500;
  refreshUi(scene);
}

function refreshUi(scene) {
  const s = scene.state;
  // HUD: corazones pixelados, monedas y marcador.
  for (let i = 0; i < MAX_HEARTS; i++) {
    scene.ui.hearts[i].setTint(i < s.hearts ? 0xffffff : 0x2a2038);
  }
  scene.ui.coinText.setText('$' + s.coins);
  scene.ui.hud.setText('DIA ' + s.day + '   Pts ' + s.score + '   Racha x' + s.streak);
  // Perks en el HUD: solo se muestran si el jugador los posee.
  const perkParts = [];
  if (s.perks.hints > 0) perkParts.push('PISTAS:' + s.perks.hints + ' (P1_2)');
  if (s.perks.calcLevel > 0) perkParts.push('CALC ' + Math.round(CALC_PROBS[s.perks.calcLevel] * 100) + '%');
  scene.ui.perkHud.setText(perkParts.join('   '));
  if (s.rates) {
    scene.ui.ratesTitle.setText('TASAS DEL DIA (Bs/$)');
    const lines = ['DOLAR  ' + fmtBs(s.rates.dolar)];
    if (s.level.euroEnabled) lines.push('EURO   ' + fmtBs(s.rates.euro));
    scene.ui.rates.setText(lines.join('\n'));
  }
  if (s.client && (s.phase === 'play' || s.phase === 'feedback')) {
    setClientUiVisible(scene, true);
    scene.ui.bubbleText.setText(
      s.client.name + ':\n"' + s.client.method.label + '"' +
      (s.level.igtfEnabled && s.client.method.igtf ? ' (+IGTF)' : '')
    );
    scene.ui.ticketText.setText(
      s.client.items.map((p) => p.name + ' $' + p.priceUSD.toFixed(2)).join('\n')
    );
    scene.ui.ticketTotal.setText('TOTAL $' + s.totalUSD.toFixed(2));
    for (let i = 0; i < 4; i++) {
      const btn = scene.ui.buttons[i];
      if (s.eliminated[i]) {
        btn.label.setText('—');
        btn.label.setColor(COLORS.dim);
        btn.rect.fillColor = COLORS.buttonOff;
      } else {
        let text = 'Bs. ' + fmtBs(s.options[i]);
        if (s.calcRevealed && i === s.correctIndex) text += ' <=CALC';
        btn.label.setText(text);
        btn.label.setColor(s.calcRevealed && i === s.correctIndex ? COLORS.good : COLORS.white);
        btn.rect.fillColor = COLORS.button;
      }
    }
  }
}

function update(time, delta) {
  const scene = this;
  const s = scene.state;
  if (!s) return;
  updateGame(scene, s, delta, time);
  // Los flancos no consumidos mueren al terminar el frame: sin inputs fantasma.
  clearStalePresses();
}

function updateGame(scene, s, delta, time) {
  if (s.phase === 'start') {
    if (consumePressed('START1') || consumePressed('P1_1')) startGame(scene);
    return;
  }

  if (s.phase === 'gameover') {
    setPlayUiVisible(scene, false);
    setClientUiVisible(scene, false);
    clearClientVisuals(scene);
    scene.ui.center.setVisible(true);
    scene.ui.center.setText(
      'CERRO LA BODEGA\n\nLlegaste al dia ' + s.day +
      '\nPuntaje: ' + s.score + '   Monedas: $' + s.coins +
      '\n\n[ START1 o CLIC para reabrir ]'
    );
    if (consumePressed('START1') || consumePressed('P1_1')) {
      scene.ui.center.setVisible(false);
      startGame(scene);
    }
    return;
  }

  if (s.phase === 'shop') {
    const items = getShopItems(s.perks, s.hearts);
    if (consumePressed('P1_U')) s.shopSel = (s.shopSel + items.length - 1) % items.length;
    if (consumePressed('P1_D')) s.shopSel = (s.shopSel + 1) % items.length;
    if (consumePressed('P1_1')) {
      if (buyShopItem(s, items[s.shopSel])) playBuySound(scene);
    }
    if (consumePressed('START1') || consumePressed('P1_3')) {
      advanceDay(scene);
      return;
    }
    renderShop(scene);
    return;
  }

  if (s.phase === 'feedback') {
    scene.ui.feedback.setText(s.feedbackMsg);
    scene.ui.feedback.setColor(s.feedbackOk ? COLORS.good : COLORS.bad);
    s.feedbackUntil -= delta;
    if (s.feedbackUntil <= 0) {
      scene.ui.feedback.setText('');
      if (s.hearts <= 0) {
        s.phase = 'gameover';
      } else {
        nextClient(scene);
      }
    }
    return;
  }

  // phase === 'play'
  s.patienceLeft -= delta;
  if (s.patienceLeft <= 0) {
    onPatienceOut(scene);
    return;
  }
  const frac = Math.max(0, s.patienceLeft / s.client.patienceMs);
  scene.ui.patienceBar.scaleX = frac; // origin (0,0.5): encoge de derecha a izquierda
  scene.ui.patienceBar.fillColor = frac > 0.5 ? COLORS.patience : (frac > 0.25 ? 0xffe600 : 0xff2aa3);
  // Paciencia crítica: color rojo + parpadeo (redundancia, no solo color).
  scene.ui.patienceBar.setAlpha(frac < 0.25 ? (Math.floor(time / 150) % 2 === 0 ? 1 : 0.35) : 1);

  // Navegación 2x2 del punto de venta.
  if (consumePressed('P1_L') && s.sel % 2 === 1) s.sel -= 1;
  if (consumePressed('P1_R') && s.sel % 2 === 0) s.sel += 1;
  if (consumePressed('P1_U') && s.sel >= 2) s.sel -= 2;
  if (consumePressed('P1_D') && s.sel < 2) s.sel += 2;
  if (consumePressed('P1_1')) {
    selectOption(scene, s.sel);
    return;
  }
  if (consumePressed('P1_2')) {
    useHint(scene);
  }

  for (let i = 0; i < 4; i++) {
    const hot = i === s.sel && !s.eliminated[i];
    const btn = scene.ui.buttons[i];
    btn.rect.setStrokeStyle(hot ? 4 : 3, hot ? COLORS.buttonHot : COLORS.panelEdge);
    // Indicador de foco visible: borde + pulso de brillo (no solo cambio de color).
    btn.rect.setAlpha(hot ? 0.85 + 0.15 * Math.sin(time / 120) : 1);
  }
}

// Arranque solo en navegador con Phaser cargado (permite probar la lógica en Node).
if (typeof window !== 'undefined' && typeof Phaser !== 'undefined') {
  boot();
}

// Hooks de prueba para Node (sin efecto en el navegador).
if (typeof window === 'undefined' && typeof globalThis !== 'undefined') {
  globalThis.BODEGA_TEST = {
    genRates,
    computeTotalUSD,
    computeTotalBs,
    generateOptions,
    getLevel,
    genClient,
    getShopItems,
    buyShopItem,
    fmtBs,
    swapDecimals,
    CALC_PROBS,
    PAYMENT_METHODS,
    PRODUCTS,
  };
}
