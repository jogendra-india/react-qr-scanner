import { IScannerStyles } from '../types';

export const defaultStyles: IScannerStyles = {
    container: {
        width: '100%',
        height: '100%',
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        aspectRatio: '1/1'
    },
    video: {
        width: '100%',
        height: '100%',
        // `contain` shows the full camera frame (possible letterbox) so the
        // image is not artificially zoomed/cropped. ROI cropping happens
        // inside the decoder; the displayed feed stays true to the sensor.
        objectFit: 'contain',
        overflow: 'hidden'
    }
};
