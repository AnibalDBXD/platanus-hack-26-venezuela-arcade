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
//   7. Assets 16-bit embebidos (data URIs) + precarga
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
  cardboard: 0xc9a35f, // el cartón sigue siendo cartón (diegético)
  cardboardDark: 0xa5813f,
  cardboardInk: '#3a2a12',
  counter: 0x2e1a34,
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
// Colores del pad SNES (JP/PAL): X verde, A rojo, Y azul, B amarillo.
const PAD_COLORS = [0x3bb273, 0xe4405f, 0x2a7fff, 0xffd200];

/** Aclara (f>1) u oscurece (f<1) un color RGB. */
function shadeColor(c, f) {
  const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 255) * f)));
  const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 255) * f)));
  const b = Math.max(0, Math.min(255, Math.round((c & 255) * f)));
  return (r << 16) | (g << 8) | b;
}

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

// Konami: ↑↑↓↓←→←→ B A (P1_2 = B, P1_1 = A). Activa dinero y vidas infinitas.
const KONAMI_SEQ = ['P1_U', 'P1_U', 'P1_D', 'P1_D', 'P1_L', 'P1_R', 'P1_L', 'P1_R', 'P1_2', 'P1_1'];
let konamiPos = 0;
let konamiPending = false; // lo recoge updateGame (tiene acceso a la escena)

