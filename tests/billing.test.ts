import { beforeEach, expect, mock, test } from 'bun:test';

// --- localStorage + document stubs ---
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
const docListeners: Record<string, (() => void)[]> = {};
(globalThis as any).document = {
  addEventListener: (ev: string, cb: () => void) => { (docListeners[ev] ??= []).push(cb); },
  visibilityState: 'visible',
};
const fireVisible = () => docListeners['visibilitychange']?.forEach((cb) => cb());

// --- plugin mocks ---
let unfinished: any[] = [];
let consumeShouldFail = false;
let purchaseImpl: (o: any) => Promise<any> = async () => ({});
const consumed: string[] = [];

mock.module('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
mock.module('@capgo/native-purchases', () => ({
  PURCHASE_TYPE: { INAPP: 'inapp', SUBS: 'subs' },
  NativePurchases: {
    getProducts: async ({ productIdentifiers }: any) => ({
      products: productIdentifiers.map((id: string) => ({ identifier: id, priceString: '₺39,99' })),
    }),
    purchaseProduct: (o: any) => purchaseImpl(o),
    consumePurchase: async ({ purchaseToken }: any) => {
      if (consumeShouldFail) throw new Error('network');
      consumed.push(purchaseToken);
      unfinished = unfinished.filter((t) => t.purchaseToken !== purchaseToken);
    },
    getUnfinishedTransactions: async () => ({ transactions: [...unfinished] }),
  },
}));

const billing = await import('../src/services/billing.ts');
billing.__testing.setSaveSettleMs(0);
billing.__testing.setPendingPollMs(20);
const tick = () => new Promise((r) => setTimeout(r, 5));
const tx = (token: string, id = 'kirinti_2') => ({
  transactionId: token, purchaseToken: token, productIdentifier: id, purchaseState: '1',
});

let granted: string[] = [];
let listenerShouldThrow = false;
let unsub: (() => void) | undefined;
beforeEach(() => {
  unsub?.();
  store.clear(); unfinished = []; consumed.length = 0; granted = [];
  consumeShouldFail = false; listenerShouldThrow = false;
});
const listen = () => {
  unsub = billing.onPurchased((id: string) => {
    if (listenerShouldThrow) throw new Error('save failed');
    granted.push(id);
  }) as any;
};

test('fiyatlar mağazadan gelir', async () => {
  const p = await billing.getProducts();
  expect(p).toEqual([
    { id: 'kirinti_1', price: '₺39,99' }, { id: 'kirinti_2', price: '₺39,99' }, { id: 'kirinti_3', price: '₺39,99' },
  ]);
});

test('normal satın alma: kırıntı 1 kez verilir ve tüketilir', async () => {
  listen(); await tick();
  purchaseImpl = async () => tx('A');
  expect(await billing.buy('kirinti_2')).toBe('purchased');
  expect(granted).toEqual(['kirinti_2']);
  expect(consumed).toEqual(['A']);
});

test('iptal: hata fırlatmaz, kırıntı verilmez', async () => {
  listen(); await tick();
  purchaseImpl = async () => { throw Object.assign(new Error('Purchase is not purchased'), { code: 'USER_CANCELED' }); };
  await billing.buy('kirinti_1');
  expect(granted).toEqual([]);
});

test('bekleyen ödeme: hata fırlatmaz, kırıntı verilmez', async () => {
  listen(); await tick();
  purchaseImpl = async () => { throw new Error('Purchase is pending'); };
  expect(await billing.buy('kirinti_1')).toBe('pending');
  expect(granted).toEqual([]);
});

test('başka hata: fırlatılır (oyun uyarı gösterir)', async () => {
  listen(); await tick();
  purchaseImpl = async () => { throw Object.assign(new Error('x'), { code: 'NETWORK_ERROR' }); };
  await expect(billing.buy('kirinti_1')).rejects.toThrow();
});

test('consume başarısız → açılışta kırıntı TEKRAR verilmez, sadece tüketilir', async () => {
  listen(); await tick();
  consumeShouldFail = true;
  purchaseImpl = async () => { unfinished.push(tx('B', 'kirinti_3')); return tx('B', 'kirinti_3'); };
  await billing.buy('kirinti_3');
  expect(granted).toEqual(['kirinti_3']);
  expect(consumed).toEqual([]);

  consumeShouldFail = false;
  unsub?.(); listen(); await tick(); // uygulama yeniden açıldı
  expect(granted).toEqual(['kirinti_3']); // ikinci kez verilmedi
  expect(consumed).toEqual(['B']);
});

test('uygulama ödeme sonrası kapandı → açılışta kırıntı verilir ve tüketilir', async () => {
  unfinished.push(tx('C', 'kirinti_1'));
  listen(); await tick();
  expect(granted).toEqual(['kirinti_1']);
  expect(consumed).toEqual(['C']);
});

test('ITEM_ALREADY_OWNED → yarım kalan satın alma tamamlanır', async () => {
  listen(); await tick();
  unfinished.push(tx('D', 'kirinti_2'));
  purchaseImpl = async () => { throw Object.assign(new Error('owned'), { code: 'ITEM_ALREADY_OWNED' }); };
  await billing.buy('kirinti_2');
  expect(granted).toEqual(['kirinti_2']);
  expect(consumed).toEqual(['D']);
});

test('bilinmeyen ürün kimliği reddedilir', async () => {
  listen(); await tick();
  await expect(billing.buy('hack_999')).rejects.toThrow();
});

// --- 1: aynı satın alma iki kez kırıntı vermez ---

test('kurtarma, buy() sonucundan önce aynı satın almayı bitirirse kırıntı yine 1 kez verilir', async () => {
  listen(); await tick();
  purchaseImpl = async () => {
    // Ödeme ekranı kapanırken uygulama görünür olur, kurtarma aynı token'ı bulur
    unfinished.push(tx('R', 'kirinti_3'));
    fireVisible();
    await tick();
    return tx('R', 'kirinti_3');
  };
  await billing.buy('kirinti_3');
  await tick();
  expect(granted).toEqual(['kirinti_3']);
  expect(consumed).toEqual(['R']);
});

test('tüketilmiş satın alma tekrar gelirse yok sayılır', async () => {
  listen(); await tick();
  purchaseImpl = async () => tx('E', 'kirinti_1');
  await billing.buy('kirinti_1');
  unfinished.push(tx('E', 'kirinti_1')); // eski token tekrar listelense bile
  fireVisible(); await tick();
  expect(granted).toEqual(['kirinti_1']);
  expect(consumed).toEqual(['E']);
});

// --- 2: parası ödenmiş kırıntı kaybolmaz ---

test('dinleyici hata verirse satın alma işaretlenmez ve tüketilmez; sonra kırıntı verilir', async () => {
  listen(); await tick();
  listenerShouldThrow = true;
  purchaseImpl = async () => { unfinished.push(tx('F', 'kirinti_2')); return tx('F', 'kirinti_2'); };
  await billing.buy('kirinti_2');
  expect(granted).toEqual([]);
  expect(consumed).toEqual([]);

  listenerShouldThrow = false;
  fireVisible(); await tick();
  expect(granted).toEqual(['kirinti_2']);
  expect(consumed).toEqual(['F']);
});

test('kırıntı verildikten sonra işaretlenmeden kapanırsa açılışta tekrar verilir (oyuncu lehine)', async () => {
  // İşaretleme beklemesi sırasında uygulama "kapandı": token işaretli değil, tüketilmedi
  billing.__testing.setSaveSettleMs(10_000);
  listen(); await tick();
  purchaseImpl = async () => { unfinished.push(tx('G', 'kirinti_1')); return tx('G', 'kirinti_1'); };
  void billing.buy('kirinti_1');
  await tick();
  expect(granted).toEqual(['kirinti_1']);
  expect(store.get('bocek_firar_iap_granted_tokens') ?? '[]').not.toContain('G');
  billing.__testing.setSaveSettleMs(0);
});

// --- 3: bekleyen ödeme uygulama açıkken onaylanınca kırıntı gelir ---

test('bekleyen ödeme: uygulama açıkken onaylanınca periyodik kurtarma kırıntıyı verir', async () => {
  listen(); await tick();
  purchaseImpl = async () => { throw new Error('Purchase is pending'); };
  expect(await billing.buy('kirinti_3')).toBe('pending');
  expect(billing.__testing.pendingPollActive()).toBe(true);

  unfinished.push(tx('P', 'kirinti_3')); // ödeme onaylandı
  await new Promise((r) => setTimeout(r, 80));
  expect(granted).toEqual(['kirinti_3']);
  expect(consumed).toEqual(['P']);
  expect(store.has('bocek_firar_iap_pending_since')).toBe(false);
  expect(billing.__testing.pendingPollActive()).toBe(false);
});

test('bekleyen ödeme 3 günden eskiyse takip bırakılır', async () => {
  store.set('bocek_firar_iap_pending_since', String(Date.now() - 4 * 24 * 60 * 60 * 1000));
  listen(); await tick();
  expect(billing.__testing.pendingPollActive()).toBe(false);
  expect(store.has('bocek_firar_iap_pending_since')).toBe(false);
});
