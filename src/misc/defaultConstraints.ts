export const defaultConstraints: MediaTrackConstraints = {
    facingMode: 'environment',
    width: { min: 640, ideal: 1920, max: 3840 },
    height: { min: 480, ideal: 1080, max: 2160 },
    frameRate: { ideal: 30, min: 15 },
    // Continuous modes give the browser license to keep adjusting in
    // variable lighting / focus distance. Wrapped in `advanced` so
    // browsers / hardware that lack a given capability silently ignore
    // the entry instead of failing the whole getUserMedia call.
    advanced: [
        { focusMode: 'continuous' } as MediaTrackConstraintSet,
        { exposureMode: 'continuous' } as MediaTrackConstraintSet,
        { whiteBalanceMode: 'continuous' } as MediaTrackConstraintSet
    ]
};
