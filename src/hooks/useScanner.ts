import { useRef, useCallback, useEffect, RefObject } from 'react';

import jsQR from 'jsqr';

import {
    BarcodeDetector as PolyfillBarcodeDetector,
    setZXingModuleOverrides
} from 'barcode-detector/pure';

import { IDetectedBarcode, IUseScannerState, BarcodeFormat } from '../types';

import { base64Beep } from '../assets/base64Beep';

// localStorage-gated diagnostic logger. Mirrors the consumer's debugUtils
// pattern (`localStorage.setItem('debug', 'true')`) so the same toggle that
// enables app-side `debugLog` also enables per-frame fork logs. Cheap on the
// hot path: a single localStorage read per log call when off — and the gate
// is read inside the helper, so a debugLog() call adds zero overhead when
// debug is disabled beyond the localStorage read.
function isQRDebugEnabled(): boolean {
    try {
        if (typeof window === 'undefined') return false;
        const v = window.localStorage?.getItem('debug');
        return String(v).toLowerCase() === 'true';
    } catch {
        return false;
    }
}
function qrDebugLog(...args: unknown[]): void {
    if (isQRDebugEnabled()) {
        // eslint-disable-next-line no-console
        console.log('[QR-fork]', ...args);
    }
}

// ZXing-WASM polyfill (used when native window.BarcodeDetector is missing —
// kiosk Chromium builds typically lack it). The WASM file ships with the
// consumer at /wasm/zxing_reader.wasm so nothing is ever fetched from a CDN.
// Service workers in the consumer also rewrite any jsdelivr ZXing URL to the
// same local path as a belt-and-braces guard. The polyfill expects the
// override to be set BEFORE the first detect() call.
setZXingModuleOverrides({
    locateFile: (path: string, prefix: string) => {
        if (path.endsWith('.wasm')) return '/wasm/zxing_reader.wasm';
        return prefix + path;
    }
});

// Pre-warm the ZXing-WASM module so the very first scan does not eat the
// WASM compile + engine-init cost (~10ms first call, <2ms subsequent).
// detect() is the cheapest call that triggers the internal lazy load; running
// it on a 16x16 throwaway canvas is enough. We wait briefly for the consumer
// service worker to take control so the WASM fetch hits the SW cache (offline
// kiosk path) rather than racing the network. Errors are swallowed.
if (typeof document !== 'undefined') {
    (async () => {
        try {
            if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && !navigator.serviceWorker.controller) {
                await Promise.race([
                    new Promise<void>((resolve) => {
                        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
                    }),
                    new Promise<void>((resolve) => setTimeout(resolve, 500))
                ]);
            }
            const warmCanvas = document.createElement('canvas');
            warmCanvas.width = 16;
            warmCanvas.height = 16;
            const warmDetector = new PolyfillBarcodeDetector({ formats: ['qr_code'] });
            await warmDetector.detect(warmCanvas);
            // eslint-disable-next-line no-console
            console.log('[QR-fork] ZXing-WASM pre-warmed');
        } catch {
            // best-effort
        }
    })();
}

// Native BarcodeDetector is browser-provided (Chrome / Edge / Android WebView).
// On browsers without native support we now fall back to the ZXing-WASM
// polyfill (configured above) — much better at tilt, rotation, and glare than
// jsQR — and finally to bundled jsQR as a last resort.
declare global {
    interface Window {
        BarcodeDetector?: {
            new (options?: { formats?: BarcodeFormat[] }): {
                detect: (source: CanvasImageSource) => Promise<IDetectedBarcode[]>;
            };
            getSupportedFormats?: () => Promise<BarcodeFormat[]>;
        };
    }
}
// requestVideoFrameCallback / cancelVideoFrameCallback are declared in
// lib.dom.d.ts on TypeScript >= 4.4. We feature-detect at runtime so we
// don't need to declare them here; older browsers (Firefox <130, Safari
// <16) simply fall back to requestAnimationFrame.