function onKeyDown(e) {
  const code = KEYBOARD_TO_ARCADE[normalizeIncomingKey(e.key)];
  if (code) {
    if (!held[code]) {
      justPressed[code] = true;
      // Seguimiento del Konami por flanco (sin interferir con consumePressed).
      konamiPos = code === KONAMI_SEQ[konamiPos] ? konamiPos + 1 : (code === KONAMI_SEQ[0] ? 1 : 0);
      if (konamiPos === KONAMI_SEQ.length) { konamiPos = 0; konamiPending = true; }
    }
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
 * El `id` coincide con el índice del frame en el atlas `products` (sección 7).
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
 * Tasas del día en Bs. por cada $1 del ticket. El euro aparece como método
 * de pago ocasional a partir del día 3 (level.euroEnabled).
 */

/**
 * @typedef {{ name: string, look: string, items: Product[], method: PaymentMethod,
 *   patienceMs: number }} Client
 * `look` es la clave del cliente; su índice en CLIENT_LOOKS es el frame del atlas.
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
 *   hideTotal: boolean, events: string[], clients: number }} GameLevelConfig
 * `roundRates`: tasas redondas para cálculo mental fácil (niveles bajos).
 * `obvious`: distractores con diferencias grandes (niveles bajos).
 * `hideTotal`: el ticket no muestra el total en $ — el jugador debe sumarlo.
 */
const LEVELS = [
  { day: 1, items: [1, 2], patienceMs: 32000, dolarRange: [50, 100], roundRates: true, obvious: true, igtfEnabled: false, euroEnabled: false, hideTotal: false, events: [], clients: 4 },
  { day: 2, items: [1, 2], patienceMs: 29000, dolarRange: [80, 150], roundRates: true, obvious: true, igtfEnabled: false, euroEnabled: false, hideTotal: false, events: [], clients: 5 },
  { day: 3, items: [2, 3], patienceMs: 26000, dolarRange: [120, 200], roundRates: true, obvious: false, igtfEnabled: true, euroEnabled: true, hideTotal: false, events: [], clients: 5 },
  { day: 4, items: [2, 3], patienceMs: 24000, dolarRange: [180, 300], roundRates: false, obvious: false, igtfEnabled: true, euroEnabled: true, hideTotal: false, events: [], clients: 6 },
  { day: 5, items: [3, 4], patienceMs: 21000, dolarRange: [300, 500], roundRates: false, obvious: false, igtfEnabled: true, euroEnabled: true, hideTotal: true, events: ['happyHour'], clients: 6 },
  { day: 6, items: [3, 5], patienceMs: 18000, dolarRange: [500, 900], roundRates: false, obvious: false, igtfEnabled: true, euroEnabled: true, hideTotal: true, events: ['happyHour', 'blackout'], clients: 7 },
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
    hideTotal: true,
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
  // El dólar pesa doble: el euro aparece a veces (~20%), no en cada cliente.
  const methods = [];
  for (const m of PAYMENT_METHODS) {
    if (m.rateKey === 'euro') {
      if (level.euroEnabled) methods.push(m);
    } else {
      methods.push(m, m);
    }
  }
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
    { id: 'hints', label: '3 Pistas (P1_2 elimina 2 falsas)', price: SHOP_PRICES.hints, disabled: false },
    {
      id: 'calc',
      label: perks.calcLevel === 0
        ? 'Calculadora (P1_3: 20%)'
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

// ── Soundtrack del día: loop chiptune (montuno arcade en Am, 2 compases) ──
// Se agenda paso a paso con el reloj de Web Audio desde update(); solo suena
// durante las fases de atención (play/feedback), en la tienda y menús calla.
const SONG_BPM = 112;
const SONG_STEP = 60 / SONG_BPM / 2; // corcheas
const SONG_LEAD = [ // 0 = silencio
  69, 0, 72, 0, 74, 76, 0, 74, 72, 0, 69, 0, 67, 69, 67, 0,
  69, 0, 72, 0, 74, 76, 0, 79, 76, 0, 74, 72, 74, 0, 69, 0,
];
const SONG_BASS = [ // Am – F – G – Em con octavas sincopadas
  45, 0, 57, 0, 45, 0, 57, 0,
  41, 0, 53, 0, 41, 0, 53, 0,
  43, 0, 55, 0, 43, 0, 55, 0,
  40, 0, 52, 0, 43, 0, 55, 0,
];
const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Agenda los pasos del loop que caen dentro de la ventana de lookahead. */
function tickMusic(scene) {
  if (!scene.sound || !scene.sound.context) return;
  const s = scene.state;
  const ctx = scene.sound.context;
  if (!s || (s.phase !== 'play' && s.phase !== 'feedback')) return;
  if (!scene.music) scene.music = { next: 0, step: 0 };
  const music = scene.music;
  // Tras una pausa (tienda/game over) o con el contexto suspendido, re-sincroniza.
  if (music.next < ctx.currentTime) music.next = ctx.currentTime + 0.08;
  while (music.next < ctx.currentTime + 0.2) {
    const i = music.step % SONG_LEAD.length;
    if (SONG_LEAD[i]) toneAt(scene, midiToFreq(SONG_LEAD[i]), music.next, SONG_STEP * 0.9, 0.028);
    if (SONG_BASS[i]) toneAt(scene, midiToFreq(SONG_BASS[i]), music.next, SONG_STEP * 1.1, 0.045, 'triangle');
    if (i % 2 === 1) toneAt(scene, 6500, music.next, 0.03, i % 8 === 5 ? 0.018 : 0.011);
    music.next += SONG_STEP;
    music.step += 1;
  }
}

// ══ 7. ASSETS 16-BIT (pixel art embebido en data URIs) ═════════════════════
// Dirección de arte: pixel art SNES con paleta neon-arcade (ver COLORS).
// Todo va embebido como data: URIs — el arcade no permite archivos externos.
// - bg: interior de la bodega, 200x150, se dibuja a escala x4 (NEAREST).
// - products: atlas 4x3 con celdas de 24x24; el frame = índice en PRODUCTS.
// - clients: atlas 5x1 con celdas de 32x40; el frame = índice en CLIENT_LOOKS.
// - hud: celda 0 = corazón, celda 1 = moneda (16x16 c/u).
const ASSETS = {
  bg: 'iVBORw0KGgoAAAANSUhEUgAAAMgAAACWCAMAAACsAjcrAAADAFBMVEUWCiQLCw8aDy46JFJVILB7LP8A9f8AqNgAeJ7_KqP_isiwGHD_5gD30Rf_6Wr_0krUoBfPFCvoMEqeDiAAJH0rOl8A_4gui1cfakLJo1-lgT_15sj49Ojn5_-8vM96epprQiZFKBLGjl6eakCNVSQaGhro6OgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmKUpeAAAdtklEQVR42t2dC3eivNbHQ-JUO46tVbMs-CxIuBy__zd8_3vvBAKC1XbWes95Mi3gpZgf-54ERymVZfjBhg76NhzGZ7O-9U_LIzrg9w-vZ6PGZwufEl6dvOO2qeGzsvjpch6l0m4MXdT81vTppTYGUemHhU9c6tT47U-24cPV5HKNm0ZTD4HEE46EFh5nPYoarqcaX9QfgaQXc6IyPYiKJA_RDKfuO5vwqOlrk7f_jGReFKHfRMEKlj0mlUwNyjLqZVDgkWFlcyb2U5CFbgqIekK_5t62oAm3Vv9zkJFDSqxbB5LFPj5sO3MX66ZLD9pC-ve32jD2H1OQJ61-Qe_Gkks7OXiFeYwFwS3qxPQdIxD9A6nMSGP8Yc8by2JnxhFnRrUSW_mRZOY_LZu5nP3rZnXTrLF6SSS3MpuABBT1d5p8kNa9vqiRu_4CxOiV_io24-yhtzcgT3mwx6KO1klmMevzbkGsMcau9KJusOIyx5JEQtryVxVMhPIMiHGentF0wbPlkNbLIzqrBOAvK1jsvevSFOA-iDW-3TktIHohVIs8slGupYPHSqH-noIJyX7n_Gx4CzoygBjC-LPz2gjIHZKjfwAkJMbZX1EvlRV__uwKo0aBJbuVCJmGdrtdYdEXIyCL2nX8OA6vLHOE9OXbUomOSja2KvaNUq7tc7-0eMgyyxDaQXLGOns6aVXgcQhvtzLJMn38mAWJODd2v0SS3U8sJ0Gauobd7s9-v_fad90kkmiIQrU76JQjlbKmI21UPchUW32TeZFIlj0CcgdlKAvv5Vfx8jujeVcApcuK3b4p2v5Tu6Ipdjug7HeNVaRlBuq__7PbO-lCWoPwB0L7OiLxsfZRdyHGLiKJy5Mk5MvEQ2XoGL3tdLKWrufuz58_0DIA7XetQp9hQYokAcEZtpVO2z2YldPTSK6V3-Ny4KQdRBK78AiI1mpU1n6nau2iBkHDcFFc0zg8xIXd7TwpioN1o__QKWVCXD-dmk6hr0fvITRqWnvvHQkLkqPTeT_gTUD03azw-x4s_GV3dHx0IpPBs8ZaI5ISSZjjMYBYj1SLXRNsWkHpdrt3rxw_Ut6dTtltzT5CWSLRIQnoHdy3mj963putk5MAQJ5wyrIgvA6O2KP7-ChPIoESQhf36MSRsTRJbtx13XfvcRB9F6TDq51bgFVdeFMAUsej7P1R2xAPA0inKI4AhAxBd01R0N_SQ8VXZA7EjFmWQMzXIBC6oddd47rZ1-Of-uBYjy70I0oiifCSa0HZ6NOhfPwn8FTpCcYg5CV0n0DO04wkskjinKHYDIcCa76hgEXYUSE3XBPKdW8bXs5IsRQpoyjTVBTpeTKxs_tieQQkc3K1yK917obErtGsPm5Dn-ic8VQz9UjIfr28yQdJKDeWcCcOLYDIiRBbZxKVx0HIqQ7Nd973dQK_Thwv1my3r1tDagBFQJMXF0G0EhDlb0WA5zsnTUAMp2giliTpmqSQ4RreAWlqANTSclw56iedHVvFINUAolcnbishWQaJn6dSO4PjFiUegShNAZfORnpqdWS4BdFfgDQ4ZSSB1VdoRlna0uvV6-trBZDXAEKcp9WJMoQBxC6BDBwGlqil_zcgOOPJmqmKjeoTlebICyAFJFIkIGUJhBVtcfFGIHi6yku8Up04TzBDiTsLorLhc1gUZhbExjao2LQMfgikhrevB5BVxUMIVbVikHX1WrFqbQWEG0sku-IgOF1l5kAy6iP_gdV8sjmQTJ-McMAJshKQfM24_tW9o7kHkjQnfQ1bisQvL-uXBCTKQEBKRkEvV4lMUn0GBzuRMYiegAQO1tpULIN2fQUCYesmHzhytpG6NNrSVkCAsgQi4jFpcJ-CWOK4J5FBtU6nU69imgTErvlRiWRj96vZzBEGaUt_tEHDZSIO6LwVr4WkMUikRB_JmMiHGlKO4Ow449SD-ivjDaUQaPDv3nBLQOgPWcXEm3CclGIzAcmWbKRz3rtvNcnETWNt8lzXeZzQc5zLKNxRDi-ZvHxcyOvph18bQE49MR2ROFj4dkgm7xp7lzdtXufSRLfiQXwQXqIn8-HZ2hXc4CYKfjm8xlLlC50ZLwpkAqbIgAJJOE5V6xRJWLYEYvXqF0dInWbIiyB1g0j-neao54XDL_-riSmSGNZsY7LuqxbjiDHCccKeih1Npdzq168eRI-C7CzI9XvNc6-hlwinDXho3zoHqATk-uXIfZDIyUQHTCCGJUQgv-zUoJdBHip5dZyHgYGjYcsSaVvxEC0dFo0LqY6LINmjIIP3JRUzdkNj-gSyUmlApfGMZYlIcU6tr9Snwz6dhDTKj1m7dXb1rFqiVYTkIA_Ip2VB8Sj11yDXEcgpsXcjNgKQJFL0AX9ZIteOOuHaxuFys4niUvtEMTz7KfR_ABHbjg6rEdMXOym-Aglqknotc9pQ940d0pVbkBWFvdkKkUE67kJbuLZ1fAiItmldJtZAV46SMbgYHDlC7iLITIOkCk4s7oCEniK4jCRiBue1DGLsbKUO1ery3Z4bur_nw90el9j3AYNKFnKfPMsgkZlBkDEX8FLksBp2YXwIe28kYzfBpKJdDe00BTGA0Ik0OK-f2ghnD8bwZg7E5QcaeNvvC_ShxtGOmFwAaRwubefR00YhPiijvTc0VAUQvNhCiqEKAI6TPLqROGKuwfgGCwzDnEYygSGy93IwQ1icBeHsQRPRDEhdA2K3gxwAsi8gkF0BSTTcyRogyGLyt8YzhkFXaYTCsYkUjQQSbkVULZYIzCkLF9lUSB1dWpOSpz76YxsHRUKGEuKJSVRrBCIRJiR1IxYG2eV0AfZ_ALIrcETzA571hLrm6MJ5uCQp1j0MyBNIPjWOgosBkgi5X1QiyoTo4MBhJbhIz49khw41dhgOOt22EEfGICQNo_vsNEFhkHd7QqFk3_dun-PQnhoGaQqKEpRzq4wuKWtmvxCmkyCOt9W0FRtxtahWxhVhl4DQtQyVlVFZsL6Yopxm27xEVAKSsIiN5BV-yppUi7LZusrrjkgc-bEW-Z1k1lwhUcnIQaVB7IBqFYRSBImEIwHhj-TM3EkhayicUXqT8WgwVNV_DTL2WuK3zHj-tQdpcupa2exdy-VFnjcAgf9F4MYPDdyRz1IUbDyS1o_Dx4fpmpAopioWjIVVSwXVYhDLII7U1FgolCG3pGLl9BSIkbE0k7YoEfETOUlEsug9QPpe4V2kY7h-MIIGF_OAfNnx2Ete0DbEDzB7VrPcc7FuZKjJhuyJ0t2jhj3D7K0I1VYBZHU6rXh4hg_QcIBqbQGE83sjNR1j2JVlkLeK_EUDr7Xfkd1ZeK3O5y3VFm3dUtXSkql42nmAHA4fDhKBvBra1mIjZDKc2OfBv0GExniqWKz3krdzhdh4zkZOqHB7kFXof9_oubsgZVn9-gXbtfyUgFzQBZqEccWfHSLB_s8OEskdJfiOZNBRxtJpMpvGaf9xgJw67vt8cCeQFU08eNg7qlxnQylypIyhOYbysI8jUwyWz8ou2IgcAOSXgFizqgSkuOTACCAI7H8YBJ315IRJtYo3YClfv1FJ7w-XC0CKG_fryGH5QkBwoahcVOK1TqxaR4AgC2r8Ea1FHDmOQFZx8C9yzUskglQEQgZjVuXKAKTd53nBsd3tGQSxsfaelSXYiCvQJU3jwh6q9VFDtTxrFOXucVQMh07KK5EIDASOTffulyUCAICwGzliN6gWG0no8kkezoKsIghxrOCEKHIKiN9TNEfDB0jWtdu3WRdqDcqrdIWAJqPy5H6322ZrYOyO38JeVyRS9KqlANJ1V8paANAF1-JD8ZtxjakzP7jfzabHYJQN_s2kKKJb7HVLONqqafTKKhxo-PzOD2MHyTCClMAdD9byBe3CruPr2zV1sZQAE4jVn58diSzWxsTijeeRIODpZBRlisEkX4DII80DakgbANLm9XLLHQ1yNe3tC218rihCskU1AMQC90uz01Z9WnYSrRk334jPSEDQ6ZtRw2WJcBzp8y24dh4Yrfm0QY14R5s2tsZDgBcyhqbhF-ObGrYRdJ0Kl1rcL7wzp1oU2ZHbflpNL7lJ4d4h-ID1mpS6p9PsgNsiCKRgKxrYpSE8qDuNGn05-MAg1-z2hYadAYTVjxsX8SiAGF14dLqbkLCGdSnIwvzTgrGTtQOERmsN1RY2SKSvPJUkYHNT7XOjIc2yQroAomj0q_aTv74mZVY_YzU3Jn0HxFpKCiubU7oTQK6Z2m75DVvab7RRkxGCLI5PpUDXYcR4NKaXgFgK43kThjdi77GTmpF-70lEjVVLGRucH83vkkjCbIHhowFkC2dAw7xkguNrePXNaJxUWj9iPAyZink1FHMI5BPZmXtvqeiQVSdyMkfjtGhXipdPgFhT7GPbtTITKyAkBh4OChmDVHOqB4k4_VjkCCTznSglXynO800_ikZhCjbic-SeHPXoGZ7xyHi4WVy7fxKEox23PwVnwSwfBtECsmWSM-RRbdGduEQkrL9xPKXV1LBRn4WBHKRpjaPR-LJKW1DjKxwk3K_x7zASz2tuKJ2ni6ionuLzNV0_9tvPcdwHCePN1BznapYnkCrDXguX9RVdeH011cuadibrT8uLeqACfBHxz_hMtJS2MIVrfomtDE0mIKmq-vw0Xes44wAIbxjEUSbaIG3Rxo-NXX0BwokYzZbREhiuNjkg4Rlxv2pb0SyOXsnOeElNtSQSLY1N8FSWdzxnYfWV1TNvUpBLgoQ4l0FkPMAZS3A6oHBO50WRYhlOf-21JiCEQSQST4-Hw5GNnd0vDWlstygDkZluueyQsaswKYNK-B1uqYFQuowmBHjJB7ZLIJeLpew3TJnzOMJJdIs-XtP4WpjLsXdBshuQOKglJQDaFjGLJUIg6vV3_Uoa9TvHHnmx-9jyNJvbHo8koaJGmoL83HPaRxyW1A5-AiA0Ck_aFF0YHdF8HYHAoGgQrmnYFbTBH1Dxf5Lh9iiRfm1IGuHNLQitnQrtyCD4NCful0HQ_Wptj7Rfr4FZbatqC2byyhARV-UHgGh7Pp95MsmeYSYEApN4m2ZhOZXiioJUhp5FQg3XbBiE3KNom03n03jaMO5wcFL3QDxLhZXKULZCqkXdX78AhPZr7aj7ZCpbyma2XtcoCOt3ZLFkWwA54yF2AaSuP8btICCUvWe0pEHGjBrEFAE5GbYbQ6u2pyCphdgxCF2BJp187gceEPE5IGbVGiawPtl1lb-_bbgk3--P-njYNmRLHV_luvDG5u_vZ_g8PEKMENWqipSBt7UR1-1NRiSGhh9cQ3uqaRS7TaoWjzEgZiqdKBCxKW2nqmUSkNz1dtIHxGyd73b5i7Uv77v3aq3NAXHn3QEE-_pI04wwaYB0n58O0dp8NsXnGKS-fBwux_pyyQUE7jeTiR6djO7wDLrRNHxx5DYDokTtDO0nIGHtRD8AlD6tFWp2BUmQrn2uq3JdVejgbrc_GH3EfkcSKcCBvN11n-e8-IShoDKegtQAyevmEiRyBQSD9O6X_a_lyVkEdAGJkT1RLQHhmQM1BlmtqqWGuH6l-ZG1xMENdtUrbONAzWl32Ne0x1vq5oi47j9ZtWwBb_xpI0jDIG_NG0A-BMTCc650mFbonWkWk62sU5LxIPnpJ2nJGSstw0McOtUUpELeceZ_dHDmzZn3G3wYSYSiOkAs77fKH8j5wr0dP7awEZW9Iy1syNjPSA3O8FjY0rhh3Q4gef72kYCQ881irX6vhUX0FG9k3aaCL-BCa6paq815SSLnSkBeuRnDO2RdR44fRh05nNBECI2mIKe1n5-fNk5cKp-A5M0lBaGRZvU4SIZOUwjpTYXTMj0FqV7m2zqAXI3EPx12SkYgKIpTwivLRkgRrsqCQxTadvjTAeTt-JaqFmfQYaLngVldnktEcFS0cINw7IxqVV-CxLqicCy7kJk2TdHcb663Efgr-XnLj9FGfpnrw9PTfB_USdm40k_LIroRiGKQzRr93syDtC765rbKyzx3QwFe1JIyz4_7DCAfTfNxpJ_6GG3EmGjs8_3vJguYlV6FPScusgp8BEKqtRaQ9bxE4vr3LqtKpK4ZT_ZxaWDkx9zcbCHvH1TreKQf_hUQmnlbBiELGi3hSNYvJiuyZ0CQgaxL2hAL_64TGxm6RuYntwSEtS1xicuMsl97EDiCj6b-wL9DjnTmyCA6G4Nc-9s8OpqrDyuNg7EjHaGEeHS3mL0FWVf_KTeb_4Bks6FsCptNhU2USP9ZqncmmaXpWqpcWhpd1ekASBxH6EHyI_u1XKZ82mNtbkFCd-LsLkC42g7uV8Vp6tHtLFdecxplxCBldUJNGhUMPHyQSCRM722lIYO2K5u0XiKcj_M6RZOANLLKiTOhJv8YgfAYkxFh6y6sbuLlsnw4Wa-s4x06VlYX44N1ArIpERXXJAQc0O-m-l2tU5AgiK1stLmeqqY6bexpUzWrTZTIVfPgnrYoLa1mkJJUSyRCO9ocBhCSXH8jTtevMYVvHy8FDKII3ATxi8d108W2DLLenDakV9UrnNjrFiBI2asbEBWWtKIXAAGJph1VQbzGt4sRB9VKvTWdpPGwD3itwwGe69DUzBNBtMh1RWm2FFXzIEEKPDb9K0xKTW4tGVQLUlmTRFgqm_I3iFLVCneHSEehE5uKUnuLXV2vASIjQua1-t04VF6_KwIJEhFfxWmgw-_HYOzTFteWOrliUC8V7yIggl-sTcOq6xmQNUBg8GtElM3Lhg8SG-krlAiis3VZlvRu3sEgZBLRvNY5apgtbwFyZZCPfpwOJI5ATADRUxDTg3R-cL_61youi1-8DyHGEfFYGzF1Oti89BLp-sUz_YhktuFmZadplQfyqc68vr_XAMnf82qQiAhjKEMHEJ67tWEJMw-hxCXltO-SG2GyL243ymIcmWk9iMvrd5RShe4XE_BQ3WaTCQg0xfH4AlTrtSYbea3rVQSpD5NS9yMPFWInK7DJrcji_V4opqM40kUb0V_fMyUgL-u5XGsAORxQIlZWQCgPNmvqwlpvaL_ewNk2RVU3Hc-Px-X_ASR_a1DTH_rM5fB2CeVbVkWJGFn4SkOsKtw3Iotmu0dv-7oH0tuIe38v7EpmUyWhtxX1rdJneKNDc7Yo1vf7fUGDkzwIw1vxWnXMOV1cdcIL7FSsR5Pa9MZkYmT_WyCmOpGDPJkqViayLH-tpZSBRChrzAvtfr_-JtX6_Tu632GALq109DX4mmvWL8KhalBls7cmfQ-EqkTaDCAnGvZZbbeQzEFADJw0vJVG9VuWLwBp65bG9BwPeMH90tIJVq1qbqCxJNdK83Me4bvP-ml91E0t8BgIrU4nkM0neoTuo__r9RXCP9uz2SQgrFNbut_zEECQz1frbvNSvufrjbF5UaDY7dwrnjbsfitxv90SCM_Q0yrsUAPQ0uDa3dQCT4FsbGXxW503ML2NQy7Vbbfe9iBaTINB6kMPUgKERryqjdE03oCqPbrf-j0Xr5V15SwIrefqeJhHi1GjoPQxabxZif0wyGm9gQOEOtGBq3OfHfJ2AJFiPYdqQSL5-wE2QoGwZImQamkjw7sdu99V4n4zO0dSDgPN2owGnb9p7D0IdMqSNyfjaC65yvLL0Za9RLYybNIVUuF21wxmYTmO0N7SQkDOkK58SwcthEBCyBVAaWZIyqHv-pHBh69BxNgRyk8kDPQJB4gaWh0Ox8-yr9l5Qr3pZ9fDkaNldcb1j5OpeN558VralDMgNAPj-T4FWR5AqwSSeza-CXJanSi22jP9usOWQaJEWrew8qEh9XJ35qBJIvmF5iFmQIqGZ1DJURXBXbl-GULbEz3lftds7KQrtOlYW_DMULPPN1OWl3_8-FUu4Dux2iCRC5IQU_1zI5FOhOG8kbXqtIqon8zsZ2cflYgS97sZ3O-LZI7nJGlcWIDfiVlk_aIH1N2a73qixPIaavaLkNhyYiO8SI3WDYUpMFrE2c8uPw-SJI1hxCFu1usvQIZ14HFyTEniIblfrNnR738gkZWtkiBvaDknrz9FUo28xZgaj4rdtyUSAqKMa6UjKC_jURSqjPuRem-66TdtUGZPY4dSuSi6vSgBgQgczTEZJ7O6fKeeTO-4vIS06otpfgYSJaLty4vVKJQM9Mt0Ly_nbp2CjO4Xuxnq7GdUss54TzMcW_rmhwREUi16B6-7ZRtxzHKhxWH5hWbIGWS__zmICSAWD85-PdjItRvdzkb9CdPqTqcgkC9Vs87TSNEUhAVThXTThGSrcXR7X2kqVrSfS4RqW9TfCIdr-wLbWL98VnaQiKRyMR33qNjDsHXnWDY4JmVyDALX6dtmOwsCufBy3KBapE7VBWxACSB9iwsYngJZc6G3QnqCiv18rmhutrLrtB7h9vb2hm1r4tJAWr0XQVjntDpSDND0PSHzICSVspQ4Qos-XCVPNb5onE2X8Me7LJ8KiJbWN1Hpul6teeF9B-EP2a-jSxR6lO9bzhCpuY6G2K6DjQiICZXGPMgQ2aWVYjUeEpncjMBcz4FsDzUZxjqDr-qQojiK7GOQeOPkfu-yIicJVgxypZtfZDCb55zlxh4CewzEEwhkolOQCv9O3wLZonJG8Mjw2xmajEKSOICMbd3rpmI3SmsKZPVMAMnkDjoThvEWQeg2-L4AxqMKrmskkbBOmRayq8fCSMy1zIZGFjYdqRaP5cK9JBJ5Czexvr2RRLTcvFDQHTCeF0UhHQnrdnl35SFc9QhI4coLgVwqV0eQatVLxj4LYhlkzTaCNItsxE5sRPrwtn-HjeygafCUNPpUUNar-S4lSMh9kPu90rfQhFL3S5BLSeYP_1u7mZt2HgZRYuyaR2A33eYkd_FruveyjyO-iMtDaQ8b2aPf-3f6WhHH9356T3l7TTPWh30DEGwb9xgIhCGryQvnt8fYnkvjRSLn88v5ExZi4XzPMJUNHcADDwGR40jMrBvYCAXD1rUJCOIyQDoPOTHIbt_6h2wEp-OihJjStT2xPSORz_NC20ziyDv1AqrVyDItSCDrGhhPo7uWFqMggBCIuXq6UXHR2MsRCN9T0gSQ47dA5FulLM0nzDeE4Zk44hQuP1Kj_TuB0GI0z7fAtB4P26I54o_apl30WuUNSNSyY5xkPD4Poq53i2YVJEIkIhR0_9q-U2r3XrvrlaVDU-achMncHC8E5GUsT4FAYY_fUi0lX19p7HIzV64Q_eQrEIZ7WzvO27swTdrR2bhEpNsBs2-A3LaHQHi16-qm9_i3kgNZi-LqIm1hij04svSpyc7RAN0TII0kaU8PmYavnVvZ22_01faqbed1APlqicPiyocZkJJsfQEkXbj9uPuN37on3_dqxjLhx1Ei1-xb7drNgpBAVndB5OstHgXp57dXd2xEQDL5Yq3nvzCQQCqWAfdf9tVfBUm-InhGtWIzEeRb3xfKxp5V5U2jmyDMxPCSJvcqPgaSfkfvyi46XytxRIVlgTdTsMkUzcwILsURrWYX5q10P-u50B5KUYZ7JigNt_caEtm8yfTcKPNc_BnNOWmfN1rb-S8Kk5n_q6zVuX61zOkLcYTxJ7V4IryiMufV5KrfguhZuI5C_tI3nmVI4GiqtuLv2ryjoV9Zx7BA5p4OPjBcfmdKQIezm-lJhy9-VPz9L9ndaHfXyAOGNSaJg2bkhFeS0fdf12Mmrw8uO5zHyNFwTrrh30YTtIkthk8L99v0T8aTJWdeGHxQY7WaXkD99DX_RtMJ3AOfoJ7CqDhtKBdbZct7raruvmqfumRfgiShY-xjDU3E_FPOTr9K-6cqL5d7L-f_3Hv9UpklF2-fBlHpSO2kUS_vdvUepAzr3n-9_IEmqoeNo5IM6G5HLz8DuSOS50ASrVrguNuT8scgIJGB65-BpNZh5ziqn3E8AHKBAlc_BFHZHZ_7gF7dN59HQchMqgf0yy6BDBhzxXn1QEe_FsgjIJd-zdD3JJLdcVYyP_m1AVz-Ckj5E2NP_0eTW6FVD13vsvzn66u9-B4ean_Wc9kJyOi_9pl7f2Xpu0grm9YK9K1KYZGhbMxNOSFfIlPFlYhyM6y1t--zbBThvfINn4-mMToBUfcxHjrLf0FTd63jGdna_xoQ8z_d1L18_X8RxJh_BYg2_w6Q_29D_Usg_wJxGLnJ71_R_g-rHmdffesenQAAAABJRU5ErkJggg==',
  products: 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABICAMAAAA-uQBRAAADAFBMVEX08-rw6dbt2a3suV3S19XQs36wvLd6q7PkjoW2jmGLjI-pcGeUQEM1haI9UHRRKjE0IjRTECwpDh4PBhADAAMAE1cAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWPR9yAAAAGXRSTlP_______________________________8AATQKtwAABvBJREFUeNqlmImS4ygMQMHhMIcBuytV-f8vXUlgW0DSm93WzLjdTkbPOhGIF0lGKQWvr1ESyOs_SCmF_SboGh8gLjj8EfmXvTdNvP8L4MHl_lAZBEgpFRKM-hKQJkAmA2KsgNtJ-PoKldfrlzZo7WZA8D6Fhw7rygGvpt4ouFHmO_30shMA9G_-8QihB3irlBQSnaS-DALFkRFOCzBV3MO70AHwqa8h_jaVPgBaANY1DC5C3STmSxd9ADxQv3NudT1Aikv-EyDOWeQS5G8KgwVG3fq_A2QkuDwBXHmilMECyH5jMQjWfwsYUv0EpLQlmyCUAyC1EPj0JSC-d5FOarEiSQmp1ANMff-vAZ-yKElMx0WMAH_Jl4DHe4BG72DSpylNkWGpmuuz_Z3a-2GMDnJ-dJFblucT9D-fYx0IIRXUsbzSdN_jHmMIMe4gcONCzvDL1eocyhTkRXrKovQYAap2OsUAtSgjSbvbd178IUwALRfsFuHxGAutdrsbQAT4VognwXH9r2St3Wx6A3DnesCbnaISU_TDd4BYQ0-3DPAD7oop5WPMouUtAFudIjGQBKUD7HtuPuoswIcQlDICUOA6LTg1uTC_fFtwGgBTBcLtRgA9j3eUr1ZxCgeg588YKFmDQEHGL9Ysoju87ToFU9LSFAA5tCK83iZTl1anj7zPBNiJQfqrmzBzd1bJbmoVL5pZaGiZ55aEz9K7mnpbaK9BRwWU45R-5mi18-3Ack5X7V1vwFGO-ug48PLrnMMeozY-QxnIZYlRUxg7ISgrqgXw4pcJx2T-PnuleBiXFpB7FChQKz5h5SCo3iUWg0vKbPgE8JLJiVBUk92lXDHIx54pK47JQ9Afh7hHOUiogFrw5CJFNypfLso7eAfUH3MIMAe7ZwF8w9UvUoRmAS3eylx3lwWgPWPNRAjzCDjyT_cso0rZE2S-AdU7ZAC3AJYErfWCiAnQQ_2oHwkQh8IAxm4gdrstyKDdObjoGXD0Figp3yDge_Z0DGknYUHWOoSgg5sAx46A-2ES8_tLKcAZmyXZmJQ7TeH9HSx_bwCZyuMOgZheH8NMgG2UAUBOGgCQWz8dIYvZQZKivMFoYMn156UDQHwXB5GeAMfPD6_vvAxZWm0o5CKDf-sfoE0AkAlQYK2JOd1TQ9awYRgQQupqgcXVw2IaKWtGCyIOIxOAWn-KHKDrlqQxgAX6dbWgRcHjJQ1ZtFCSTjHYYe7B8B8MoFEns2GBEuqCbM504nWw0IL5xgLYvsGYdT0toH_B14aRjPJ-Qf3VghPgLY3LngMCEKAKtBuDvMN8EviqHgiwXB4iADajGwAvtaIEBjhiddDY7I6cPITf3008NwAXNAB2jPX1w3p1u50BoB1FWtLmLILRhQFecSJoWuPhjUHWtQ1qXTety-VBK2YZ6gA2Vql03SiO-vO5Hqg6JU-Ao5exkqHS-oW0BG5EuFe0qtded_nfAa93zxDha1aHcLdBc-4WWwzYol9wrsCFH_6VqV3P-j_MGx_Hlvrpx1mn4IL0Zhr4Si6AETDpDmOdr2kOaeqYr_8nwNbgK_6eoc7DsNfAu78BklhjxD0fP_LQ8qxZypb8F4Ay2E2FsOy4KsjacaghiyXGPwC8AMAOAGhShRtwNhwpu70jZRDJZ9WeT9eYtWiAgS1xZgMQlCn2WPKQc4Xvrc4jhlR-ffdmwXmmgmcfhQNi3qFJYeFClPd7Y8Ll16OqBoDljhoILKTXG8HSssS9TsQak7X1bP9GPigX_gLQJKAgxs8LAHv2GKrQ-cC-0yewkMB6Ug95wF68h0dDda5mJYC5LairHPh2O_vCUdO_Cu3E6s7Am_u4tp7nGe-78jHLui5r1yponlGGAJeL3LmbP-U9wHaAsC4LLWdrLf0zyDCvWhoF7u_SsUa4jABz6BPIH8sJ9GtzUQ4rk2W9AXWrCg7dzA2gFL0k6Ap4bm-CXPqXbwC04QRgBKCfWwagNIV5Pp5pWgstbclPeUqJOqpfVg7AYyfIIm9ZHSxVr6P1y7VDmgQjW0obU75tigDcgIXubwA4x2jYh5qNBVl2K-8N8HaYo31tkafa88e6RlZoDrbzCEjPTwDdXIRHhO14ga56dQRIVfel3qg1KH8VWi0EqLPeAqcDTGMNULMIcwh22jhDw19hwBM-YZ5At1-Zm-A7QnWVTGnKYoCDekugCqDyS_gy8F_paCtZoVeYdaH8Pe7vWZAVbWb9CDD3gkAAnDspxroBXhmjatueWBjakSWcT3BjeamPhj6-LCipAVj3rTPiBKBhr329DYv0fxDYTAg47at6Bif4kAiAJ29ZsY30tAV194JWcmJyjhteGaFg6u0PBsTv5yqFST8tfVrRynCw8Q9iPKcSpqZvrgAAAABJRU5ErkJggg==',
  clients: 'iVBORw0KGgoAAAANSUhEUgAAAKAAAAAoCAMAAABO8gGqAAADAFBMVEXrqW3mlVzgh0egpKCgfW08oZiyY1GGV2RkVWA1VnGvJit5Kz9aKzw6NkQ_KDY6GTEiKDshFCQcChwPBg4FAgUCAAIAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAVbbBAAAAGXRSTlP_______________________________8AATQKtwAABqlJREFUeNqFmYF6qyAMhQUdYIFAtK59_ye9J9i1XQm73O_bdmfV3xOSnLjp_mtt9_Eiovt_VsH680Ms6z8XKL9-M73_JwWHNTh3mec5_c3nfeWaxh_i603WdYSY4qWtWFTAaO00TcYaq90igG8JWN4PCGLyMSWuNRX9AyfecdxueqAeeBcHRAXQG2uXsK5fX-uqCxgEUpaKWGiP0fuQc06s831Tov1229OuEUYBLA8NYw9oLejAJ4S1v_0y_-A1xD68VCky5N02it7FPr63azTThD20TI61-DYFf2TsAJO16xrwgZRS7BUqPr8Dzv3lc_Y-ctz3Kyef-ifYbmyNMbKLzNTz3y_xGWL3FuQnoLM24dckKq419zmcJUvmBWte_By6J2BChDcvaVYQagVw92ATRmP6wyWmQicf7nK5JA2w1BZfWauSJSBzeP5lMWb5BCTeCQpKmiGMrCq4O4cis0xL4T6NUqp5zbmkc1HlDtBxhXa1xBiJK2lp7M2pgTEfEiePAHt207nS7pISYuNwazc5bQ9BnZprg8wZmy1_AkY6rpFve3QOfFqdQXDdIvJBwOUTMDD2XTQ-LBDQA6NDcGkzfmY_2akGBTByzlX-ycqhU7Bcj2hjoWic3g2kBBrjHDYSOD9jVK7Ft_3nJuNFqO58C0A3pQWAafEKYPkb0LviIABN1uQUtU4HLOsCLwZfuhvErUTssbABkLLWTUy84hieDs8wea0MpvoGmHtA58w8ZwAG5QFxARQwfCKJgGHqymBC7XPTTGBI3iu9JKUbmcltaCZRKzOogwVtKAthXjUFnT1TAN81QHzAPD6AH_oykc4CIqVYPV9aye6ZEX60krtWZ-IlMaOdYzc-8_wlRWLX8hPVdFJv4IMkqUW6A0RRICPH5QH0CEoef0M95KCh265aBTELsVWZ2NfB1kxEHdFn0O3TuYXwCcXy-FT81I4PHvB-vx3Xg1Fu9kMrEywF7nIioimrdku0sWYQIfEDjyqo-p1UykPDwfm5Nitz3L4PxQqlVPby7MdJ9YNli6LPyNBR3tlLmP1A4Vi8RSYNzkeXqsft-P4-bllLEdiMbSulIRbVsCKBpIvsg9sHTxAJO4VYdc3R2Ut03tNlxIc-ysdx7LBMnVWADQgVCZJ5K7yzAphbH4YrWb-yugH9TCGFRJRJ0wh-FytKQ7aa_F_nEkeH1XuZEpaA-hfCW5X-DXieD7-wqoABjjAEDj4UfO-PO3su-a7k0Nf76iUE4LIErmioISy0UQcIvvVk_MqKYYWAODUvCYDZK4DRvpbrg1zk-usT8FODgkYngFuTYc577gBFuXqeXjUJyc-e0GNCWP0S-k2YoNzlh1AxvC79XF4AS_wY5i6IsKetLg0wbKEDRCfkxxNWVjsVMiR7MauYTorSSmN6AvaHpcvlV4xRrD9KYMGz846RDIAIVQ_oTHwCamYBxZk4IAc8rkR9KQEAWRSIlim9WRDA9Q1w6gGXsCNHRMIFCn52ErLTE3CN_SYvFj45t6kTUc5dLS4AeAqIXFYA_fqXggSwxieAS33u8ukFkPbHLl6T4gXcFAkX8I0xON8rGN8Ag3L-Hwq2JAmor23wxm2Ycg9I_AJMGmBOEmDMTUgX1yv4BuiWvlXDyL6y2BnqXopkFk8Nv4WfjvrZi9Fl_V5Ps1jJaSFyeMgZiDMKTnbU78E3BZ0CiE1aH4tjn-j49cY_6_p8gzM9jYqxsIsyNa219IBiZAiDUZva_Zw_swRG1b1KYeyzTMYFXs9OstZ-k6LR8tYkRLurPSAaQeR2bu2q1E8WF5ncZCyG8Y798fQqM5rlxyjZmqlQaq2K6raLn74CEK6kt1vw29LMt6y-msEFUAiDxBcaxjJ6tSZ-pAzeXsnUndvsnQdvvzBxUmGMnqy7GQhY5NWCbgblvZYMrS2XVQCEhzBS1zL0Wyvfh81eLpBrKRu-6u8H5Z3HnRUv9NNOpQi2FVTLJwFqXwd2Ul6qcJNhcAMAQjr-dQUFcKBgG2sIM3Mavf_DYEsCOHjHKlfOEujRDXhrr183fFcBTzQ5f3CH0sY9b0cjSwm5jXeDw_kERCYGGkwUORcx7lkHzA1QrhIGMWrTUFFHpuYX2jztpoHlx949AXNYBoBEAkgDwAo_Jhshw5kNFIrcSj6SRTuMJOI7w9V4r549N6eM66_zHNSZJzwUzIEUQJSPLMZUap3-hp5ke0kZKVoUyTtMU9x2qSYgrr-20cYHrwOmJIDMpSnZASbKf_-d4e-_IPxvEb3dVo-QdoN_HyHC8ekWXscAAAAASUVORK5CYII=',
  hud: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAQCAMAAABA3o1rAAADAFBMVEX24m_1vSDzshTnoiHomAnCbyxQNRpsDUofDSL-Acz_AM_8AcfJBIIQAg8BAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABuMMe2AAAAEXRSTlP_____________________ACWtmWIAAAC3SURBVHjahZFBDsMgDAQNMZgAlfj_a7teCEHqoSsBhxnZwpbxJ4JTPmW8D5ORLRQzK_txmgQJiY4A3HJ3K9Zq62XyS5EABQJ5q72D08gSwNy43JiCp_oFIYmiQUQ0KAWSGVTIqD95VI0pC3svXCmge5zxEhB6ewsYhXgK4zVa7zZ-hW2QnwI-kjInSWNyGOHSxfmLsYyHY05ucFKaluDGw2k4huSznoIb56aSd3h2sYxy7jjnvc4vD9cSJXnNekoAAAAASUVORK5CYII=',
};

/** Textura CRT mínima (línea de escaneo 1x2) generada por código. */
function makeScanTexture(scene) {
  const g = scene.add.graphics();
  g.fillStyle(0x000000, 1);
  g.fillRect(0, 1, 1, 1);
  g.generateTexture('scan', 1, 2);
  g.destroy();
}

// Iconos de la tienda de mejoras (mapas de píxeles diminutos, misma paleta).
const ICON_SPRITES = {
  ic_bulb: { // bombilla: pistas
    pal: { K: 0x160a24, H: 0xffe600, W: 0xfffbe0, M: 0x7a7a9a, S: 0x4a4a5e },
    px: [
      '....KKKK....',
      '...KHHHHK...',
      '..KHWHWHHK..',
      '..KHHHHHHK..',
      '..KHWHHWHK..',
      '..KHHHHHHK..',
      '...KHHHHK...',
      '...KMMMMK...',
      '....KSSK....',
      '....KSSK....',
      '....KKKK....',
    ],
  },
  ic_calc: { // calculadora
    pal: { K: 0x160a24, B: 0x2b3a5f, D: 0x0b0b0f, G: 0x00ff88, O: 0xffe600, C: 0x00f5ff },
    px: [
      '..KKKKKKKK..',
      '.KBBBBBBBBK.',
      '.KBDDDDDDBK.',
      '.KBDGGGDBBK.',
      '.KBDDDDDDBK.',
      '.KBBBBBBBBK.',
      '.KBOBCBOCBK.',
      '.KBBBBBBBBK.',
      '.KBOBCBOCBK.',
      '.KBBBBBBBBK.',
      '..KKKKKKKK..',
    ],
  },
};

/** Rasteriza los iconos de la tienda a texturas de Phaser. */
function makeIconTextures(scene) {
  for (const [key, def] of Object.entries(ICON_SPRITES)) {
    const g = scene.add.graphics();
    const rows = def.px;
    const w = Math.max(...rows.map((r) => r.length));
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < rows[y].length; x++) {
        const c = def.pal[rows[y][x]];
        if (c === undefined) continue;
        g.fillStyle(c, 1);
        g.fillRect(x, y, 1, 1);
      }
    }
    g.generateTexture(key, w, rows.length);
    g.destroy();
  }
}

/** Botones del punto de venta estilo SNES: cuerpo con gradiente, bisel de luz/
 * sombra, anillo del color del pad y botón circular con brillo especular. */
function makeButtonTextures(scene) {
  const W = 240, H = 62;
  for (let i = 0; i < 4; i++) {
    const pad = PAD_COLORS[i];
    const g = scene.add.graphics();
    g.fillGradientStyle(0x2a1a48, 0x2a1a48, 0x120822, 0x120822, 1);
    g.fillRoundedRect(0, 0, W, H, 14);
    g.lineStyle(2, 0xffffff, 0.22); // bisel superior (luz)
    g.lineBetween(16, 4, W - 16, 4);
    g.lineStyle(2, 0x000000, 0.45); // bisel inferior (sombra)
    g.lineBetween(16, H - 4, W - 16, H - 4);
    g.lineStyle(3, pad, 1); // anillo color pad
    g.strokeRoundedRect(2, 2, W - 4, H - 4, 13);
    // Botón circular del pad: capas sólidas (base oscura + cara clara +
    // especular) para un look plástico SNES sin depender de gradientes.
    g.fillStyle(shadeColor(pad, 0.45), 1);
    g.fillCircle(26, H / 2 + 2, 13);
    g.fillStyle(shadeColor(pad, 1.3), 1);
    g.fillCircle(26, H / 2 - 1, 11);
    g.fillStyle(shadeColor(pad, 0.8), 1);
    g.fillCircle(26, H / 2 + 3, 7);
    g.fillStyle(0xffffff, 0.6); // especular
    g.fillCircle(22, H / 2 - 6, 4);
    g.generateTexture('btnN' + i, W, H);
    g.destroy();
  }
  const g = scene.add.graphics(); // opción eliminada por pista: apagada
  g.fillGradientStyle(0x1c1830, 0x1c1830, 0x0e0b18, 0x0e0b18, 1);
  g.fillRoundedRect(0, 0, W, H, 14);
  g.lineStyle(3, 0x3a3450, 1);
  g.strokeRoundedRect(2, 2, W - 4, H - 4, 13);
  g.generateTexture('btnX', W, H);
  g.destroy();
}

/** Precarga los assets embebidos (el loader de Phaser acepta data URIs). */
function preload() {
  // Los payloads usan base64 URL-safe (sin '/') para cumplir la regla del
  // arcade que prohíbe '//' en el código fuente; aquí se restauran.
  const uri = (s) => 'data:image/png;base64,' + s.replace(/-/g, '+').replace(/_/g, '/');
  this.load.image('bg', uri(ASSETS.bg));
  this.load.spritesheet('products', uri(ASSETS.products), { frameWidth: 24, frameHeight: 24 });
  this.load.spritesheet('clients', uri(ASSETS.clients), { frameWidth: 32, frameHeight: 40 });
  this.load.spritesheet('hud', uri(ASSETS.hud), { frameWidth: 16, frameHeight: 16 });
}

// ══ 8. ESCENA PRINCIPAL Y GAME LOOP ═════════════════════════════════════════

function makeText(scene, x, y, size, color, dark) {
  const t = scene.add.text(x, y, '', {
    fontFamily: 'monospace', fontSize: size + 'px', fontStyle: 'bold',
    color, lineSpacing: 3,
  });
  // Textos claros sobre el arte llevan contorno oscuro (legibilidad);
  // los de tinta oscura van sobre cartón/papel y no lo necesitan.
  if (!dark) t.setStroke(COLORS.ink, size >= 18 ? 5 : 3);
  return t;
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
    scene: { preload, create, update },
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
    calcReady: false, // la calculadora tiene pilas para este cliente
    calcFull: '', // cuenta completa que el LCD debe tipear ('' = sin usar)
    calcLen: 0,
    calcTick: 0,
    perks: { hints: 0, calcLevel: 0 },
    sel: 0,
    shopSel: 0,
    patienceLeft: 0,
    dayCoins: 0, // monedas ganadas en el día (para el resumen del cierre)
    feedbackUntil: 0,
    feedbackOk: false,
    feedbackMsg: '',
    cheat: false, // Konami: dinero y vidas infinitas
  };

  makeScanTexture(scene);
  makeIconTextures(scene);
  makeButtonTextures(scene);

  // ── Fondo: interior de la bodega (pixel art embebido, escala x4) ──
  scene.add.image(GAME_WIDTH / 2, GAME_HEIGHT / 2, 'bg').setScale(4);
  // Resplandor pulsante de la nevera de malta (vida neón sobre el arte).
  const fridgeGlow = scene.add.rectangle(222, 392, 125, 215, COLORS.counterTrim, 0.08);
  scene.tweens.add({
    targets: fridgeGlow, alpha: 0.18, duration: 1400,
    yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
  });
  // cartel de cartón con las tasas (izquierda, sobre la ventana)
  scene.add.rectangle(160, 130, 270, 150, COLORS.cardboard)
    .setStrokeStyle(4, COLORS.cardboardDark);
  scene.add.rectangle(160, 62, 14, 14, 0x8a8a8a); // tachuela

  // ── Zona central: mostrador translúcido con filo neón cian ──
  scene.add.rectangle(GAME_WIDTH / 2, 360, GAME_WIDTH, 120, COLORS.counter, 0.88);
  scene.add.rectangle(GAME_WIDTH / 2, 301, GAME_WIDTH, 3, COLORS.counterTrim);

  // ── Zona inferior: caja registradora + panel del punto de venta ──
  scene.add.rectangle(GAME_WIDTH / 2, 510, GAME_WIDTH, 180, COLORS.panel, 0.93)
    .setStrokeStyle(4, COLORS.panelEdge);
  buildRegister(scene);

  // HUD: corazones + monedas + marcador
  scene.ui = {
    hearts: [],
    coinIcon: scene.add.image(148, 18, 'hud', 1).setScale(2),
    coinText: makeText(scene, 166, 10, 17, COLORS.accent),
    hud: makeText(scene, 300, 12, 16, COLORS.white),
    perkHud: makeText(scene, 30, 220, 13, COLORS.accent),
    ratesTitle: makeText(scene, 42, 74, 15, COLORS.cardboardInk, true),
    rates: makeText(scene, 42, 100, 17, COLORS.cardboardInk, true),
    patienceBg: scene.add.rectangle(672, 152, 230, 12, 0x241a34),
    patienceBar: scene.add.rectangle(557, 152, 230, 12, COLORS.patience).setOrigin(0, 0.5),
    ticket: scene.add.rectangle(558, 348, 152, 140, 0xf8f4e8).setStrokeStyle(2, 0x999080),
    ticketText: makeText(scene, 490, 288, 12, '#241a10', true),
    ticketTotal: makeText(scene, 494, 380, 14, '#111111', true),
    bubble: scene.add.rectangle(672, 92, 230, 64, 0xffffff).setStrokeStyle(3, 0x222222),
    bubbleTail: scene.add.triangle(552, 100, 0, 0, 0, 22, 20, 12, 0xffffff),
    bubbleText: makeText(scene, 565, 66, 13, '#1a1408', true),
    feedback: makeText(scene, 400, 330, 22, COLORS.good).setOrigin(0.5),
    buttons: [],
  };
  for (let i = 0; i < MAX_HEARTS; i++) {
    scene.ui.hearts.push(scene.add.image(24 + i * 38, 18, 'hud', 0).setScale(2));
  }
  scene.ui.patienceBg.setOrigin(0.5);

  for (let i = 0; i < 4; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 382 + col * 256; // 262–502 y 518–758: dentro de los 800px
    const y = 466 + row * 80;
    const rect = scene.add.image(x, y, 'btnN' + i)
      .setInteractive({ useHandCursor: true });
    const label = makeText(scene, x + 12, y, 15, COLORS.white).setOrigin(0.5);
    rect.on('pointerdown', () => selectOption(scene, i));
    scene.ui.buttons.push({ rect, label });
  }

  // Cursor de selección estilo menú SNES (triángulo amarillo parpadeante).
  scene.ui.cursor = scene.add.triangle(0, 0, 0, 0, 0, 18, 16, 9, COLORS.buttonHot);

  // Calculadora de escritorio (perk): cuerpo biselado sobre el mostrador,
  // LCD que tipea la cuenta y tecla "=" roja. Clic en ella = P1_3.
  const cg = scene.add.graphics();
  cg.fillGradientStyle(0x3b2b5e, 0x3b2b5e, 0x180e2e, 0x180e2e, 1);
  cg.fillRoundedRect(648, 318, 148, 94, 10);
  cg.lineStyle(3, 0x7b2cff, 1);
  cg.strokeRoundedRect(648, 318, 148, 94, 10);
  cg.lineStyle(2, 0xffffff, 0.22);
  cg.lineBetween(660, 324, 784, 324);
  cg.fillStyle(0x06120a, 1); // LCD empotrado
  cg.fillRoundedRect(658, 330, 128, 44, 5);
  cg.lineStyle(2, 0x000000, 0.6);
  cg.lineBetween(662, 334, 782, 334);
  cg.lineStyle(2, 0x574a7a, 0.8);
  cg.lineBetween(662, 372, 782, 372);
  for (let k = 0; k < 2; k++) { // teclas grises
    cg.fillGradientStyle(0x5a4a8a, 0x5a4a8a, 0x2c1e4a, 0x2c1e4a, 1);
    cg.fillRoundedRect(660 + k * 44, 384, 36, 18, 4);
  }
  cg.fillGradientStyle(0xe4405f, 0xe4405f, 0x7a1a30, 0x7a1a30, 1); // tecla =
  cg.fillRoundedRect(748, 384, 36, 18, 4);
  scene.ui.calcG = cg;
  scene.ui.calcLcd = makeText(scene, 664, 336, 12, '#00ff88', true);
  scene.ui.calcEq = makeText(scene, 766, 393, 12, COLORS.white).setOrigin(0.5);
  scene.ui.calcEq.setText('=');
  scene.ui.calcZone = scene.add.zone(722, 365, 148, 94).setInteractive({ useHandCursor: true });
  scene.ui.calcZone.on('pointerdown', () => useCalc(scene));

  scene.ui.centerBg = scene.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, 660, 390, COLORS.panel, 0.92)
    .setStrokeStyle(4, COLORS.panelEdge);
  scene.ui.center = makeText(scene, GAME_WIDTH / 2, GAME_HEIGHT / 2, 18, COLORS.white)
    .setOrigin(0.5).setAlign('center')
    .setInteractive({ useHandCursor: true });
  scene.ui.center.on('pointerdown', () => {
    const s = scene.state;
    if (s.phase === 'start' || s.phase === 'gameover') {
      setCenterVisible(scene, false);
      startGame(scene);
    }
  });

  // Tienda entre días: tarjetas con icono, precio y animaciones de entrada.
  scene.ui.shop = {
    bg: scene.add.rectangle(400, 310, 780, 540, 0x0b0b0f, 0.94)
      .setStrokeStyle(4, COLORS.panelEdge),
    title: makeText(scene, 400, 82, 26, COLORS.accent).setOrigin(0.5),
    congrats: makeText(scene, 400, 118, 15, COLORS.good).setOrigin(0.5),
    stats: makeText(scene, 400, 152, 15, COLORS.white).setOrigin(0.5),
    rows: [],
    help: makeText(scene, 400, 418, 13, COLORS.dim).setOrigin(0.5).setAlign('center'),
    nextRect: scene.add.rectangle(400, 492, 340, 62, COLORS.button)
      .setStrokeStyle(4, COLORS.buttonHot)
      .setInteractive({ useHandCursor: true }),
    next: makeText(scene, 400, 492, 19, COLORS.accent).setOrigin(0.5),
  };
  const rowIcons = ['ic_bulb', 'ic_calc', 'hud'];
  for (let i = 0; i < 3; i++) {
    const y = 215 + i * 75;
    const card = scene.add.rectangle(400, y, 620, 64, COLORS.button)
      .setStrokeStyle(3, COLORS.panelEdge)
      .setInteractive({ useHandCursor: true });
    const icon = rowIcons[i] === 'hud'
      ? scene.add.image(130, y, 'hud', 0).setScale(2)
      : scene.add.image(130, y, rowIcons[i]).setScale(3);
    const label = makeText(scene, 168, y, 15, COLORS.white).setOrigin(0, 0.5);
    const price = makeText(scene, 682, y, 15, COLORS.accent).setOrigin(1, 0.5);
    const row = { card, icon, label, price };
    card.on('pointerdown', () => {
      const s = scene.state;
      if (s.phase !== 'shop') return;
      s.shopSel = i;
      buyRow(scene, i);
    });
    scene.ui.shop.rows.push(row);
  }
  // Pulso permanente del botón CONTINUAR (llamada a la acción).
  scene.tweens.add({
    targets: scene.ui.shop.nextRect, scaleX: 1.04, scaleY: 1.08,
    duration: 600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
  });
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

/** Caja registradora estilo SNES (decorativa, zona inferior izquierda). */
function buildRegister(scene) {
  const g = scene.add.graphics();
  // Cuerpo biselado con gradiente vertical.
  g.fillGradientStyle(0x3b2b5e, 0x3b2b5e, 0x180e2e, 0x180e2e, 1);
  g.fillRoundedRect(44, 442, 190, 138, 12);
  g.lineStyle(3, 0x7b2cff, 1);
  g.strokeRoundedRect(44, 442, 190, 138, 12);
  g.lineStyle(2, 0xffffff, 0.22); // bisel superior
  g.lineBetween(58, 448, 220, 448);
  // Visor LCD empotrado (sombra arriba, luz abajo).
  g.fillStyle(0x06120a, 1);
  g.fillRoundedRect(62, 456, 154, 32, 6);
  g.lineStyle(2, 0x000000, 0.6);
  g.lineBetween(66, 460, 212, 460);
  g.lineStyle(2, 0x574a7a, 0.8);
  g.lineBetween(66, 486, 212, 486);
  // Teclas biseladas 4x3.
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      const kx = 62 + c * 40, ky = 498 + r * 24;
      g.fillGradientStyle(0x5a4a8a, 0x5a4a8a, 0x2c1e4a, 0x2c1e4a, 1);
      g.fillRoundedRect(kx, ky, 32, 18, 4);
      g.lineStyle(1, 0xffffff, 0.3);
      g.lineBetween(kx + 4, ky + 2, kx + 28, ky + 2);
    }
  }
  // Gaveta de dinero.
  g.fillGradientStyle(0x241838, 0x241838, 0x0e0818, 0x0e0818, 1);
  g.fillRoundedRect(56, 568, 166, 10, 4);
  g.lineStyle(1, 0x7b2cff, 0.6);
  g.lineBetween(64, 573, 214, 573);
  scene.add.text(139, 472, 'BODEGA', {
    fontFamily: 'monospace', fontSize: '15px', fontStyle: 'bold', color: '#00ff88',
  }).setOrigin(0.5);
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
  for (const row of shop.rows) {
    row.card.setVisible(visible);
    row.icon.setVisible(visible);
    row.label.setVisible(visible);
    row.price.setVisible(visible);
  }
}

