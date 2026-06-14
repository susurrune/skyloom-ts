/**
 * Terminal QR rendering — a thin, dependency-isolated wrapper over
 * qrcode-terminal (single file, zero transitive deps). Returns the QR as a
 * string so callers control where it's written (and so it's testable).
 */

// qrcode-terminal ships no types; declare the tiny surface we use.
const qrcode: { generate: (text: string, opts: { small?: boolean }, cb: (s: string) => void) => void } =
  require('qrcode-terminal');

/** Render `text` as a scannable QR code (compact) into a string. */
export function renderQR(text: string): string {
  let out = '';
  try {
    qrcode.generate(text, { small: true }, (s: string) => { out = s; });
  } catch {
    return '';
  }
  return out;
}
