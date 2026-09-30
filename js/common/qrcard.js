import QRCode from 'qrcode';

const QR_OPTIONS = { margin: 2, errorCorrectionLevel: 'H', color: { dark: '#18211d', light: '#ffffff' } };

/**
 * Draw a QR on a canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {string} token
 * @param {number} [width]
 */
export const drawQr = (canvas, token, width = 280) => QRCode.toCanvas(canvas, token, { ...QR_OPTIONS, width });

function fitText(ctx, text, maxWidth, startPx, minPx, weight) {
    for (let px = startPx; px >= minPx; px -= 1) {
        ctx.font = `${weight} ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
        if (ctx.measureText(text).width <= maxWidth) {return text;}
    }
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) {t = t.slice(0, -1);}
    return `${t}…`;
}

/**
 * QR + guest name on a white card (for PNG download, ZIP and the printed sheet).
 * @param {string} token
 * @param {{ name: string, subtitle?: string, size?: number }} opts
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderCard(token, { name, subtitle = '', size = 360 }) {
    const qr = document.createElement('canvas');
    await QRCode.toCanvas(qr, token, { ...QR_OPTIONS, width: size });

    const pad = 24;
    const textH = subtitle ? 92 : 64;
    const canvas = document.createElement('canvas');
    canvas.width = size + pad * 2;
    canvas.height = size + pad + textH;

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(qr, pad, pad);

    ctx.fillStyle = '#18211d';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const maxW = canvas.width - pad * 2;
    const title = fitText(ctx, name, maxW, 28, 14, '700');
    ctx.fillText(title, canvas.width / 2, size + pad + 34);
    if (subtitle) {
        ctx.fillStyle = '#5c6660';
        const sub = fitText(ctx, subtitle, maxW, 18, 11, '400');
        ctx.fillText(sub, canvas.width / 2, size + pad + 64);
    }
    return canvas;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {Uint8Array} PNG bytes
 */
export function canvasToBytes(canvas) {
    const b64 = canvas.toDataURL('image/png').split(',')[1];
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {out[i] = bin.charCodeAt(i);}
    return out;
}

/**
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}
