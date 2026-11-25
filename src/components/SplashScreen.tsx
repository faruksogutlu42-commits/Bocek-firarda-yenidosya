import { useEffect, useState, type ReactNode } from 'react';
import { preloadChaserGlb } from '../game/glbCharacters';

/**
 * Açılış ekranı: tam ekran görsel + altta yükleme çubuğu.
 * - En az MIN_MS gösterilir (müşteri isteği: 3-4 sn).
 * - Kovalayan karakter modeli yüklenene kadar bekler (en fazla MAX_MS).
 * - Oyun arkada aynı anda yüklenir; splash kalkınca hazır olur.
 */
const MIN_MS = 3500;
const MAX_MS = 9000;
const FADE_MS = 400;

export default function SplashScreen({ children }: { children: ReactNode }) {
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<'show' | 'fade' | 'done'>('show');

  useEffect(() => {
    const start = performance.now();
    let assetsReady = false;
    let finished = false;

    void Promise.race([
      preloadChaserGlb().catch(() => null),
      new Promise((r) => setTimeout(r, MAX_MS)),
    ]).then(() => {
      assetsReady = true;
    });

    let raf = 0;
    const step = () => {
      const elapsed = performance.now() - start;
      // Zamana göre %92'ye kadar ilerle; son kısım yükleme bitince tamamlanır
      const timeProgress = Math.min(elapsed / MIN_MS, 1) * 0.92;
      const done = assetsReady && elapsed >= MIN_MS;
      setProgress(done ? 1 : timeProgress);
      if (done && !finished) {
        finished = true;
        setTimeout(() => setPhase('fade'), 150);
        setTimeout(() => setPhase('done'), 150 + FADE_MS);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <>
      {children}
      {phase !== 'done' && (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-[9999] bg-[#0b0d14] transition-opacity ease-out"
          style={{ opacity: phase === 'fade' ? 0 : 1, transitionDuration: `${FADE_MS}ms` }}
        >
          <img
            src="/splash.jpg"
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover object-top"
          />
          <div
            className="absolute left-1/2 w-[62%] max-w-sm -translate-x-1/2"
            style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 7%)' }}
          >
            <div className="h-3 overflow-hidden rounded-full border border-white/40 bg-black/55 shadow-[0_0_12px_rgba(0,0,0,0.6)]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-slate-200 via-white to-sky-200 shadow-[0_0_10px_rgba(186,230,253,0.9)]"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
