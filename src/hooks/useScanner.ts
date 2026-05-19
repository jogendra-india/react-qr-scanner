import { useRef, useCallback, useEffect, RefObject } from 'react';

import jsQR from 'jsqr';

import {
    BarcodeDetector as PolyfillBarcodeDetector,
    setZXingModuleOverrides
} from 'barcode-detector/pure';

import { IDetectedBarcode, IUseScannerState, BarcodeFormat } from '../types';

import { base64Beep } from '../assets/base64Beep';

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

// Pre-warm the ZXing-WASM module at import time so the very first scan
// does not eat the WASM compile + engine-init cost (~10ms first call,
// <2ms subsequent). detect() is the cheapest call that triggers the
// internal lazy load; running it on a 16x16 throwaway canvas is enough.
// Errors are swallowed — if pre-warm fails the regular scan path will
// retry, and we do not want module init to throw and break the app.
if (typeof document !== 'undefined') {
    (async () => {
        try {
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
    // When true, the rAF loop keeps spinning (so the consumer can resume
    // instantly) but the per-frame decode is skipped. Camera stays live.
    // Use this while the consumer is busy with downstream work that needs
    // CPU and the live video stream (e.g. face recognition) but should not
    // be interrupted by a fresh QR callback.
    pauseDecoding?: boolean;
}

const LOW_LUMINANCE = 70;
const HIGH_LUMINANCE = 160;
const LOW_LUM_FRAMES_TO_ENGAGE = 20;
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

type JsQrResult = NonNullable<ReturnType<typeof jsQR>>;

function makeBoundingBoxFromLocation(loc: JsQrResult): DOMRectReadOnly {
    const xs = [
        loc.location.topLeftCorner.x,
        loc.location.topRightCorner.x,
        loc.location.bottomLeftCorner.x,
        loc.location.bottomRightCorner.x
    ];
    const ys = [
        loc.location.topLeftCorner.y,
        loc.location.topRightCorner.y,
        loc.location.bottomLeftCorner.y,
        loc.location.bottomRightCorner.y
    ];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const width = Math.max(...xs) - x;
    const height = Math.max(...ys) - y;
    return DOMRectReadOnly.fromRect({ x, y, width, height });
}

function contrastStretch(gray: Uint8ClampedArray): Uint8ClampedArray {
    let min = 255;
    let max = 0;
    for (let i = 0; i < gray.length; i += 4) {
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
    const animationFrameIdRef = useRef<number | null>(null);
    const decodeInFlightRef = useRef(false);

    const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const workCtxRef = useRef<CanvasRenderingContext2D | null>(null);

    const torchEngagedRef = useRef(false);
    const lowLumStreakRef = useRef(0);
    const highLumStreakRef = useRef(0);

    // jsQR confirmation buffer — last decode value and streak count.
    const jsqrLastValueRef = useRef<string | null>(null);
    const jsqrStreakRef = useRef(0);

    // Stuck-fallback gate. ZXing handles 99% of cases on its own and runs
    // ~10-20ms per frame, so we want every frame to be a ZXing attempt
    // (decoder saturates rAF at ~60fps). When ZXing misses
    // ZXING_MISS_BEFORE_JSQR frames in a row (~80ms of no detection while
    // the user is presenting a QR) we additionally run the jsQR passes as
    // a second-opinion catch. jsQR sometimes catches edge cases ZXing does
    // not (different finder pattern walk).
    //
    // At 1280x720 jsQR alone is ~120ms per frame which, if invoked every
    // frame, drags the whole decoder down to ~3 fps. To prevent the
    // stuck-fallback path from itself becoming the bottleneck we (a) cap
    // the jsQR working dimensions at JSQR_MAX_DIM (cheap downsample, ZXing
    // still uses the full-resolution video element), and (b) rate-limit
    // jsQR invocations to one per JSQR_MIN_INTERVAL_MS so ZXing keeps
    // running at near-full speed between jsQR attempts.
    const zxingMissStreakRef = useRef(0);
    const lastJsqrAttemptAtRef = useRef(0);
    const ZXING_MISS_BEFORE_JSQR = 5;
    const JSQR_MIN_INTERVAL_MS = 200;
    const JSQR_MAX_DIM = 640;

    // Ref-mirrored pauseDecoding so the long-lived rAF chain reads the
    // latest value without rebuilding the loop on every toggle.
    const pauseDecodingRef = useRef(pauseDecoding);
    useEffect(() => {
        pauseDecodingRef.current = pauseDecoding;
    }, [pauseDecoding]);

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
    }, [formats]);

    useEffect(() => {
        if (typeof window !== 'undefined' && sound) {
            audioRef.current = new Audio(typeof sound === 'string' ? sound : base64Beep);
        }
    }, [sound]);

    useEffect(() => {
        if (typeof document !== 'undefined') {
            const c = document.createElement('canvas');
            workCanvasRef.current = c;
            workCtxRef.current = c.getContext('2d', { willReadFrequently: true });
        }
    }, []);

    const grabFrame = useCallback(
        (videoEl: HTMLVideoElement): { gray: Uint8ClampedArray; width: number; height: number; meanLuma: number } | null => {
            const canvas = workCanvasRef.current;
            const ctx = workCtxRef.current;
            if (!canvas || !ctx) return null;

            const vw = videoEl.videoWidth;
            const vh = videoEl.videoHeight;
            if (vw === 0 || vh === 0) return null;

            const cropW = Math.floor(vw * roi);
            const cropH = Math.floor(vh * roi);
            const sx = Math.floor((vw - cropW) / 2);
            const sy = Math.floor((vh - cropH) / 2);

            // Downscale to JSQR_MAX_DIM on the longer edge if the camera is
            // running at HD or above. jsQR cost scales with pixel count, so
            // 1280x720 -> 640x360 is a ~4x speedup with negligible loss for
            // typical kiosk QR sizes. Cameras already capped at <= 640
            // (older USB / VGA) skip the scale and pass through unchanged.
            const longestEdge = Math.max(cropW, cropH);
            const scale = longestEdge > JSQR_MAX_DIM ? JSQR_MAX_DIM / longestEdge : 1;
            const outW = Math.max(1, Math.round(cropW * scale));
            const outH = Math.max(1, Math.round(cropH * scale));

            if (canvas.width !== outW || canvas.height !== outH) {
                canvas.width = outW;
                canvas.height = outH;
            }

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
        [roi]
    );

    const updateAutoTorch = useCallback(
        (meanLuma: number) => {
            if (!autoTorch || !onAutoTorch) return;
            if (meanLuma < LOW_LUMINANCE) {
                lowLumStreakRef.current++;
                highLumStreakRef.current = 0;
                if (!torchEngagedRef.current && lowLumStreakRef.current >= LOW_LUM_FRAMES_TO_ENGAGE) {
                    torchEngagedRef.current = true;
                    onAutoTorch(true);
                }
            } else if (meanLuma > HIGH_LUMINANCE) {
                highLumStreakRef.current++;
                lowLumStreakRef.current = 0;
                if (torchEngagedRef.current && highLumStreakRef.current >= HIGH_LUM_FRAMES_TO_DISENGAGE) {
                    torchEngagedRef.current = false;
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
            const passStart = performance.now();
            let nativeMissed = false;
            if (native) {
                const nativeStart = performance.now();
                try {
                    const hits = await native.detect(videoEl);
                    const nativeMs = performance.now() - nativeStart;
                    if (hits.length > 0) {
                        // Reset both miss streaks so the next ZXing miss does not
                        // immediately trigger the stuck-fallback path.
                        zxingMissStreakRef.current = 0;
                        // eslint-disable-next-line no-console
                        console.log(`[QR-fork] BarcodeDetector HIT in ${nativeMs.toFixed(1)}ms value="${hits[0].rawValue}" (video ${videoEl.videoWidth}x${videoEl.videoHeight})`);
                        return hits;
                    }
                    nativeMissed = true;
                    zxingMissStreakRef.current++;
                    // eslint-disable-next-line no-console
                    console.log(`[QR-fork] BarcodeDetector miss in ${nativeMs.toFixed(1)}ms (video ${videoEl.videoWidth}x${videoEl.videoHeight}) streak=${zxingMissStreakRef.current}`);
                } catch (err) {
                    const nativeMs = performance.now() - nativeStart;
                    nativeMissed = true;
                    zxingMissStreakRef.current++;
                    // eslint-disable-next-line no-console
                    console.log(`[QR-fork] BarcodeDetector threw in ${nativeMs.toFixed(1)}ms`, err);
                    // detect() occasionally throws on torn frames; ignore and continue.
                }
            } else {
                // eslint-disable-next-line no-console
                console.log('[QR-fork] BarcodeDetector unavailable -> jsQR fallback only');
            }

            // When ZXing is the active path, the per-frame jsQR work is the
            // dominant cost (even after downsampling — still ~25ms). Two
            // gates: (a) miss streak must reach ZXING_MISS_BEFORE_JSQR
            // before jsQR is allowed to run at all, and (b) once unlocked
            // jsQR runs at most once per JSQR_MIN_INTERVAL_MS so ZXing keeps
            // ticking at near-rAF cadence between attempts. Without (b) a
            // long miss streak would pin the decoder to jsQR's frame budget.
            if (native && nativeMissed) {
                if (zxingMissStreakRef.current < ZXING_MISS_BEFORE_JSQR) {
                    return [];
                }
                const nowTs = performance.now();
                if (nowTs - lastJsqrAttemptAtRef.current < JSQR_MIN_INTERVAL_MS) {
                    return [];
                }
                lastJsqrAttemptAtRef.current = nowTs;
            }

            // Pass 2..3: jsQR on a preprocessed greyscale frame. Pure JS,
            // bundled, works offline. Inversion attempts handle white-on-dark
            // codes. Hit here is logged with the ZXing miss streak that
            // unlocked it for diagnostics.
            const grabStart = performance.now();
            const frame = grabFrame(videoEl);
            const grabMs = performance.now() - grabStart;
            if (!frame) {
                // eslint-disable-next-line no-console
                console.log(`[QR-fork] grabFrame returned null in ${grabMs.toFixed(1)}ms`);
                return [];
            }
            updateAutoTorch(frame.meanLuma);

            const tryJsQr = (gray: Uint8ClampedArray, label: string): string | null => {
                const t0 = performance.now();
                const imgData = grayToImageData(gray, frame.width, frame.height);
                const res = jsQR(imgData.data, frame.width, frame.height, { inversionAttempts: 'attemptBoth' });
                const ms = performance.now() - t0;
                if (!res) {
                    // eslint-disable-next-line no-console
                    console.log(`[QR-fork] jsQR-${label} miss ${frame.width}x${frame.height} in ${ms.toFixed(1)}ms (luma ${frame.meanLuma.toFixed(0)})`);
                    return null;
                }
                const v = res.data;
                if (!v || v.length < MIN_PAYLOAD_LEN) {
                    // eslint-disable-next-line no-console
                    console.log(`[QR-fork] jsQR-${label} too short "${v}" len=${v ? v.length : 0} in ${ms.toFixed(1)}ms`);
                    return null;
                }
                // eslint-disable-next-line no-console
                console.log(`[QR-fork] jsQR-${label} HIT "${v}" ${frame.width}x${frame.height} in ${ms.toFixed(1)}ms`);
                return v;
            };

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

            let value = tryJsQr(frame.gray, 'gray');
            if (!value) {
                const stretched = contrastStretch(frame.gray);
                value = tryJsQr(stretched, 'stretched');
            }

            const totalMs = performance.now() - passStart;
            if (value === null) {
                // No hit — reset confirmation streak.
                jsqrLastValueRef.current = null;
                jsqrStreakRef.current = 0;
                // eslint-disable-next-line no-console
                console.log(`[QR-fork] decode total ${totalMs.toFixed(1)}ms grabFrame=${grabMs.toFixed(1)}ms NO_HIT`);
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
                // eslint-disable-next-line no-console
                console.log(`[QR-fork] decode total ${totalMs.toFixed(1)}ms streak=${jsqrStreakRef.current}/${JSQR_CONFIRM_FRAMES} GATED`);
                return [];
            }

            // Successful jsQR hit through the stuck-fallback path: reset the
            // ZXing miss streak so we go back to ZXing-only decoding next
            // frame and do not keep paying the jsQR cost.
            zxingMissStreakRef.current = 0;
            // eslint-disable-next-line no-console
            console.log(`[QR-fork] decode total ${totalMs.toFixed(1)}ms FIRE value="${value}" (via jsQR stuck-fallback)`);
            return [buildBarcode(value)];
        },
        [grabFrame, updateAutoTorch]
    );

    const processFrame = useCallback(
        (state: IUseScannerState) => async (timeNow: number) => {
            const videoEl = videoElementRef.current;
            if (videoEl === null || videoEl.readyState <= 1) {
                // eslint-disable-next-line no-console
                console.log(`[QR-fork] frame skip: video not ready (readyState=${videoEl ? videoEl.readyState : 'null'})`);
                animationFrameIdRef.current = window.requestAnimationFrame(processFrame(state));
                return;
            }

            const { lastScan, contentBefore, lastScanHadContent } = state;

            if (retryDelay > 0 && timeNow - lastScan < retryDelay) {
                animationFrameIdRef.current = window.requestAnimationFrame(processFrame(state));
                return;
            }

            if (decodeInFlightRef.current) {
                // eslint-disable-next-line no-console
                console.log('[QR-fork] frame skip: decode in flight');
                animationFrameIdRef.current = window.requestAnimationFrame(processFrame(state));
                return;
            }

            if (pauseDecodingRef.current) {
                // Reset the jsQR confirmation streak while paused so that a
                // resume on the SAME stale code does not immediately fire.
                jsqrLastValueRef.current = null;
                jsqrStreakRef.current = 0;
                animationFrameIdRef.current = window.requestAnimationFrame(processFrame(state));
                return;
            }

            const sinceLast = timeNow - lastScan;
            decodeInFlightRef.current = true;
            let detectedCodes: IDetectedBarcode[] = [];
            const decodeStart = performance.now();
            try {
                detectedCodes = await decodeMultiPass(videoEl);
            } finally {
                decodeInFlightRef.current = false;
            }
            const decodeWallMs = performance.now() - decodeStart;
            if (decodeWallMs > 50) {
                // eslint-disable-next-line no-console
                console.log(`[QR-fork] frame decode wall=${decodeWallMs.toFixed(1)}ms gap-since-prev=${sinceLast.toFixed(1)}ms hits=${detectedCodes.length}`);
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

            animationFrameIdRef.current = window.requestAnimationFrame(processFrame(newState));
        },
        [videoElementRef, onScan, onFound, retryDelay, scanDelay, allowMultiple, sound, decodeMultiPass]
    );

    const startScanning = useCallback(() => {
        const current = performance.now();
        const initialState: IUseScannerState = {
            lastScan: current,
            lastOnScan: current,
            contentBefore: [],
            lastScanHadContent: false
        };
        animationFrameIdRef.current = window.requestAnimationFrame(processFrame(initialState));
    }, [processFrame]);

    const stopScanning = useCallback(() => {
        if (animationFrameIdRef.current !== null) {
            window.cancelAnimationFrame(animationFrameIdRef.current);
            animationFrameIdRef.current = null;
        }
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
    }, [onAutoTorch]);

    return {
        startScanning,
        stopScanning
    };
}