interface IUseScannerProps {
    videoElementRef: RefObject<HTMLVideoElement | null>;
    onScan: (result: IDetectedBarcode[]) => void;
    onFound: (result: IDetectedBarcode[]) => void;
    onAutoTorch?: (engage: boolean) => void;
    formats?: BarcodeFormat[];
    sound?: boolean | string;
    allowMultiple?: boolean;
    retryDelay?: number;
    scanDelay?: number;
    roi?: number;
    autoTorch?: boolean;
    // When true, the rAF/rVFC loop keeps spinning (so the consumer can
    // resume instantly) but the per-frame decode is skipped. Camera stays
    // live. Use this while the consumer is busy with downstream work that
    // needs CPU and the live video stream (e.g. face recognition) but
    // should not be interrupted by a fresh QR callback.
    pauseDecoding?: boolean;
}

const LOW_LUMINANCE = 70;
const HIGH_LUMINANCE = 160;
// Aggressive torch engagement — was 20 frames (~330ms), dropping to 8 (~130ms)
// so dim presentations get assistance fast. Disengage stays slow so we do not
// flap on/off during a single decode attempt.
const LOW_LUM_FRAMES_TO_ENGAGE = 8;
const HIGH_LUM_FRAMES_TO_DISENGAGE = 30;
// jsQR has a small but non-zero false-positive rate on cluttered backgrounds
// (logos, posters, brick walls). Requiring N consecutive identical decodes
// before reporting eliminates almost all of these at ~16ms*N latency cost.
// Kiosk consumer (attendance staff_no lookup) validates the decoded value
// against its staff list, so a phantom decode that doesn't match a real
// staff number is rejected at the consumer with no side effects. We trade
// one frame of confirmation latency for catching brief QR presentations.
const JSQR_CONFIRM_FRAMES = 1;
// Reject extremely short payloads — a real attendance QR is at least this long.
// Tune in consumer instead of here if it ever needs to be stricter / looser.
const MIN_PAYLOAD_LEN = 3;

// Multi-scale jsQR (pyzbar-style). Each scale is the *longest-edge* target
// after downsampling the ROI crop. Pyzbar gets robustness from trying the
// finder-pattern walk at multiple module sizes — we approximate that by
// re-running jsQR at three resolutions. First hit wins. Larger scales help
// distant / small QRs (more modules survive); smaller scales help motion-
// blurred or low-contrast QRs (averaging hides noise).
const JSQR_SCALES = [640, 480, 320];

// Sauvola adaptive-threshold parameters. Pyzbar / OpenCV typically use 15px
// windows with k≈0.34, R=128. The window is intentionally larger than a
// typical QR module so local mean+std are stable across the finder pattern
// instead of inside it.
const SAUVOLA_WINDOW = 15;
const SAUVOLA_K = 0.34;
const SAUVOLA_R = 128;

// Gating: when ZXing is the active path, the per-frame jsQR work is the
// dominant cost (even after downsampling — still ~25ms per scale). Two
// gates: (a) miss streak must reach ZXING_MISS_BEFORE_JSQR before jsQR is
// allowed to run at all, and (b) once unlocked jsQR runs at most once per
// JSQR_MIN_INTERVAL_MS so ZXing keeps ticking at near-rAF cadence between
// attempts.
//
// Previous values (5 / 200) were too defensive — a user waving a phone past
// for ~250ms left jsQR no opportunity. Tightening to 2 / 100 gives jsQR ~32ms
// after ZXing's first miss to catch the same presentation. Multi-scale + the
// 100ms inter-attempt gap keep the per-second budget bounded.
const ZXING_MISS_BEFORE_JSQR = 2;
const JSQR_MIN_INTERVAL_MS = 100;

