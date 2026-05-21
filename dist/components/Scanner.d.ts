import React, { ReactNode } from 'react';
import { BarcodeFormat, IDetectedBarcode, IScannerClassNames, IScannerComponents, IScannerStyles } from '../types';
export interface IScannerProps {
    onScan: (detectedCodes: IDetectedBarcode[]) => void;
    onError?: (error: unknown) => void;
    constraints?: MediaTrackConstraints;
    formats?: BarcodeFormat[];
    paused?: boolean;
    pauseDecoding?: boolean;
    children?: ReactNode;
    components?: IScannerComponents;
    styles?: IScannerStyles;
    classNames?: IScannerClassNames;
    allowMultiple?: boolean;
    scanDelay?: number;
    sound?: boolean | string;
}
export declare function Scanner(props: IScannerProps): React.JSX.Element;
//# sourceMappingURL=Scanner.d.ts.map