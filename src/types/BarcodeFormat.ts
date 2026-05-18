// Mirrors the standard BarcodeDetector API format strings.
// Local type avoids pulling the `barcode-detector` runtime dep, which
// ships a polyfill that fetches WASM from a CDN (breaks offline kiosks).
export type BarcodeFormat =
    | 'aztec'
    | 'code_128'
    | 'code_39'
    | 'code_93'
    | 'codabar'
    | 'data_matrix'
    | 'ean_13'
    | 'ean_8'
    | 'itf'
    | 'pdf417'
    | 'qr_code'
    | 'upc_a'
    | 'upc_e'
    | 'unknown';
