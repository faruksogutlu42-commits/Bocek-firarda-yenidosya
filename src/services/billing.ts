import { Capacitor } from '@capacitor/core';
import {
  NativePurchases,
  PURCHASE_TYPE,
  type Transaction,
} from '@capgo/native-purchases';

/**
 * Google Play Billing (Capacitor, @capgo/native-purchases).
 *
 * Kırıntı paketleri "consumable" ürünlerdir. Akış:
 *   1. Satın alma tamamlanır (otomatik onay kapalı).
 *   2. Oyun kırıntıyı verir (onPurchased dinleyicileri).
 *   3. Kırıntının kaydedilmesi için kısa bir süre beklenir, sonra satın alma
 *      "kırıntısı verildi" diye cihazda işaretlenir.
 *   4. Satın alma tüketilir (consume) → onaylanmış olur ve tekrar alınabilir.
 *      Token "tamamlandı" listesine taşınır; aynı satın alma bir daha gelirse
 *      (ör. kurtarma akışı ile buy() aynı anda yakalarsa) kırıntı tekrar verilmez.
 *
 * Uygulama 2 ile 4 arasında kapanırsa, açılışta ve uygulamaya geri dönüldüğünde
 * tüketilmemiş satın almalar bulunur ve tamamlanır. Kapanma 2 ile 3 arasında olursa
 * kırıntı ikinci kez verilebilir; bu bilerek seçildi: hata olursa oyuncu kaybetmesin.
 *
 * Bekleyen ödemeler (nakit/kod vb.): buy() 'pending' döner. Ödeme onaylanınca
 * kırıntı, uygulama açıkken periyodik kurtarma ile ya da geri dönüşte verilir.
 */

export const PRODUCTS = ['kirinti_1', 'kirinti_2', 'kirinti_3'];

export type BuyResult = 'purchased' | 'pending' | 'canceled' | 'recovered';

// Kırıntısı verilmiş ama henüz tüketilmemiş satın almalar
const GRANTED_TOKENS_KEY = 'bocek_firar_iap_granted_tokens';
const MAX_GRANTED_TOKENS = 50;
// Tüketilmiş (tamamen bitmiş) satın almalar: aynı token tekrar gelirse yok sayılır
const DONE_TOKENS_KEY = 'bocek_firar_iap_done_tokens';
const MAX_DONE_TOKENS = 200;
// Bekleyen ödeme varsa başladığı zaman (ms)
const PENDING_SINCE_KEY = 'bocek_firar_iap_pending_since';
// Google, onaylanmayan satın almaları 3 gün sonra iade eder; daha uzun beklemenin anlamı yok
const PENDING_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
let pendingPollMs = 30_000;

/**
 * Dinleyici kırıntıyı verir. Promise dönerse kayıt bitene kadar beklenir.
 * Hata fırlatırsa satın alma işaretlenmez ve tüketilmez; kurtarma akışı tekrar dener.
 */
type PurchaseListener = (id: string) => void | Promise<void>;

const listeners = new Set<PurchaseListener>();
const inFlightTokens = new Set<string>();
let recoveryPromise: Promise<void> | null = null;
let resumeHookInstalled = false;
let pendingPollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Oyun kırıntıyı React state güncellemesi içinde kaydediyor (App.tsx → persistSave),
 * yani dinleyici döndüğünde kayıt henüz yazılmamış olabilir. Token'ı işaretlemeden
 * önce bu kadar beklenir.
 */
let saveSettleMs = 300;

function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

