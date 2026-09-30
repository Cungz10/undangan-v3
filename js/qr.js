import QRCode from 'qrcode';

if (typeof window !== 'undefined') {
    window.QRCode = QRCode;
}

export default QRCode;