function contrastStretch(gray: Uint8ClampedArray): Uint8ClampedArray {
    let min = 255;
    let max = 0;
    for (let i = 0; i < gray.length; i++) {
        const v = gray[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }
    const range = max - min;
    if (range < 10) return gray;
    const scale = 255 / range;
    const out = new Uint8ClampedArray(gray.length);
    for (let i = 0; i < gray.length; i++) {
        out[i] = Math.max(0, Math.min(255, (gray[i] - min) * scale));
    }
    return out;
}

// Sauvola adaptive binarization via two integral images. Single O(n) pass
// each: integralSum and integralSumSq. Window is square 2r+1 around each
// pixel, clamped to image bounds. ~5ms at 640x360 in pure JS.
//
// Output is a Uint8ClampedArray of 0 / 255 values that can be wrapped as
// ImageData and fed straight to jsQR. The high-contrast result reliably
// recovers QRs that drown in global-threshold preprocessing because of
// glare, vignette, or uneven illumination — the classic pyzbar wins.
function sauvolaThreshold(gray: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
    const n = w * h;
    // Use Float64Array for the integral images; Uint32 would overflow for
    // sumSq at w*h > ~16M, and float math is fast enough at these sizes.
    const integralSum = new Float64Array(n);
    const integralSumSq = new Float64Array(n);

    // First row.
    let rowSum = 0;
    let rowSumSq = 0;
    for (let x = 0; x < w; x++) {
        const v = gray[x];
        rowSum += v;
        rowSumSq += v * v;
        integralSum[x] = rowSum;
        integralSumSq[x] = rowSumSq;
    }
    // Remaining rows: I(x,y) = I(x-1,y) + I(x,y-1) - I(x-1,y-1) + pixel(x,y).
    for (let y = 1; y < h; y++) {
        let rs = 0;
        let rss = 0;
        const yOff = y * w;
        const yPrev = yOff - w;
        for (let x = 0; x < w; x++) {
            const v = gray[yOff + x];
            rs += v;
            rss += v * v;
            integralSum[yOff + x] = integralSum[yPrev + x] + rs;
            integralSumSq[yOff + x] = integralSumSq[yPrev + x] + rss;
        }
    }

    const r = (SAUVOLA_WINDOW - 1) >> 1;
    const out = new Uint8ClampedArray(n);

    for (let y = 0; y < h; y++) {
        const y1 = Math.max(0, y - r - 1);
        const y2 = Math.min(h - 1, y + r);
        for (let x = 0; x < w; x++) {
            const x1 = Math.max(0, x - r - 1);
            const x2 = Math.min(w - 1, x + r);

            // Inclusion-exclusion on the integral images.
            // The "-1" indices are virtual; we handle them by checking
            // whether x1 / y1 are at the top-left synthetic boundary.
            const a = (x1 >= 0 && y1 >= 0) ? integralSum[y1 * w + x1] : 0;
            const b = (y1 >= 0) ? integralSum[y1 * w + x2] : 0;
            const c = (x1 >= 0) ? integralSum[y2 * w + x1] : 0;
            const d = integralSum[y2 * w + x2];
            const sum = d - b - c + a;

            const aSq = (x1 >= 0 && y1 >= 0) ? integralSumSq[y1 * w + x1] : 0;
            const bSq = (y1 >= 0) ? integralSumSq[y1 * w + x2] : 0;
            const cSq = (x1 >= 0) ? integralSumSq[y2 * w + x1] : 0;
            const dSq = integralSumSq[y2 * w + x2];
            const sumSq = dSq - bSq - cSq + aSq;

            const count = (x2 - x1) * (y2 - y1);
            const mean = sum / count;
            const variance = (sumSq / count) - mean * mean;
            const std = variance > 0 ? Math.sqrt(variance) : 0;
            const t = mean * (1 + SAUVOLA_K * (std / SAUVOLA_R - 1));

            out[y * w + x] = gray[y * w + x] > t ? 255 : 0;
        }
    }
    return out;
}

function grayToImageData(gray: Uint8ClampedArray, width: number, height: number): ImageData {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
        rgba[j] = gray[i];
        rgba[j + 1] = gray[i];
        rgba[j + 2] = gray[i];
        rgba[j + 3] = 255;
    }
    return new ImageData(rgba, width, height);
}

