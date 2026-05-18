export const defaultConstraints: MediaTrackConstraints = {
    facingMode: 'environment',
    width: { min: 640, ideal: 1280, max: 1920 },
    height: { min: 480, ideal: 960, max: 1440 },
    // Match the typical kiosk container (5:4) so `objectFit: cover` does
    // not have to crop the sides off a 16:9 frame to fill the viewport,
    // which used to look artificially zoomed in.
    aspectRatio: { ideal: 1.25 },
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
