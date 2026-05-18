import { useRef, useCallback, useEffect, RefObject } from 'react';

import jsQR from 'jsqr';

import { IDetectedBarcode, IUseScannerState, BarcodeFormat } from '../types';

import { base64Beep } from '../assets/base64Beep';

// Native BarcodeDetector is browser-provided (Chrome / Edge / Android WebView).
// We deliberately do NOT use the `barcode-detector` polyfill: its WASM payload
// is loaded from a jsDelivr CDN by default, which would break offline kiosks.
// On browsers without native support we fall back to jsQR (pure JS, bundled).
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
}

const LOW_LUMINANCE = 70;
const HIGH_LUMINANCE = 160;
const LOW_LUM_FRAMES_TO_ENGAGE = 20;
const HIGH_LUM_FRAMES_TO_DISENGAGE = 30;

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
        roi = 0.85,
        autoTorch = true
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

    useEffect(() => {
        if (typeof window !== 'undefined' && window.BarcodeDetector) {
            try {
                nativeDetectorRef.current = new window.BarcodeDetector({ formats });
            } catch {
                nativeDetectorRef.current = null;
            }
        } else {
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

            if (canvas.width !== cropW || canvas.height !== cropH) {
                canvas.width = cropW;
                canvas.height = cropH;
            }

            ctx.drawImage(videoEl, sx, sy, cropW, cropH, 0, 0, cropW, cropH);
            const img = ctx.getImageData(0, 0, cropW, cropH);
            const rgba = img.data;
            const gray = new Uint8ClampedArray(cropW * cropH);
            let lumaSum = 0;
            for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
                const y = (rgba[i] * 0.2126 + rgba[i + 1] * 0.7152 + rgba[i + 2] * 0.0722) | 0;
                gray[j] = y;
                lumaSum += y;
            }
            return { gray, width: cropW, height: cropH, meanLuma: lumaSum / gray.length };
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
            // Pass 1: native BarcodeDetector on the live video element. Hardware
            // accelerated when available, no CPU readback. Skipped entirely if
            // the browser lacks native support — we never fall back to a polyfill
            // that fetches WASM from a CDN.
            const native = nativeDetectorRef.current;
            if (native) {
                try {
                    const hits = await native.detect(videoEl);
                    if (hits.length > 0) return hits;
                } catch {
                    // detect() occasionally throws on torn frames; ignore and continue.
                }
            }

            // Pass 2..3: jsQR on a preprocessed greyscale frame. Pure JS, bundled,
            // works offline. Inversion attempts handle white-on-dark codes.
            const frame = grabFrame(videoEl);
            if (!frame) return [];
            updateAutoTorch(frame.meanLuma);

            const tryJsQr = (gray: Uint8ClampedArray): IDetectedBarcode[] => {
                const imgData = grayToImageData(gray, frame.width, frame.height);
                const res = jsQR(imgData.data, frame.width, frame.height, { inversionAttempts: 'attemptBoth' });
                if (!res) return [];
                return [
                    {
                        rawValue: res.data,
                        format: 'qr_code',
                        boundingBox: makeBoundingBoxFromLocation(res),
                        cornerPoints: [
                            { x: res.location.topLeftCorner.x, y: res.location.topLeftCorner.y },
                            { x: res.location.topRightCorner.x, y: res.location.topRightCorner.y },
                            { x: res.location.bottomRightCorner.x, y: res.location.bottomRightCorner.y },
                            { x: res.location.bottomLeftCorner.x, y: res.location.bottomLeftCorner.y }
                        ]
                    }
                ];
            };

            let hit = tryJsQr(frame.gray);
            if (hit.length > 0) return hit;

            const stretched = contrastStretch(frame.gray);
            hit = tryJsQr(stretched);
            if (hit.length > 0) return hit;

            return [];
        },
        [grabFrame, updateAutoTorch]
    );

    const processFrame = useCallback(
        (state: IUseScannerState) => async (timeNow: number) => {
            const videoEl = videoElementRef.current;
            if (videoEl === null || videoEl.readyState <= 1) {
                animationFrameIdRef.current = window.requestAnimationFrame(processFrame(state));
                return;
            }

            const { lastScan, contentBefore, lastScanHadContent } = state;

            if (retryDelay > 0 && timeNow - lastScan < retryDelay) {
                animationFrameIdRef.current = window.requestAnimationFrame(processFrame(state));
                return;
            }

            if (decodeInFlightRef.current) {
                animationFrameIdRef.current = window.requestAnimationFrame(processFrame(state));
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
    }, [onAutoTorch]);

    return {
        startScanning,
        stopScanning
    };
}
