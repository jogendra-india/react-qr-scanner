import { useRef, useCallback, useEffect, RefObject } from 'react';

import { type DetectedBarcode, type BarcodeFormat, BarcodeDetector } from 'barcode-detector';
import jsQR from 'jsqr';

import { IUseScannerState } from '../types';

import { base64Beep } from '../assets/base64Beep';

interface IUseScannerProps {
    videoElementRef: RefObject<HTMLVideoElement | null>;
    onScan: (result: DetectedBarcode[]) => void;
    onFound: (result: DetectedBarcode[]) => void;
    onAutoTorch?: (engage: boolean) => void;
    formats?: BarcodeFormat[];
    sound?: boolean | string;
    allowMultiple?: boolean;
    retryDelay?: number;
    scanDelay?: number;
    roi?: number;
    autoTorch?: boolean;
}

// Threshold tuning — chosen on real kiosk footage.
const LOW_LUMINANCE = 70;
const HIGH_LUMINANCE = 160;
const LOW_LUM_FRAMES_TO_ENGAGE = 20;
const HIGH_LUM_FRAMES_TO_DISENGAGE = 30;

function makeBoundingBoxFromLocation(loc: ReturnType<typeof jsQR>): DOMRectReadOnly {
    if (loc === null) return DOMRectReadOnly.fromRect({ x: 0, y: 0, width: 0, height: 0 });
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
    // Sample stride 4 for speed — full pass on 1080p is wasteful.
    for (let i = 0; i < gray.length; i += 4) {
        const v = gray[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }
    const range = max - min;
    if (range < 10) return gray; // flat frame, nothing to stretch
    const scale = 255 / range;
    const out = new Uint8ClampedArray(gray.length);
    for (let i = 0; i < gray.length; i++) {
        out[i] = Math.max(0, Math.min(255, (gray[i] - min) * scale));
    }
    return out;
}

// Build RGBA ImageData from a single-channel grayscale buffer.
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
        formats = [],
        allowMultiple = false,
        sound = true,
        roi = 0.85,
        autoTorch = true
    }: IUseScannerProps = props;

    const barcodeDetectorRef = useRef(new BarcodeDetector({ formats }));
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const animationFrameIdRef = useRef<number | null>(null);
    const decodeInFlightRef = useRef(false);

    // Reusable canvas for preprocessing — avoids GC churn.
    const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const workCtxRef = useRef<CanvasRenderingContext2D | null>(null);

    // Auto-torch state.
    const torchEngagedRef = useRef(false);
    const lowLumStreakRef = useRef(0);
    const highLumStreakRef = useRef(0);

    useEffect(() => {
        barcodeDetectorRef.current = new BarcodeDetector({ formats });
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
            // willReadFrequently hints the browser to allocate readback-friendly buffer.
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

            // Center ROI crop at native resolution.
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
            // Rec. 709 luma — same coefficients ZBar uses internally.
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
        async (videoEl: HTMLVideoElement): Promise<DetectedBarcode[]> => {
            // Pass 1: native BarcodeDetector on the live video element — fastest path,
            // uses the platform decoder (GPU-accelerated on Chrome/Android).
            try {
                const native = await barcodeDetectorRef.current.detect(videoEl);
                if (native.length > 0) return native;
            } catch {
                // Detector occasionally throws on torn frames; swallow and continue.
            }

            // Pass 2..4: pull a frame, run jsQR with progressively more aggressive
            // preprocessing. jsQR catches what BarcodeDetector misses in dim / low-contrast frames.
            const frame = grabFrame(videoEl);
            if (!frame) return [];
            updateAutoTorch(frame.meanLuma);

            const tryJsQr = (gray: Uint8ClampedArray): DetectedBarcode[] => {
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
                    } as DetectedBarcode
                ];
            };

            // Raw grayscale.
            let hit = tryJsQr(frame.gray);
            if (hit.length > 0) return hit;

            // Contrast-stretched — recovers dim / washed-out frames.
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

            // Throttle gate. retryDelay=0 means RAF natural pacing.
            if (retryDelay > 0 && timeNow - lastScan < retryDelay) {
                animationFrameIdRef.current = window.requestAnimationFrame(processFrame(state));
                return;
            }

            // In-flight gate — never queue decodes, skip frames if previous still running.
            if (decodeInFlightRef.current) {
                animationFrameIdRef.current = window.requestAnimationFrame(processFrame(state));
                return;
            }

            decodeInFlightRef.current = true;
            let detectedCodes: DetectedBarcode[] = [];
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
        // Reset auto-torch state so next session starts clean.
        torchEngagedRef.current = false;
        lowLumStreakRef.current = 0;
        highLumStreakRef.current = 0;
    }, []);

    return {
        startScanning,
        stopScanning
    };
}