/** Intenta comprar la fila i: flash verde si aplica, rojo si no alcanza. */
function buyRow(scene, i) {
  const s = scene.state;
  const ok = buyShopItem(s, getShopItems(s.perks, s.hearts)[i]);
  renderShop(scene);
  const row = scene.ui.shop.rows[i];
  if (ok) playBuySound(scene);
  row.card.setFillStyle(ok ? 0x1f6a42 : 0x6a1f2e);
  scene.tweens.add({ targets: row.icon, scale: row.icon.scaleX * 1.3, duration: 110, yoyo: true });
  scene.time.delayedCall(200, () => {
    if (scene.state.phase === 'shop') renderShop(scene);
  });
}

function setPlayUiVisible(scene, visible) {
  scene.ui.patienceBar.setVisible(visible);
  scene.ui.patienceBg.setVisible(visible);
  scene.ui.cursor.setVisible(visible);
  // La calculadora solo existe en pantalla si el jugador la compró.
  const calc = visible && scene.state.perks.calcLevel > 0;
  scene.ui.calcG.setVisible(calc);
  scene.ui.calcLcd.setVisible(calc);
  scene.ui.calcEq.setVisible(calc);
  scene.ui.calcZone.setVisible(calc);
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
    scene.tweens.killTweensOf(scene.clientSprite);
    scene.clientSprite.destroy();
    scene.clientSprite = null;
  }
  for (const spr of scene.productSprites) {
    scene.tweens.killTweensOf(spr);
    spr.destroy();
  }
  scene.productSprites = [];
}

