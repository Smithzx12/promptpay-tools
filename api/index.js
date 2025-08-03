const express = require('express');
const app = express();
const QRcode = require('qrcode');
const generatePayload = require('promptpay-qr');
const bodyParser = require('body-parser');
const _ = require('lodash');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const Tesseract = require('tesseract.js');
const fs = require('fs');

// Middleware
app.use(cors({ origin: '*' })); // อนุญาตทุก origin (ปรับได้ตามความปลอดภัย)
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Ensure uploads directory exists
const uploadDir = 'uploads/';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// File upload configuration
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
    fileFilter: function (req, file, cb) {
        const filetypes = /jpeg|jpg|png/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);
        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error('ไฟล์ต้องเป็นรูปภาพ (jpg, jpeg, png) เท่านั้น'));
    }
});

// Generate QR Code
app.post('/generateQR', (req, res) => {
    console.log('Received /generateQR request:', req.body);
    const amount = parseFloat(_.get(req, ['body', 'amount']));
    let gWalletId = _.get(req, ['body', 'gWalletId'], '').trim();

    // Clean gWalletId
    gWalletId = gWalletId.replace(/[\s-]/g, '');

    // Validate gWalletId
    const isGWallet = /^14000\d{10}$/.test(gWalletId);
    const isPhone = /^0\d{9}$/.test(gWalletId);
    
    if (!gWalletId || (!isGWallet && !isPhone)) {
        console.log('Invalid gWalletId:', gWalletId);
        return res.status(400).json({
            RespCode: 400,
            RespMessage: 'G-Wallet ID หรือ เบอร์ PromptPay ไม่ถูกต้อง (ต้องเป็นเบอร์มือถือ 10 หลัก หรือ G-Wallet ID 15 หลักเริ่มต้นด้วย 14000)'
        });
    }

    // Validate amount
    if (!isNaN(amount) && amount < 0) {
        console.log('Invalid amount:', amount);
        return res.status(400).json({
            RespCode: 400,
            RespMessage: 'จำนวนเงินต้องมากกว่าหรือเท่ากับ 0'
        });
    }

    try {
        const payload = generatePayload(gWalletId, amount ? { amount } : {});
        const option = {
            color: {
                dark: '#000',
                light: '#fff'
            }
        };
        QRcode.toDataURL(payload, option, (err, url) => {
            if (err) {
                console.error('QR Code generation error:', err);
                return res.status(500).json({
                    RespCode: 500,
                    RespMessage: 'เกิดข้อผิดพลาดในการสร้าง QR Code: ' + err.message
                });
            }
            return res.status(200).json({
                RespCode: 200,
                RespMessage: 'success',
                Result: url
            });
        });
    } catch (err) {
        console.error('Payload generation error:', err);
        return res.status(500).json({
            RespCode: 500,
            RespMessage: 'เกิดข้อผิดพลาดในการประมวลผล: ' + err.message
        });
    }
});

// Upload and process slip
app.post('/upload-slip', upload.single('slip'), async (req, res) => {
    console.log('Received /upload-slip request:', req.file, req.body);
    const debug = req.body.debug === 'true' || req.query.debug === 'true';
    let gWalletId = _.get(req, ['body', 'gWalletId'], '').trim();

    if (!req.file) {
        return res.status(400).json({
            status: 'fail',
            message: 'กรุณาเลือกไฟล์สลิป'
        });
    }

    // Clean gWalletId
    gWalletId = gWalletId.replace(/[\s-]/g, '');

    // Validate gWalletId
    const isGWallet = /^14000\d{10}$/.test(gWalletId);
    const isPhone = /^0\d{9}$/.test(gWalletId);
    if (!gWalletId || (!isGWallet && !isPhone)) {
        console.log('Invalid gWalletId for slip:', gWalletId);
        fs.unlink(req.file.path, (err) => {
            if (err) console.error('Error deleting file:', err);
        });
        return res.status(400).json({
            status: 'fail',
            message: 'G-Wallet ID หรือ เบอร์ PromptPay ไม่ถูกต้อง (ต้องเป็นเบอร์มือถือ 10 หลัก หรือ G-Wallet ID 15 หลักเริ่มต้นด้วย 14000)'
        });
    }

    try {
        const result = await Tesseract.recognize(
            req.file.path,
            'tha+eng',
            { logger: m => debug && console.log(m) }
        );
        const text = result.data.text;
        if (debug) console.log('OCR TEXT:', text);

        // Check for G-Wallet ID
        const regexWalletMask = /140-([xX\d]{8,9})-7315/;
        const regexWalletFull = /140-?\d{9}-?7315/;
        const regexWalletFullNoDash = /140\d{9}7315/;
        const regexWallet4Dash = /14000-\d{3}-\d{3}-\d{4}/;
        const regexWallet15 = /14000\d{10}/;

        let foundWallet =
            regexWalletMask.test(text) ||
            regexWalletFull.test(text) ||
            regexWalletFullNoDash.test(text) ||
            regexWallet4Dash.test(text) ||
            regexWallet15.test(text) ||
            text.replace(/[\s-]/g, '').includes(gWalletId);

        // Check for amount
        let regexAmount = /([0-9]+(?:\.[0-9]{1,2})?)\s*(บาท|THB)/i;
        let foundAmount = text.match(regexAmount);

        if (!foundAmount) {
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const amt = lines[i].match(/([0-9]+(?:\.[0-9]{1,2})?)\s*(บาท|THB)/i);
                if (amt) {
                    foundAmount = [null, amt[1]];
                    break;
                }
            }
        }

        // Clean up uploaded file
        fs.unlink(req.file.path, (err) => {
            if (err) console.error('Error deleting file:', err);
        });

        if (foundWallet && foundAmount && parseFloat(foundAmount[1]) > 0) {
            const amount = parseFloat(foundAmount[1]);
            return res.json({
                status: 'success',
                message: `🎉 ตรวจสอบสลิปผ่าน: พบ G-Wallet ID และยอดเงิน ${amount.toFixed(2)} บาท`,
                debug: debug ? { ocr: text, wallet: foundWallet, amount: amount } : undefined
            });
        } else if (!foundWallet) {
            return res.json({
                status: 'fail',
                message: `😕 ไม่พบ G-Wallet ID หรือ เบอร์ PromptPay (${gWalletId}) ในสลิป`,
                debug: debug ? { ocr: text } : undefined
            });
        } else {
            return res.json({
                status: 'fail',
                message: '😞 ไม่พบยอดเงินในสลิป',
                debug: debug ? { ocr: text } : undefined
            });
        }
    } catch (err) {
        console.error('OCR error:', err);
        fs.unlink(req.file.path, (err) => {
            if (err) console.error('Error deleting file:', err);
        });
        return res.status(500).json({
            status: 'fail',
            message: '😵 เกิดข้อผิดพลาดในการอ่านสลิป: ' + err.message
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', message: 'API พร้อมใช้งาน! 🚀' });
});

// Start server with dynamic port
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`🎉 Server is running on port ${port}...`);
});

module.exports = app;