export default function useScanner(props: IUseScannerProps) {
    const {
        videoElementRef,
        onScan,
        onFound,
        onAutoTorch,
        retryDelay = 0,
        scanDelay = 0,
        formats = ['qr_code'],
        allowMultiple = false,
        sound = true,
        // Full frame by default. The 0.7 center-crop helps in cluttered
        // environments but causes valid QRs held near the edge of the
        // viewfinder to be missed entirely on kiosks. Consumer can lower
        // the value back if they need the tighter SNR window.
        roi = 1.0,
        autoTorch = true,
        pauseDecoding = false
    }: IUseScannerProps = props;

    const nativeDetectorRef = useRef<InstanceType<NonNullable<Window['BarcodeDetector']>> | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    // Handle for the active frame-callback scheduler. We pick rVFC when the
    // browser supports it (Chrome / Edge / Safari 16+) and fall back to rAF
    // otherwise. Both expose a numeric handle; we tag the type so cancel
    // dispatches to the right API.
    const scheduleHandleRef = useRef<{ type: 'rvfc' | 'raf'; id: number } | null>(null);
    const decodeInFlightRef = useRef(false);

    // Per-scale work canvas cache. Each jsQR scale uses its own canvas so we
    // do not thrash the canvas dims on every frame and pay the underlying
    // GPU-side reallocation cost.
    const workCanvasesRef = useRef<Map<number, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }>>(new Map());

    const torchEngagedRef = useRef(false);
    const lowLumStreakRef = useRef(0);
    const highLumStreakRef = useRef(0);

    // jsQR confirmation buffer — last decode value and streak count.
    const jsqrLastValueRef = useRef<string | null>(null);
    const jsqrStreakRef = useRef(0);

    const zxingMissStreakRef = useRef(0);
    const lastJsqrAttemptAtRef = useRef(0);

    // Ref-mirrored pauseDecoding so the long-lived rAF chain reads the
    // latest value without rebuilding the loop on every toggle.
    const pauseDecodingRef = useRef(pauseDecoding);
    useEffect(() => {
        pauseDecodingRef.current = pauseDecoding;
    }, [pauseDecoding]);

    // Stable cache key for formats so the detector init effect only
    // re-fires when the actual formats list changes, not when the parent
    // re-renders with a fresh array literal. Without this the consumer
    // saw "using ZXing-WASM polyfill BarcodeDetector" logged on every
    // render — harmless but noisy in production console logs.
    const formatsKey = (formats || []).slice().sort().join(',');

    useEffect(() => {
        if (typeof window === 'undefined') {
            nativeDetectorRef.current = null;
            return;
        }
        // Prefer native (zero overhead, hardware accelerated when available).
        if (window.BarcodeDetector) {
            try {
                nativeDetectorRef.current = new window.BarcodeDetector({ formats });
                // eslint-disable-next-line no-console
                console.log('[QR-fork] using native window.BarcodeDetector');
                return;
            } catch {
                // Fall through to polyfill.
            }
        }
        // Polyfill (ZXing-WASM) — ~5ms per detect once warm, far more
        // robust on tilted / partial / glare-affected QRs than jsQR.
        try {
            nativeDetectorRef.current = new PolyfillBarcodeDetector({ formats }) as unknown as InstanceType<NonNullable<Window['BarcodeDetector']>>;
            // eslint-disable-next-line no-console
            console.log('[QR-fork] using ZXing-WASM polyfill BarcodeDetector');
        } catch (err) {
            // eslint-disable-next-line no-console
            console.log('[QR-fork] polyfill BarcodeDetector failed to init', err);
            nativeDetectorRef.current = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [formatsKey]);

    useEffect(() => {
        if (typeof window !== 'undefined' && sound) {
            audioRef.current = new Audio(typeof sound === 'string' ? sound : base64Beep);
        }
    }, [sound]);

    // Clean up any cached work-canvases on unmount. They live as DOM
    // detached elements; left around they just leak memory.
    useEffect(() => {
        return () => {
            workCanvasesRef.current.clear();
        };
    }, []);

    const getWorkCanvas = useCallback((outW: number, outH: number) => {
        const key = outW * 100000 + outH;
        let entry = workCanvasesRef.current.get(key);
        if (!entry) {
            const canvas = document.createElement('canvas');
            canvas.width = outW;
            canvas.height = outH;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) return null;
            entry = { canvas, ctx };
            workCanvasesRef.current.set(key, entry);
        }
        return entry;
    }, []);

    // grabFrame downsamples the ROI crop to the given max-edge. Multi-scale
    // jsQR calls this per scale to get pyzbar-style multi-resolution decode
    // attempts. Returns a greyscale buffer plus mean luma for the auto-torch
    // heuristic (caller updates torch only once per video frame).
    const grabFrame = useCallback(
        (videoEl: HTMLVideoElement, maxDim: number): { gray: Uint8ClampedArray; width: number; height: number; meanLuma: number } | null => {
            const vw = videoEl.videoWidth;
            const vh = videoEl.videoHeight;
            if (vw === 0 || vh === 0) return null;

            const cropW = Math.floor(vw * roi);
            const cropH = Math.floor(vh * roi);
            const sx = Math.floor((vw - cropW) / 2);
            const sy = Math.floor((vh - cropH) / 2);

            const longestEdge = Math.max(cropW, cropH);
            const scale = longestEdge > maxDim ? maxDim / longestEdge : 1;
            const outW = Math.max(1, Math.round(cropW * scale));
            const outH = Math.max(1, Math.round(cropH * scale));

            const entry = getWorkCanvas(outW, outH);
            if (!entry) return null;
            const { canvas, ctx } = entry;
            if (canvas.width !== outW) canvas.width = outW;
            if (canvas.height !== outH) canvas.height = outH;

            ctx.drawImage(videoEl, sx, sy, cropW, cropH, 0, 0, outW, outH);
            const img = ctx.getImageData(0, 0, outW, outH);
            const rgba = img.data;
            const gray = new Uint8ClampedArray(outW * outH);
            let lumaSum = 0;
            for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
                const y = (rgba[i] * 0.2126 + rgba[i + 1] * 0.7152 + rgba[i + 2] * 0.0722) | 0;
                gray[j] = y;
                lumaSum += y;
            }
            return { gray, width: outW, height: outH, meanLuma: lumaSum / gray.length };
        },
        [roi, getWorkCanvas]
    );

    const updateAutoTorch = useCallback(
        (meanLuma: number) => {
            if (!autoTorch || !onAutoTorch) return;
            if (meanLuma < LOW_LUMINANCE) {
                lowLumStreakRef.current++;
                highLumStreakRef.current = 0;
                if (!torchEngagedRef.current && lowLumStreakRef.current >= LOW_LUM_FRAMES_TO_ENGAGE) {
                    torchEngagedRef.current = true;
                    qrDebugLog(`torch ENGAGE meanLuma=${meanLuma.toFixed(0)} after ${lowLumStreakRef.current} low-lum frames`);
                    onAutoTorch(true);
                }
            } else if (meanLuma > HIGH_LUMINANCE) {
                highLumStreakRef.current++;
                lowLumStreakRef.current = 0;
                if (torchEngagedRef.current && highLumStreakRef.current >= HIGH_LUM_FRAMES_TO_DISENGAGE) {
                    torchEngagedRef.current = false;
                    qrDebugLog(`torch DISENGAGE meanLuma=${meanLuma.toFixed(0)} after ${highLumStreakRef.current} high-lum frames`);
                    onAutoTorch(false);
                }
            } else {
                lowLumStreakRef.current = 0;
                highLumStreakRef.current = 0;
            }
        },
        [autoTorch, onAutoTorch]
    );

    const decodeMultiPass = useCallback(
        async (videoEl: HTMLVideoElement): Promise<IDetectedBarcode[]> => {
            // Pass 1: native BarcodeDetector (window-provided) or ZXing-WASM
            // polyfill via the same detect() interface. Both decode the live
            // video element directly with no CPU readback. ZXing handles
            // the vast majority of tilt / rotation / glare cases on its own.
            const native = nativeDetectorRef.current;
            let nativeMissed = false;
            if (native) {
                const t0 = performance.now();
                try {
                    const hits = await native.detect(videoEl);
                    if (hits.length > 0) {
                        // Reset both miss streaks so the next ZXing miss does not
                        // immediately trigger the stuck-fallback path.
                        zxingMissStreakRef.current = 0;
                        qrDebugLog(`ZXing HIT t=${(performance.now() - t0).toFixed(1)}ms value="${hits[0].rawValue}"`);
                        return hits;
                    }
                    nativeMissed = true;
                    zxingMissStreakRef.current++;
                    qrDebugLog(`ZXing miss t=${(performance.now() - t0).toFixed(1)}ms streak=${zxingMissStreakRef.current}`);
                } catch (err) {
                    nativeMissed = true;
                    zxingMissStreakRef.current++;
                    if (zxingMissStreakRef.current === 1) {
                        // eslint-disable-next-line no-console
                        console.log('[QR-fork] BarcodeDetector threw', err);
                    }
                    qrDebugLog(`ZXing throw t=${(performance.now() - t0).toFixed(1)}ms streak=${zxingMissStreakRef.current}`);
                }
            }

            // jsQR fallback gating. After ZXING_MISS_BEFORE_JSQR consecutive
            // ZXing misses, we run jsQR at multiple scales. JSQR_MIN_INTERVAL_MS
            // keeps the rolling cost bounded so ZXing still gets the bulk of
            // the per-second budget.
            if (native && nativeMissed) {
                if (zxingMissStreakRef.current < ZXING_MISS_BEFORE_JSQR) {
                    return [];
                }
                const nowTs = performance.now();
                if (nowTs - lastJsqrAttemptAtRef.current < JSQR_MIN_INTERVAL_MS) {
                    qrDebugLog(`jsQR rate-limited (since-last=${(nowTs - lastJsqrAttemptAtRef.current).toFixed(0)}ms < ${JSQR_MIN_INTERVAL_MS}ms)`);
                    return [];
                }
                lastJsqrAttemptAtRef.current = nowTs;
                qrDebugLog(`jsQR unlocked: streak=${zxingMissStreakRef.current} starting multi-scale pass`);
            }

            // Multi-scale jsQR. Pyzbar-style: try the same frame at three
            // resolutions. First scale that yields a hit short-circuits the
            // rest. Per scale, we try three binarization variants:
            //   1. raw greyscale
            //   2. globally contrast-stretched (cheap; recovers low-dynamic
            //      range frames)
            //   3. Sauvola adaptive threshold (recovers glare / uneven
            //      lighting — the main pyzbar win)
            // jsQR's `inversionAttempts: 'attemptBoth'` lets a single call
            // catch both light-on-dark and dark-on-light codes.
            let value: string | null = null;
            let lumaUpdated = false;
            let hitScale: number | null = null;
            let hitVariant: string | null = null;
            const jsqrT0 = performance.now();

            for (const maxDim of JSQR_SCALES) {
                const frame = grabFrame(videoEl, maxDim);
                if (!frame) continue;

                if (!lumaUpdated) {
                    updateAutoTorch(frame.meanLuma);
                    lumaUpdated = true;
                    qrDebugLog(`jsQR frame ${frame.width}x${frame.height} meanLuma=${frame.meanLuma.toFixed(0)} torch=${torchEngagedRef.current}`);
                }

                const tryDecode = (buf: Uint8ClampedArray): string | null => {
                    const imgData = grayToImageData(buf, frame.width, frame.height);
                    const res = jsQR(imgData.data, frame.width, frame.height, { inversionAttempts: 'attemptBoth' });
                    if (!res) return null;
                    const v = res.data;
                    if (!v || v.length < MIN_PAYLOAD_LEN) return null;
                    return v;
                };

                value = tryDecode(frame.gray);
                if (value) { hitScale = maxDim; hitVariant = 'raw'; break; }
                value = tryDecode(contrastStretch(frame.gray));
                if (value) { hitScale = maxDim; hitVariant = 'stretch'; break; }
                value = tryDecode(sauvolaThreshold(frame.gray, frame.width, frame.height));
                if (value) { hitScale = maxDim; hitVariant = 'sauvola'; break; }
            }

            const jsqrTotal = (performance.now() - jsqrT0).toFixed(1);
            if (value) {
                qrDebugLog(`jsQR HIT scale=${hitScale} variant=${hitVariant} t=${jsqrTotal}ms value="${value}"`);
            } else {
                qrDebugLog(`jsQR miss all-scales t=${jsqrTotal}ms`);
            }

            const buildBarcode = (rawValue: string): IDetectedBarcode => ({
                rawValue,
                format: 'qr_code',
                // jsQR returns location too, but we deliberately drop the bbox here:
                // re-running jsQR a second time to recover corners after the
                // confirmation streak is reached would double our CPU. The
                // tracking overlay only matters when a tracker prop is supplied,
                // which the consumer (kiosk attendance) does not use.
                boundingBox: DOMRectReadOnly.fromRect({ x: 0, y: 0, width: 0, height: 0 }),
                cornerPoints: []
            });

            if (value === null) {
                jsqrLastValueRef.current = null;
                jsqrStreakRef.current = 0;
                return [];
            }

            // Confirmation gate. Require the same value across N consecutive
            // frames. Stops phantom decodes from cluttered backgrounds.
            if (jsqrLastValueRef.current === value) {
                jsqrStreakRef.current++;
            } else {
                jsqrLastValueRef.current = value;
                jsqrStreakRef.current = 1;
            }

            if (jsqrStreakRef.current < JSQR_CONFIRM_FRAMES) {
                return [];
            }

            // Successful jsQR hit through the stuck-fallback path. Reset the
            // ZXing miss streak so the next frame goes back to ZXing-only
            // decoding and stops paying the jsQR cost. Log only this event
            // (rare in practice) since it signals that ZXing was stuck.
            zxingMissStreakRef.current = 0;
            // eslint-disable-next-line no-console
            console.log(`[QR-fork] jsQR stuck-fallback FIRE value="${value}"`);
            return [buildBarcode(value)];
        },
        [grabFrame, updateAutoTorch]
    );

    // Reschedule the next decode tick. Prefer requestVideoFrameCallback when
    // supported — it fires on actual new video frames, so we never burn CPU
    // re-decoding an unchanged frame the way rAF does when the camera runs
    // at <60fps. Falls back to rAF on Firefox <130 / older browsers.
    const schedulerKindLoggedRef = useRef(false);
    const scheduleNext = useCallback(
        (cb: (now: number) => void) => {
            const videoEl = videoElementRef.current;
            if (videoEl && typeof videoEl.requestVideoFrameCallback === 'function') {
                if (!schedulerKindLoggedRef.current) {
                    schedulerKindLoggedRef.current = true;
                    qrDebugLog('scheduler: requestVideoFrameCallback (rVFC)');
                }
                const id = videoEl.requestVideoFrameCallback((now: number) => cb(now));
                scheduleHandleRef.current = { type: 'rvfc', id };
            } else {
                if (!schedulerKindLoggedRef.current) {
                    schedulerKindLoggedRef.current = true;
                    qrDebugLog('scheduler: requestAnimationFrame (rAF fallback)');
                }
                const id = window.requestAnimationFrame(cb);
                scheduleHandleRef.current = { type: 'raf', id };
            }
        },
        [videoElementRef]
    );

    const cancelScheduled = useCallback(() => {
        const h = scheduleHandleRef.current;
        if (!h) return;
        const videoEl = videoElementRef.current;
        if (h.type === 'rvfc' && videoEl && typeof videoEl.cancelVideoFrameCallback === 'function') {
            videoEl.cancelVideoFrameCallback(h.id);
        } else if (h.type === 'raf') {
            window.cancelAnimationFrame(h.id);
        }
        scheduleHandleRef.current = null;
    }, [videoElementRef]);

    const processFrame = useCallback(
        (state: IUseScannerState) => async (timeNow: number) => {
            const videoEl = videoElementRef.current;
            if (videoEl === null || videoEl.readyState <= 1) {
                scheduleNext(processFrame(state));
                return;
            }

            const { lastScan, contentBefore, lastScanHadContent } = state;

            if (retryDelay > 0 && timeNow - lastScan < retryDelay) {
                scheduleNext(processFrame(state));
                return;
            }

            if (decodeInFlightRef.current) {
                scheduleNext(processFrame(state));
                return;
            }

            if (pauseDecodingRef.current) {
                // Reset the jsQR confirmation streak while paused so that a
                // resume on the SAME stale code does not immediately fire.
                if (jsqrLastValueRef.current !== null || jsqrStreakRef.current !== 0) {
                    qrDebugLog('pauseDecoding entered; clearing jsQR confirmation streak');
                }
                jsqrLastValueRef.current = null;
                jsqrStreakRef.current = 0;
                scheduleNext(processFrame(state));
                return;
            }

            decodeInFlightRef.current = true;
            let detectedCodes: IDetectedBarcode[] = [];
            try {
                detectedCodes = await decodeMultiPass(videoEl);
            } finally {
                decodeInFlightRef.current = false;
            }

            const anyNewCodesDetected = detectedCodes.some((code) => !contentBefore.includes(code.rawValue));
            const currentScanHasContent = detectedCodes.length > 0;
            let lastOnScan = state.lastOnScan;
            const scanDelayPassed = timeNow - lastOnScan >= scanDelay;

            if (anyNewCodesDetected || (allowMultiple && currentScanHasContent && scanDelayPassed)) {
                if (sound && audioRef.current && audioRef.current.paused) {
                    audioRef.current.play().catch((error) => console.error('Error playing the sound', error));
                }
                lastOnScan = timeNow;
                onScan(detectedCodes);
            }

            if (currentScanHasContent) {
                onFound(detectedCodes);
            }

            if (!currentScanHasContent && lastScanHadContent) {
                onFound(detectedCodes);
            }

            const newState: IUseScannerState = {
                lastScan: timeNow,
                lastOnScan,
                lastScanHadContent: currentScanHasContent,
                contentBefore: anyNewCodesDetected ? detectedCodes.map((c) => c.rawValue) : contentBefore
            };

            scheduleNext(processFrame(newState));
        },
        [videoElementRef, onScan, onFound, retryDelay, scanDelay, allowMultiple, sound, decodeMultiPass, scheduleNext]
    );

    const startScanning = useCallback(() => {
        qrDebugLog('startScanning() called — decode loop arming');
        const current = performance.now();
        const initialState: IUseScannerState = {
            lastScan: current,
            lastOnScan: current,
            contentBefore: [],
            lastScanHadContent: false
        };
        scheduleNext(processFrame(initialState));
    }, [processFrame, scheduleNext]);

    const stopScanning = useCallback(() => {
        qrDebugLog('stopScanning() called — cancelling decode loop');
        cancelScheduled();
        // Physically disengage torch if we turned it on. Downstream face
        // recognition needs the camera with no LED flooding the subject.
        if (torchEngagedRef.current && onAutoTorch) {
            try {
                onAutoTorch(false);
            } catch {
                // Track may already be stopped — ignore.
            }
        }
        torchEngagedRef.current = false;
        lowLumStreakRef.current = 0;
        highLumStreakRef.current = 0;
        jsqrLastValueRef.current = null;
        jsqrStreakRef.current = 0;
        zxingMissStreakRef.current = 0;
        lastJsqrAttemptAtRef.current = 0;
    }, [onAutoTorch, cancelScheduled]);

    return {
        startScanning,
        stopScanning
    };
}
