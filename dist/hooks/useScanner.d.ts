import { RefObject } from 'react';
import { IDetectedBarcode, BarcodeFormat } from '../types';
declare global {
    interface Window {
        BarcodeDetector?: {
            new (options?: {
                formats?: BarcodeFormat[];
            }): {
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
export default function useScanner(props: IUseScannerProps): {
    startScanning: () => void;
    stopScanning: () => void;
};
export {};
//# sourceMappingURL=useScanner.d.ts.map