/** Muestra/oculta el texto central junto a su panel de fondo (legibilidad). */
function setCenterVisible(scene, visible) {
  scene.ui.center.setVisible(visible);
  scene.ui.centerBg.setVisible(visible);
}

function showStartScreen(scene) {
  scene.state.phase = 'start';
  setShopVisible(scene, false);
  setPlayUiVisible(scene, false);
  clearClientVisuals(scene);
  setClientUiVisible(scene, false);
  setCenterVisible(scene, true);
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
  setCenterVisible(scene, false);
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
  // La calculadora decide al llegar el cliente si tiene pilas hoy.
  s.calcReady = s.perks.calcLevel > 0 && Math.random() < CALC_PROBS[s.perks.calcLevel];
  s.calcFull = '';
  s.calcLen = 0;
  s.calcTick = 0;
  s.sel = 0;
  s.patienceLeft = s.client.patienceMs;
  s.phase = 'play';

  // El cliente entra caminando desde la derecha (atlas de clientes 32x40).
  clearClientVisuals(scene);
  const lookFrame = CLIENT_LOOKS.indexOf(s.client.look);
  scene.clientSprite = scene.add.image(880, 300, 'clients', lookFrame)
    .setScale(3).setOrigin(0.5, 1);
  scene.tweens.add({
    targets: scene.clientSprite, x: 470, duration: 450, ease: 'Quad.easeOut',
    onComplete: () => {
      // Idle: balanceo sutil (bob) una vez que llega al mostrador.
      if (scene.clientSprite) {
        scene.tweens.add({
          targets: scene.clientSprite, y: 294, duration: 700,
          yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
        });
      }
    },
  });
  // Los productos caen al mostrador uno a uno (atlas 24x24, frame = índice).
  const count = s.client.items.length;
  const gap = Math.min(85, 400 / Math.max(1, count - 1));
  s.client.items.forEach((p, i) => {
    const spr = scene.add.image(90 + i * gap, 240, 'products', PRODUCTS.indexOf(p))
      .setScale(3).setOrigin(0.5, 1);
    scene.tweens.add({
      targets: spr, y: 392, duration: 220, delay: 250 + i * 150, ease: 'Bounce.easeOut',
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
  setCenterVisible(scene, false);
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
  // Entrada animada: el panel rebota y las tarjetas caen en cascada.
  const shop = scene.ui.shop;
  shop.bg.setScale(0.92).setAlpha(0);
  scene.tweens.add({
    targets: shop.bg, scaleX: 1, scaleY: 1, alpha: 1, duration: 260, ease: 'Back.easeOut',
  });
  shop.title.setScale(1.5).setAlpha(0);
  scene.tweens.add({
    targets: shop.title, scaleX: 1, scaleY: 1, alpha: 1,
    duration: 300, delay: 100, ease: 'Back.easeOut',
  });
  shop.rows.forEach((row, i) => {
    const parts = [row.card, row.icon, row.label, row.price];
    for (const p of parts) {
      p.setAlpha(0);
      p.y -= 18;
    }
    scene.tweens.add({
      targets: parts, alpha: 1, y: '+=18',
      duration: 260, delay: 150 + i * 110, ease: 'Quad.easeOut',
    });
  });
  renderShop(scene);
}

function renderShop(scene) {
  const s = scene.state;
  const items = getShopItems(s.perks, s.hearts);
  scene.ui.coinText.setText('$' + s.coins); // el HUD refleja la compra al instante
  scene.ui.shop.title.setText('DIA ' + s.day + ' COMPLETADO!');
  scene.ui.shop.stats.setText(
    'Clientes atendidos: ' + s.level.clients +
    '   Ganado hoy: +$' + s.dayCoins +
    '   Dolares: $' + s.coins
  );
  items.forEach((item, i) => {
    const row = scene.ui.shop.rows[i];
    const selected = i === s.shopSel;
    const affordable = !item.disabled && s.coins >= item.price;
    row.label.setText(item.label);
    let tag = '$' + item.price;
    if (item.disabled) tag = item.id === 'calc' ? 'MAX' : '--';
    else if (!affordable) tag = '$' + item.price + ' (no alcanza)';
    row.price.setText(tag);
    row.label.setColor(affordable ? COLORS.white : COLORS.dim);
    row.price.setColor(affordable ? COLORS.accent : COLORS.dim);
    row.icon.setAlpha(affordable ? 1 : 0.45);
    row.card.setFillStyle(selected ? COLORS.counter : COLORS.button);
    row.card.setStrokeStyle(selected ? 4 : 3, selected ? COLORS.buttonHot : COLORS.panelEdge);
  });
  scene.ui.shop.help.setText('Joystick: elegir   P1_1: comprar   (o clic en la tarjeta)');
  scene.ui.shop.next.setText('CONTINUAR AL DIA ' + (s.day + 1));
}

function advanceDay(scene) {
  const s = scene.state;
  s.day += 1;
  s.served = 0;
  s.dayCoins = 0;
  s.level = getLevel(s.day);
  s.rates = genRates(s.level);
  setCenterVisible(scene, false);
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

/** Dispara la calculadora (P1_3 o clic): el LCD tipea la cuenta del cliente. */
function useCalc(scene) {
  const s = scene.state;
  if (s.phase !== 'play' || s.perks.calcLevel <= 0 || s.calcFull) return;
  if (s.calcReady) {
    const rate = fmtBs(s.rates[s.client.method.rateKey]);
    const igtf = s.level.igtfEnabled && s.client.method.igtf;
    // Con el total oculto la calculadora tampoco lo revela: da solo el Bs.
    const total = s.level.hideTotal ? '?' : '$' + s.totalUSD.toFixed(2);
    s.calcFull = total + 'x' + rate + (igtf ? '*1.03' : '') +
      '\n=Bs.' + fmtBs(s.options[s.correctIndex]);
  } else {
    s.calcFull = 'ERROR 0x28\nSIN PILAS';
  }
  s.calcLen = 0;
  s.calcTick = 0;
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
  scene.ui.cursor.setVisible(false);
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
  scene.ui.cursor.setVisible(false);
  refreshUi(scene);
}

function refreshUi(scene) {
  const s = scene.state;
  // HUD: corazones pixelados, monedas y marcador.
  for (let i = 0; i < MAX_HEARTS; i++) {
    scene.ui.hearts[i].setTint(i < s.hearts ? 0xffffff : 0x2a2038);
  }
  scene.ui.coinText.setText('$' + s.coins);
  scene.ui.hud.setText('DIA ' + s.day + '   Pts ' + s.score + '   Racha x' + s.streak + (s.cheat ? '   TRUCO' : ''));
  // Perks en el HUD: solo se muestran si el jugador los posee.
  const perkParts = [];
  if (s.perks.hints > 0) perkParts.push('PISTAS:' + s.perks.hints + ' (P1_2)');
  if (s.perks.calcLevel > 0) perkParts.push('CALC ' + Math.round(CALC_PROBS[s.perks.calcLevel] * 100) + '% (P1_3)');
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
    scene.ui.ticketTotal.setText(s.level.hideTotal ? 'TOTAL $ ?.??' : 'TOTAL $' + s.totalUSD.toFixed(2));
    // El total se ancla justo debajo de la lista de items (1 a 6 renglones).
    scene.ui.ticketTotal.y = scene.ui.ticketText.y + scene.ui.ticketText.height + 8;
    for (let i = 0; i < 4; i++) {
      const btn = scene.ui.buttons[i];
      if (s.eliminated[i]) {
        btn.label.setText('—');
        btn.label.setColor(COLORS.dim);
        btn.rect.setTexture('btnX');
      } else {
        btn.label.setText('Bs. ' + fmtBs(s.options[i]));
        btn.label.setColor(COLORS.white);
        btn.rect.setTexture('btnN' + i);
      }
    }
    // LCD en reposo: invita a usar P1_3 o avisa que no hay pilas hoy.
    if (s.perks.calcLevel > 0 && !s.calcFull) {
      scene.ui.calcLcd.setText(s.calcReady ? 'P1_3: CALCULAR' : 'SIN PILAS :(');
    }
  }
}

function update(time, delta) {
  const scene = this;
  const s = scene.state;
  if (!s) return;
  updateGame(scene, s, delta, time);
  // El soundtrack del día solo avanza en fases de atención (play/feedback).
  tickMusic(scene);
  // Los flancos no consumidos mueren al terminar el frame: sin inputs fantasma.
  clearStalePresses();
}

function updateGame(scene, s, delta, time) {
  // Konami: alterna el truco; mientras está activo, vidas y dinero no bajan.
  if (konamiPending) {
    konamiPending = false;
    s.cheat = !s.cheat;
    if (s.cheat) { s.coins = 9999; s.hearts = MAX_HEARTS; }
    playGoodSound(scene);
    refreshUi(scene);
  }
  if (s.cheat) {
    s.hearts = MAX_HEARTS;
    if (s.coins < 9999) s.coins = 9999;
  }
  if (s.phase === 'start') {
    if (consumePressed('START1') || consumePressed('P1_1')) startGame(scene);
    return;
  }

  if (s.phase === 'gameover') {
    setPlayUiVisible(scene, false);
    setClientUiVisible(scene, false);
    clearClientVisuals(scene);
    setCenterVisible(scene, true);
    scene.ui.center.setText(
      'CERRO LA BODEGA\n\nLlegaste al dia ' + s.day +
      '\nPuntaje: ' + s.score + '   Dolares: $' + s.coins +
      '\n\n[ START1 o CLIC para reabrir ]'
    );
    if (consumePressed('START1') || consumePressed('P1_1')) {
      setCenterVisible(scene, false);
      startGame(scene);
    }
    return;
  }

  if (s.phase === 'shop') {
    const items = getShopItems(s.perks, s.hearts);
    const prevSel = s.shopSel;
    if (consumePressed('P1_U')) s.shopSel = (s.shopSel + items.length - 1) % items.length;
    if (consumePressed('P1_D')) s.shopSel = (s.shopSel + 1) % items.length;
    if (s.shopSel !== prevSel) {
      // Rebote del icono al mover la selección.
      const row = scene.ui.shop.rows[s.shopSel];
      scene.tweens.add({ targets: row.icon, scale: row.icon.scaleX * 1.2, duration: 90, yoyo: true });
      renderShop(scene);
    }
    if (consumePressed('P1_1')) {
      buyRow(scene, s.shopSel);
      return;
    }
    if (consumePressed('START1') || consumePressed('P1_3')) {
      advanceDay(scene);
      return;
    }
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
  if (consumePressed('P1_3')) {
    useCalc(scene);
  }

  // Cursor de selección: sigue al botón activo y parpadea (menú SNES).
  const bx = 382 + (s.sel % 2) * 256;
  const by = 466 + Math.floor(s.sel / 2) * 80;
  scene.ui.cursor.setPosition(bx - 134, by);
  scene.ui.cursor.setVisible(!s.eliminated[s.sel]);
  scene.ui.cursor.setAlpha(0.55 + 0.45 * Math.sin(time / 150));

  // La calculadora tipea la cuenta caracter a caracter (con blips).
  if (s.calcFull && s.calcLen < s.calcFull.length) {
    s.calcTick += delta;
    while (s.calcTick >= 55 && s.calcLen < s.calcFull.length) {
      s.calcTick -= 55;
      s.calcLen++;
      if (scene.sound && scene.sound.context) {
        toneAt(scene, 1900, scene.sound.context.currentTime + 0.01, 0.03, 0.03);
      }
    }
  }
  if (s.calcFull && scene.ui.calcLcd.visible) {
    scene.ui.calcLcd.setText(
      s.calcFull.slice(0, s.calcLen) + (Math.floor(time / 300) % 2 ? '_' : '')
    );
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