function readTokens(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function writeTokens(key: string, tokens: string[], max: number): void {
  try {
    localStorage.setItem(key, JSON.stringify(tokens.slice(-max)));
  } catch {
    // Depolama hatası: en kötü ihtimalle kurtarma akışı tekrar dener
  }
}

function markGranted(token: string): void {
  const tokens = readTokens(GRANTED_TOKENS_KEY);
  if (!tokens.includes(token)) writeTokens(GRANTED_TOKENS_KEY, [...tokens, token], MAX_GRANTED_TOKENS);
}

function markDone(token: string): void {
  const done = readTokens(DONE_TOKENS_KEY);
  if (!done.includes(token)) writeTokens(DONE_TOKENS_KEY, [...done, token], MAX_DONE_TOKENS);
  writeTokens(
    GRANTED_TOKENS_KEY,
    readTokens(GRANTED_TOKENS_KEY).filter((t) => t !== token),
    MAX_GRANTED_TOKENS,
  );
}

function readPendingSince(): number | null {
  try {
    const v = Number(localStorage.getItem(PENDING_SINCE_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function setPendingSince(ms: number | null): void {
  try {
    if (ms === null) localStorage.removeItem(PENDING_SINCE_KEY);
    else localStorage.setItem(PENDING_SINCE_KEY, String(ms));
  } catch {
    // yok say
  }
}

function hasActivePending(): boolean {
  const since = readPendingSince();
  if (since === null) return false;
  if (Date.now() - since > PENDING_MAX_AGE_MS) {
    setPendingSince(null);
    return false;
  }
  return true;
}

function stopPendingPoll(): void {
  if (pendingPollTimer !== null) {
    clearInterval(pendingPollTimer);
    pendingPollTimer = null;
  }
}

/** Bekleyen ödeme varken uygulama açıkken düzenli aralıkla kurtarma dener. */
function startPendingPoll(): void {
  if (pendingPollTimer !== null || !hasActivePending()) return;
  pendingPollTimer = setInterval(() => {
    if (!hasActivePending() || listeners.size === 0) {
      stopPendingPoll();
      return;
    }
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      void recoverUnfinishedPurchases();
    }
  }, pendingPollMs);
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    if (typeof e.code === 'string') return e.code;
    if (typeof e.message === 'string') return e.message;
  }
  return String(err);
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Kırıntıyı verir (bir kez) ve satın almayı tüketir.
 * Dinleyici yoksa (oyun henüz hazır değilse) hiçbir şey yapmaz; kurtarma akışı sonra dener.
 * Bu çağrıda kırıntı verildiyse true döner.
 */
async function deliverAndConsume(tx: Transaction): Promise<boolean> {
  const token = tx.purchaseToken || tx.transactionId;
  const productId = tx.productIdentifier;
  if (!token || !PRODUCTS.includes(productId)) return false;
  // Android: "1" = PURCHASED. Bekleyen (pending) ödemeler henüz verilmez.
  if (tx.purchaseState !== undefined && tx.purchaseState !== '1') return false;
  if (inFlightTokens.has(token)) return false;
  // Daha önce tamamen bitirilmiş satın alma: tekrar verme
  if (readTokens(DONE_TOKENS_KEY).includes(token)) return false;

  inFlightTokens.add(token);
  let grantedNow = false;
  try {
    if (!readTokens(GRANTED_TOKENS_KEY).includes(token)) {
      if (listeners.size === 0) return false;
      for (const cb of listeners) {
        // Dinleyici hata verirse kırıntı verilmemiş sayılır: işaretleme ve tüketme yapılmaz
        await cb(productId);
      }
      grantedNow = true;
      // Kayıt yazılsın, sonra işaretle. Arada kapanırsa kırıntı tekrar verilir (oyuncu lehine).
      await wait(saveSettleMs);
      markGranted(token);
    }

    await NativePurchases.consumePurchase({ purchaseToken: token });
    markDone(token);
  } catch {
    // Dinleyici hatası veya tüketme başarısız (ör. ağ yok): kurtarma akışı tekrar dener.
    // Kırıntısı verilip işaretlenmiş token'lar için sadece tüketme yeniden denenir.
  } finally {
    inFlightTokens.delete(token);
  }
  return grantedNow;
}

/** Yarım kalmış (kırıntısı verilmemiş veya tüketilmemiş) satın almaları tamamlar. */
function recoverUnfinishedPurchases(): Promise<void> {
  if (!isNative()) return Promise.resolve();
  if (recoveryPromise) return recoveryPromise;

  recoveryPromise = (async () => {
    try {
      const { transactions } = await NativePurchases.getUnfinishedTransactions();
      let grantedAny = false;
      for (const tx of transactions) {
        if (await deliverAndConsume(tx)) grantedAny = true;
      }
      // Bekleyen ödeme onaylanıp kırıntısı verildiyse takibi bitir
      if (grantedAny && readPendingSince() !== null) {
        setPendingSince(null);
        stopPendingPoll();
      }
    } catch {
      // Billing servisi şu an ulaşılamaz; bir sonraki açılış/dönüşte tekrar denenir
    } finally {
      recoveryPromise = null;
    }
  })();

  return recoveryPromise;
}

function installResumeHook(): void {
  if (resumeHookInstalled || typeof document === 'undefined') return;
  resumeHookInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && listeners.size > 0) {
      void recoverUnfinishedPurchases();
    }
  });
}

// Mağazadan gelen fiyatlar (ekranda bunları gösterin, $ fiyatı koda yazmayın)
export async function getProducts(): Promise<{ id: string; price: string }[]> {
  if (!isNative()) return [];
  const { products } = await NativePurchases.getProducts({
    productIdentifiers: PRODUCTS,
    productType: PURCHASE_TYPE.INAPP,
  });
  return products
    .filter((p) => PRODUCTS.includes(p.identifier))
    .map((p) => ({ id: p.identifier, price: p.priceString }));
}

/**
 * Butona basınca bunu çağırın.
 * 'pending' dönerse oyuncuya "ödemen onaylanınca kırıntın eklenecek" gibi bir mesaj gösterilebilir.
 */
export async function buy(id: string): Promise<BuyResult> {
  if (!isNative()) return 'canceled';
  if (!PRODUCTS.includes(id)) throw new Error(`Bilinmeyen ürün: ${id}`);

  let tx: Transaction;
  try {
    tx = await NativePurchases.purchaseProduct({
      productIdentifier: id,
      productType: PURCHASE_TYPE.INAPP,
      isConsumable: false, // tüketmeyi kırıntı verildikten sonra biz yapıyoruz
      autoAcknowledgePurchases: false,
    });
  } catch (err) {
    const code = errorCode(err);
    // Kullanıcı vazgeçti: hata gösterme
    if (code === 'USER_CANCELED') return 'canceled';
    // Ödeme beklemede (ör. nakit/kod ile ödeme): onaylanınca kurtarma akışı kırıntıyı verir
    if (code.toLowerCase().includes('pending')) {
      setPendingSince(Date.now());
      startPendingPoll();
      return 'pending';
    }
    // Önceki bir satın alma tüketilmemiş: önce onu tamamla
    if (code === 'ITEM_ALREADY_OWNED') {
      await recoverUnfinishedPurchases();
      return 'recovered';
    }
    throw err;
  }

  await deliverAndConsume(tx);
  return 'purchased';
}

// Satın alma onaylanınca kırıntıyı burada verin (buton tıklanınca değil)
export function onPurchased(cb: PurchaseListener): (() => void) | void {
  listeners.add(cb);
  if (isNative()) {
    installResumeHook();
    void recoverUnfinishedPurchases();
    startPendingPoll();
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) stopPendingPoll();
  };
}

/** Yalnızca testler için. */
export const __testing = {
  setSaveSettleMs(ms: number): void {
    saveSettleMs = ms;
  },
  setPendingPollMs(ms: number): void {
    pendingPollMs = ms;
  },
  pendingPollActive(): boolean {
    return pendingPollTimer !== null;
  },
};
