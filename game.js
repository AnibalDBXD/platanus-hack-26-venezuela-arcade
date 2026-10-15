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
//   6. Sprites procedurales (Fase 3)
//   7. Escena principal y game loop
// ─────────────────────────────────────────────────────────────────────────────

// ══ 1. CONSTANTES Y CONFIGURACIÓN ═══════════════════════════════════════════

const GAME_WIDTH = 800;
const GAME_HEIGHT = 600;
const STORAGE_KEY = 'bodega-tycoon-highscores';
const MAX_HIGH_SCORES = 5;
const MAX_HEARTS = 3;
const IGTF_RATE = 0.03;

const COLORS = {
  bg: 0x14100a,
  wall: 0x2a1f14,
  cardboard: 0xc9a35f,
  counter: 0x6b4a2a,
  counterTop: 0x8a6136,
  panel: 0x0d1b3e,
  panelEdge: 0x2b4a8f,
  button: 0x1c3a7a,
  buttonOff: 0x22262e,
  buttonHot: 0xe1ff00,
  white: '#f7ffd8',
  ink: '#1a1408',
  accent: '#e1ff00',
  good: '#7dff6a',
  bad: '#ff6a5e',
  dim: '#8a8a7a',
  patience: 0xe1ff00,
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
 * @typedef {{ name: string, items: Product[], method: PaymentMethod, patienceMs: number }} Client
 */

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
  return {
    name: pick(['Maria', 'Jose', 'Luis', 'Carmen', 'Pedro', 'Ana', 'Chamo', 'Yuleidis', 'Ramon', 'Ender']),
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

// ══ 7. ESCENA PRINCIPAL Y GAME LOOP ═════════════════════════════════════════
// (Fases 3–5: sprites pixel art, eventos especiales, audio y high scores.
//  Por ahora: esqueleto jugable basado en texto que valida el core loop.)

function makeText(scene, x, y, size, color) {
  return scene.add.text(x, y, '', { fontFamily: 'monospace', fontSize: size + 'px', color });
}

function boot() {
  const config = {
    type: Phaser.AUTO,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    parent: 'game-root',
    backgroundColor: '#14100a',
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
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
    feedbackUntil: 0,
    feedbackOk: false,
    feedbackMsg: '',
  };

  // Layout base (placeholder visual de la Fase 3).
  scene.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, COLORS.bg);
  scene.add.rectangle(GAME_WIDTH / 2, 130, GAME_WIDTH, 260, COLORS.wall);
  scene.add.rectangle(GAME_WIDTH / 2, 340, GAME_WIDTH, 160, COLORS.counterTop);
  scene.add.rectangle(GAME_WIDTH / 2, 510, GAME_WIDTH, 180, COLORS.panel)
    .setStrokeStyle(4, COLORS.panelEdge);

  scene.ui = {
    hud: makeText(scene, 20, 12, 16, COLORS.white),
    perkHud: makeText(scene, 20, 34, 13, COLORS.accent),
    ratesTitle: makeText(scene, 20, 62, 14, COLORS.accent),
    rates: makeText(scene, 20, 84, 14, COLORS.white),
    client: makeText(scene, 330, 62, 14, COLORS.white),
    items: makeText(scene, 330, 130, 13, COLORS.white),
    ticket: makeText(scene, 330, 240, 18, COLORS.accent),
    feedback: makeText(scene, 400, 300, 22, COLORS.good).setOrigin(0.5),
    patienceBg: scene.add.rectangle(560, 218, 300, 14, 0x333333),
    patienceBar: scene.add.rectangle(410, 218, 300, 14, COLORS.patience).setOrigin(0, 0.5),
    buttons: [],
  };
  scene.ui.patienceBg.setOrigin(0.5);

  for (let i = 0; i < 4; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 480 + col * 270;
    const y = 460 + row * 90;
    const rect = scene.add.rectangle(x, y, 250, 74, COLORS.button)
      .setStrokeStyle(3, COLORS.panelEdge)
      .setInteractive({ useHandCursor: true });
    const label = makeText(scene, x, y, 15, COLORS.white).setOrigin(0.5);
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

  // Tienda entre días: filas clickables (mouse/touch) además del joystick.
  scene.ui.shop = {
    title: makeText(scene, 400, 110, 22, COLORS.accent).setOrigin(0.5),
    coins: makeText(scene, 400, 150, 16, COLORS.white).setOrigin(0.5),
    rows: [],
    help: makeText(scene, 400, 420, 13, COLORS.dim).setOrigin(0.5).setAlign('center'),
    next: makeText(scene, 400, 480, 17, COLORS.accent).setOrigin(0.5)
      .setInteractive({ useHandCursor: true }),
  };
  for (let i = 0; i < 3; i++) {
    const row = makeText(scene, 400, 225 + i * 55, 16, COLORS.white)
      .setOrigin(0.5).setInteractive({ useHandCursor: true });
    row.on('pointerdown', () => {
      const s = scene.state;
      if (s.phase !== 'shop') return;
      s.shopSel = i;
      buyShopItem(s, getShopItems(s.perks, s.hearts)[i]);
      renderShop(scene);
    });
    scene.ui.shop.rows.push(row);
  }
  scene.ui.shop.next.on('pointerdown', () => {
    if (scene.state.phase === 'shop') advanceDay(scene);
  });
  setShopVisible(scene, false);

  showStartScreen(scene);
}

function setShopVisible(scene, visible) {
  const shop = scene.ui.shop;
  shop.title.setVisible(visible);
  shop.coins.setVisible(visible);
  shop.help.setVisible(visible);
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

function showStartScreen(scene) {
  scene.state.phase = 'start';
  setShopVisible(scene, false);
  setPlayUiVisible(scene, false);
  scene.ui.center.setVisible(true);
  scene.ui.center.setText(
    'A CUANTO EL DOLAR!\n(Bodega Tycoon)\n\n' +
    'Cobra en Bs. segun el metodo de pago.\n' +
    'Revisa la pizarra de tasas del dia.\n\n' +
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
  refreshUi(scene);
}

function openShop(scene) {
  const s = scene.state;
  s.phase = 'shop';
  s.shopSel = 0;
  scene.ui.center.setVisible(false);
  setPlayUiVisible(scene, false);
  setShopVisible(scene, true);
  renderShop(scene);
}

function renderShop(scene) {
  const s = scene.state;
  const items = getShopItems(s.perks, s.hearts);
  scene.ui.shop.title.setText('CIERRE DEL DIA ' + s.day);
  scene.ui.shop.coins.setText('Monedas: $' + s.coins);
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
  scene.ui.shop.next.setText('[ START1 o CLIC: abrir dia ' + (s.day + 1) + ' ]');
}

function advanceDay(scene) {
  const s = scene.state;
  s.day += 1;
  s.served = 0;
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
    s.score += 100 + s.streak * 25 + Math.round(s.patienceLeft / 500);
    s.feedbackOk = true;
    s.feedbackMsg = 'COBRADO! +$' + earned;
    s.served += 1;
  } else {
    s.streak = 0;
    s.hearts -= 1;
    s.feedbackOk = false;
    s.feedbackMsg = 'ERA Bs. ' + fmtBs(s.options[s.correctIndex]);
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
  s.phase = 'feedback';
  s.feedbackUntil = 1500;
  refreshUi(scene);
}

function refreshUi(scene) {
  const s = scene.state;
  scene.ui.hud.setText(
    'DIA ' + s.day + '  [' + '<3'.repeat(s.hearts) + ']  $' + s.coins +
    '  Pts ' + s.score + '  Racha x' + s.streak
  );
  const calcLabel = s.perks.calcLevel > 0
    ? 'CALC ' + Math.round(CALC_PROBS[s.perks.calcLevel] * 100) + '%'
    : 'sin calc';
  scene.ui.perkHud.setText('PISTAS:' + s.perks.hints + ' (P1_2)   ' + calcLabel);
  if (s.rates) {
    scene.ui.ratesTitle.setText('TASAS DEL DIA (Bs/$)');
    const lines = ['DOLAR  ' + fmtBs(s.rates.dolar)];
    if (s.level.euroEnabled) lines.push('EURO   ' + fmtBs(s.rates.euro));
    scene.ui.rates.setText(lines.join('\n'));
  }
  if (s.client && (s.phase === 'play' || s.phase === 'feedback')) {
    scene.ui.client.setText(
      s.client.name + ': "Me cobras por\n' + s.client.method.label + '"' +
      (s.level.igtfEnabled && s.client.method.igtf ? '  (+IGTF 3%)' : '')
    );
    scene.ui.items.setText(
      s.client.items.map((p) => p.name + '  $' + p.priceUSD.toFixed(2)).join('\n')
    );
    scene.ui.ticket.setText('TOTAL: $' + s.totalUSD.toFixed(2));
    for (let i = 0; i < 4; i++) {
      const btn = scene.ui.buttons[i];
      if (s.eliminated[i]) {
        btn.label.setText('—');
        btn.label.setColor(COLORS.dim);
        btn.rect.fillColor = COLORS.buttonOff;
      } else {
        let text = 'Bs. ' + fmtBs(s.options[i]);
        if (s.calcRevealed && i === s.correctIndex) text += '  <=CALC';
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
  updateGame(scene, s, delta);
  // Los flancos no consumidos mueren al terminar el frame: sin inputs fantasma.
  clearStalePresses();
}

function updateGame(scene, s, delta) {
  if (s.phase === 'start') {
    if (consumePressed('START1') || consumePressed('P1_1')) startGame(scene);
    return;
  }

  if (s.phase === 'gameover') {
    setPlayUiVisible(scene, false);
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
      buyShopItem(s, items[s.shopSel]);
    }
    if (consumePressed('START1')) {
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
  scene.ui.patienceBar.fillColor = frac > 0.5 ? COLORS.patience : (frac > 0.25 ? 0xffa500 : 0xff4444);

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
    scene.ui.buttons[i].rect.setStrokeStyle(hot ? 4 : 3, hot ? COLORS.buttonHot : COLORS.panelEdge);
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
