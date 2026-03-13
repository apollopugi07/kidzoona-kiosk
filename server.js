const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const { SerialPort, ReadlineParser } = require('serialport'); 
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

const arduinoPort = new SerialPort({
    path: '/dev/ttyACM0', 
    baudRate: 9600 
});

const parser = arduinoPort.pipe(new ReadlineParser({ delimiter: '\r\n' }));

let paymentResolver = null;
let currentPaidAmount = 0; 

parser.on('data', (data) => {
    console.log('⚡ Arduino says:', data);
    
    if (data.includes("PAID:")) {
        const parts = data.split(':');
        if (parts.length > 1) {
            currentPaidAmount = parseInt(parts[1]); 
        }
    }

    if (data.includes("PAYMENT_COMPLETE") || data.includes("No socks ordered")) {
        if (paymentResolver) {
            paymentResolver(); 
            paymentResolver = null;
        }
    }
});

const InventorySchema = new mongoose.Schema({
    kids: { type: Number, default: 0 },
    adult: { type: Number, default: 0 }
});
const Inventory = mongoose.model('Inventory', InventorySchema);

const RegistrationSchema = new mongoose.Schema({
    registrationDate: { type: Date, default: Date.now },
    checkoutDate: { type: Date },
    ticketNumber: Number, 
    childCount: Number,
    adultCount: Number,
    children: [{ name: String, age: String, gender: String }],
    guardians: [{ name: String, phone: String }],
    playtimeRate: Number, 
    playtimeHours: Number, 
    socks: { kidsQty: Number, adultsQty: Number, totalPrice: Number },
    guardianFee: Number, 
    excessGuardians: Number, 
    voucherCode: { type: String, default: '' },
    discountApplied: { type: Number, default: 0 },
    guardianVoucherCode: { type: String, default: '' }, 
    guardianDiscountApplied: { type: Number, default: 0 },
    discountType: { type: String, default: '' }, 
    discountIdNumber: { type: String, default: '' },
    grandTotal: Number, 
    overtimeFee: { type: Number, default: 0 }, 
    checkoutBy: { type: String, default: 'Admin' }, 
    status: { type: String, default: 'active' },
    isWarned: { type: Boolean, default: false }, 
    isTimeUp: { type: Boolean, default: false }  
});
const Registration = mongoose.model('Registration', RegistrationSchema);

const VoucherSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true },
    idType: { type: String, default: 'PWD' },
    idNumber: { type: String, default: '' },
    childDiscount: { type: Number, default: 0 },
    childPax: { type: Number, default: 0 },
    guardianDiscount: { type: Number, default: 0 },
    guardianPax: { type: Number, default: 0 }
});
const Voucher = mongoose.model('Voucher', VoucherSchema);

const SettingsSchema = new mongoose.Schema({
    rate1hr: { type: Number, default: 250 },
    rate2hr: { type: Number, default: 350 },
    rate3hr: { type: Number, default: 350 },
    defaultDiscount: { type: Number, default: 20 },
    staffPassword: { type: String, default: "admin" }, 
    staffAccounts: [{ 
        name: String, 
        pin: String,
        email: String,
        phone: String,
        age: String,
        address: String
    }],
    rulesText: { type: String, default: "1. Children aged 12 years old and below are eligible to play.\n2. Exact Amount Only: The machine does not provide change.\n3. Socks must be worn inside the playground at all times.\n4. Guardians must supervise their children." }
});
const Settings = mongoose.model('Settings', SettingsSchema);

mongoose.connect('mongodb+srv://kidzoona:DBK900@cluster0.vl7q5ac.mongodb.net/kidzoona_db?appName=Cluster0', {})
  .then(async () => {
      console.log("✅ Connected to MongoDB");
      
      const invCount = await Inventory.countDocuments();
      if (invCount === 0) {
          await new Inventory({ kids: 0, adult: 0 }).save();
          console.log("📦 Initialized Inventory Database");
      }

      const setCount = await Settings.countDocuments();
      if (setCount === 0) {
          await new Settings({}).save();
          console.log("⚙️ Initialized Settings Database");
      }

      scheduleNextBackup();
  })
  .catch(err => console.error("❌ MongoDB Connection Error:", err));


app.get('/api/lan-ip', (req, res) => {
    const nets = os.networkInterfaces();
    let lanIp = '192.168.1.10'; 
    
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                lanIp = net.address;
            }
        }
    }
    res.json({ ip: lanIp });
});

app.post('/api/announce', async (req, res) => {
    const { id, type, text } = req.body;

    try {
        if (type === 'warn') {
            await Registration.findByIdAndUpdate(id, { isWarned: true });
        } else if (type === 'timeup') {
            await Registration.findByIdAndUpdate(id, { isTimeUp: true });
        }
    } catch (err) {
        console.error("Failed to update flag", err);
    }

    const safeText = (text || "").replace(/["$`/\\|]/g, "");
    console.log(`🔊 Real-time Audio (Piper): "${safeText}"`);

    const piperPath = "/home/kidzoona/.local/bin/piper";
    const modelPath = "/home/kidzoona/piper/en_US-amy-medium.onnx";
 const command = `echo "${safeText}" | ${piperPath} --model ${modelPath} --output_file - | paplay`;
    exec(command, (error) => {
        if (error) { 
            console.error("Audio Error:", error); 
        }
    });

    res.json({ success: true });
});

app.get('/api/payment-status', (req, res) => {
    res.json({ paid: currentPaidAmount });
});

app.get('/api/settings', async (req, res) => {
    try {
        const settings = await Settings.findOne();
        res.json(settings || { rate1hr: 250, rate2hr: 350, rate3hr: 350, rulesText: "No rules configured." });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch settings" });
    }
});

app.get('/api/inventory', async (req, res) => {
    try {
        const stock = await Inventory.findOne();
        res.json(stock || { kids: 0, adult: 0 });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch inventory" });
    }
});

app.post('/api/inventory/update', async (req, res) => {
    const { type, action, amount } = req.body;
    try {
        const stock = await Inventory.findOne();
        if (!stock) return res.status(404).json({ error: "Inventory not found" });

        if (action === 'add') {
            if (stock[type] + amount > 10) return res.status(400).json({ error: "Capacity exceeded (Max 10)" });
            stock[type] += amount;
        } else if (action === 'remove') {
            if (stock[type] - amount < 0) return res.status(400).json({ error: "Not enough stock" });
            stock[type] -= amount;
        }

        await stock.save();
        res.json({ success: true, stock });
    } catch (error) {
        res.status(500).json({ error: "Update failed" });
    }
});

app.post('/api/verify-voucher', async (req, res) => {
    try {
        const { code } = req.body;
        const voucher = await Voucher.findOne({ code: code.toUpperCase() });
        if (voucher) {
            res.json({ 
                success: true, 
                childDiscount: voucher.childDiscount, 
                childPax: voucher.childPax,
                guardianDiscount: voucher.guardianDiscount,
                guardianPax: voucher.guardianPax,
                idType: voucher.idType,
                idNumber: voucher.idNumber
            }); 
        } else {
            res.json({ success: false, message: "Invalid Code" });
        }
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/register', async (req, res) => {
    try {
        console.log("📥 Receiving Registration Data:", req.body); 
        currentPaidAmount = 0; 

        const kidsSocksReq = req.body.socks?.kidsQty || 0;
        const adultSocksReq = req.body.socks?.adultsQty || 0;
        let stock = null;

        if (kidsSocksReq > 0 || adultSocksReq > 0) {
            stock = await Inventory.findOne();
            if (!stock || stock.kids < kidsSocksReq || stock.adult < adultSocksReq) {
                return res.status(400).json({ success: false, message: "Out of Stock! Cannot register." });
            }
        }

        const totalAmount = parseFloat(req.body.grandTotal); 
        const totalPulses = Math.ceil(totalAmount / 10);

        let command = "";
        if (adultSocksReq > 0 && kidsSocksReq > 0) command = `B${adultSocksReq},${kidsSocksReq}#${totalPulses}\n`;
        else if (adultSocksReq > 0) command = `A${adultSocksReq}#${totalPulses}\n`;
        else if (kidsSocksReq > 0) command = `C${kidsSocksReq}#${totalPulses}\n`;
        else command = `N0#${totalPulses}\n`; 

        console.log(`[HARDWARE] Sending Command to Arduino: ${command.trim()}`);
        
        const result = await new Promise((resolve) => {
            paymentResolver = resolve; 
            arduinoPort.write(command, (err) => {
                if (err) console.error('Error writing to Arduino:', err);
            });
        });

        if (result && result.cancelled) {
            console.log("[HARDWARE] ❌ Payment aborted. Registration discarded.");
            return res.status(400).json({ success: false, message: "Transaction Cancelled." });
        }

        console.log("[HARDWARE] 💰 Payment Confirmed!");

        if (stock) {
            stock.kids -= kidsSocksReq;
            stock.adult -= adultSocksReq;
            await stock.save();
            console.log("📉 Stock Deducted.");
        }

        if (req.body.voucherCode) {
            await Voucher.findOneAndDelete({ code: req.body.voucherCode.toUpperCase() });
        }

        const lastReg = await Registration.findOne().sort({ ticketNumber: -1 });
        const nextTicket = (lastReg && lastReg.ticketNumber) ? lastReg.ticketNumber + 1 : 1;

        const newReg = new Registration({ ...req.body, ticketNumber: nextTicket });
        const savedReg = await newReg.save();
        
        console.log("✅ Saved to Database. Ticket:", nextTicket);
        res.status(201).json({ success: true, id: savedReg._id, ticketNumber: nextTicket });

    } catch (error) {
        console.error("❌ Error:", error);
        res.status(500).json({ success: false, message: "Server Registration Error" });
    }
});

app.get('/receipt', async (req, res) => {
    try {
        const id = req.query.id;
        if (!id) return res.status(400).send("Invalid Receipt ID");

        const reg = await Registration.findById(id);
        if (!reg) return res.status(404).send("Receipt not found");

        const dateStr = new Date(reg.registrationDate).toLocaleString();
        
        let durationMinutes = (reg.playtimeHours || 1) * 60; 

        const startTime = new Date(reg.registrationDate);
        const exitTime = new Date(startTime.getTime() + durationMinutes * 60000);
        const exitTimeStr = exitTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        
        let discountHtml = '';
        if (reg.discountApplied && reg.discountApplied > 0) {
            discountHtml += `
            <div class="item" style="color: #D32F2F; background: #FFEBEE; padding: 5px; border-radius: 5px; margin-top: 5px;">
                <span>Discount (Child)</span>
                <span style="font-weight:bold;">- ₱${reg.discountApplied.toFixed(2)}</span>
            </div>`;
        }
        if (reg.guardianDiscountApplied && reg.guardianDiscountApplied > 0) {
            discountHtml += `
            <div class="item" style="color: #D32F2F; background: #F3E5F5; padding: 5px; border-radius: 5px; margin-top: 5px;">
                <span>Discount (Guardian)</span>
                <span style="font-weight:bold;">- ₱${reg.guardianDiscountApplied.toFixed(2)}</span>
            </div>`;
        }

        const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Kidzoona Receipt #${reg.ticketNumber}</title>
            <link href="https://fonts.googleapis.com/css2?family=Fredoka+One&family=Quicksand:wght@500;700&display=swap" rel="stylesheet">
            <style>
                body { background: #f0f2f5; font-family: 'Quicksand', sans-serif; display: flex; justify-content: center; padding: 20px; }
                .receipt-card { 
                    background: white; width: 100%; max-width: 400px; padding: 30px; 
                    border-radius: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); 
                    border-top: 8px solid #4CAF50; position: relative;
                }
                .header { text-align: center; margin-bottom: 20px; border-bottom: 2px dashed #eee; padding-bottom: 20px; }
                .logo { max-width: 150px; margin-bottom: 10px; }
                .title { font-family: 'Fredoka One'; color: #1B5E20; font-size: 1.5rem; margin: 0; }
                .meta { font-size: 0.9rem; color: #777; margin-top: 5px; }
                .ticket-num { font-size: 2.5rem; color: #2E7D32; font-family: 'Fredoka One'; margin: 10px 0; }
                
                .section { margin-bottom: 15px; }
                .section-title { font-weight: bold; color: #444; text-transform: uppercase; font-size: 0.8rem; margin-bottom: 5px; }
                .item { display: flex; justify-content: space-between; margin-bottom: 5px; font-size: 0.95rem; }
                .item.total { font-weight: bold; font-size: 1.2rem; color: #1B5E20; border-top: 2px solid #eee; padding-top: 10px; margin-top: 10px; }
                .item.important { color: #d32f2f; font-weight: bold; font-size: 1.1rem; margin-top: 5px; }
                
                .footer { text-align: center; margin-top: 30px; font-size: 0.8rem; color: #999; }
                .status-badge { 
                    display: inline-block; padding: 5px 15px; background: #E8F5E9; 
                    color: #2E7D32; border-radius: 50px; font-weight: bold; font-size: 0.8rem; margin-top: 10px; 
                }
            </style>
        </head>
        <body>
            <div class="receipt-card">
                <div class="header">
                    <img src="/kidzoonaaa.png" class="logo" alt="Kidzoona">
                    <h1 class="title">OFFICIAL RECEIPT</h1>
                    <div class="meta">${dateStr}</div>
                    <div class="ticket-num">#${reg.ticketNumber}</div>
                    <div class="status-badge">PAID & VERIFIED</div>
                </div>

                <div class="section">
                    <div class="section-title">Guests</div>
                    ${reg.children.map(c => `<div class="item"><span>${c.name}</span><span>${c.age} y/o</span></div>`).join('')}
                    ${reg.guardians.map(g => `<div class="item" style="color:#666;"><span>${g.name}</span><span>Guardian</span></div>`).join('')}
                </div>

                <div class="section">
                    <div class="section-title">Details</div>
                    <div class="item"><span>Playtime Rate</span><span>₱${reg.playtimeRate.toFixed(2)}</span></div>
                    
                    <div class="item important">
                        <span>EXIT TIME</span>
                        <span>${exitTimeStr}</span>
                    </div>

                    <div class="item"><span>Children</span><span>x${reg.childCount}</span></div>
                    ${reg.socks.kidsQty > 0 ? `<div class="item"><span>Socks (Kids)</span><span>x${reg.socks.kidsQty}</span></div>` : ''}
                    ${reg.socks.adultsQty > 0 ? `<div class="item"><span>Socks (Adult)</span><span>x${reg.socks.adultsQty}</span></div>` : ''}
                    ${reg.excessGuardians > 0 ? `<div class="item" style="color:#FF9800;"><span>Extra Guardians</span><span>x${reg.excessGuardians}</span></div>` : ''}
                    ${discountHtml}
                </div>

                <div class="item total">
                    <span>TOTAL AMOUNT</span>
                    <span>₱${reg.grandTotal.toFixed(2)}</span>
                </div>

                <div class="footer">
                    Thank you for playing at Kidzoona!<br>
                    Please mind your Exit Time to avoid overtime fees<br>
                    Please show this receipt upon entry and exit.
                </div>
            </div>
        </body>
        </html>
        `;

        res.send(html);

    } catch (error) {
        console.error(error);
        res.status(500).send("Server Error");
    }
});

app.get('/api/admin/registrations', async (req, res) => {
    try {
        const regs = await Registration.find().sort({ registrationDate: -1 });
        res.json(regs);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch data" });
    }
});

app.put('/api/admin/registrations/checkout/:id', async (req, res) => {
    try {
        const { overtimeFee, staffName } = req.body || {}; 
        await Registration.findByIdAndUpdate(req.params.id, { 
            status: 'completed',
            checkoutDate: new Date(),
            overtimeFee: overtimeFee || 0,
            checkoutBy: staffName || 'Admin'
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Failed to update status" });
    }
});

app.delete('/api/admin/registrations/:id', async (req, res) => {
    try {
        await Registration.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Failed to delete" });
    }
});

app.get('/api/admin/vouchers', async (req, res) => {
    try {
        const vouchers = await Voucher.find();
        res.json(vouchers);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch vouchers" });
    }
});

app.post('/api/admin/vouchers', async (req, res) => {
    try {
        const { code, idType, idNumber, childDiscount, childPax, guardianDiscount, guardianPax } = req.body; 
        const newVoucher = new Voucher({ 
            code: code.toUpperCase(), idType, idNumber, childDiscount, childPax, guardianDiscount, guardianPax 
        }); 
        await newVoucher.save();
        res.json({ success: true, voucher: newVoucher });
    } catch (error) {
        res.status(500).json({ error: "Failed to save voucher. May already exist." });
    }
});
app.delete('/api/admin/vouchers/:id', async (req, res) => {
    try {
        await Voucher.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Failed to delete voucher" });
    }
});

app.get('/api/admin/settings', async (req, res) => {
    try {
        const settings = await Settings.findOne();
        res.json(settings);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch settings" });
    }
});

app.post('/api/admin/settings', async (req, res) => {
    try {
        const updates = req.body;
        let settings = await Settings.findOne();
        
        if (!settings) {
            settings = new Settings(updates);
        } else {
            if (updates.rate1hr !== undefined) settings.rate1hr = updates.rate1hr;
            if (updates.rate2hr !== undefined) settings.rate2hr = updates.rate2hr;
            if (updates.rate3hr !== undefined) settings.rate3hr = updates.rate3hr;
            if (updates.rulesText !== undefined) settings.rulesText = updates.rulesText;
            if (updates.staffPassword !== undefined) settings.staffPassword = updates.staffPassword;
            
            if (updates.staffAccounts !== undefined) {
                settings.staffAccounts = updates.staffAccounts;
                settings.markModified('staffAccounts'); 
            }
        }
        
        await settings.save();
        res.json({ success: true, settings });
    } catch (error) {
        console.error("Settings Save Error:", error);
        res.status(500).json({ error: "Failed to save settings" });
    }
});

app.get('/api/admin/backup/download', async (req, res) => {
    try {
        const completedRegs = await Registration.find({ status: 'completed' }).sort({ checkoutDate: -1 });
        const dateStr = new Date().toISOString().split('T')[0];
        
        res.setHeader('Content-disposition', `attachment; filename=kidzoona_backup_${dateStr}.json`);
        res.setHeader('Content-type', 'application/json');
        
        res.send(JSON.stringify(completedRegs, null, 2));
    } catch (error) {
        res.status(500).send("Backup generation failed.");
    }
});

function performDailyBackup() {
    Registration.find({ status: 'completed' })
        .then(completedRegs => {
            if (completedRegs.length === 0) return; 
            
            const dateStr = new Date().toISOString().split('T')[0]; 
            const backupDir = path.join(__dirname, 'backups');
            
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir);
            }
            
            const fileName = path.join(backupDir, `kidzoona_backup_${dateStr}.json`);
            
            fs.writeFileSync(fileName, JSON.stringify(completedRegs, null, 2));
            console.log(`💾 [SUCCESS] Automated Daily Backup Saved: ${fileName}`);
        })
        .catch(err => console.error("❌ Backup Error:", err));
}

function scheduleNextBackup() {
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0, 0);
    
    if (now.getTime() >= nextMidnight.getTime()) {
        nextMidnight.setDate(nextMidnight.getDate() + 1);
    }
    
    const timeUntilMidnight = nextMidnight.getTime() - now.getTime();
    
    console.log(`🕒 Next automated system backup scheduled in ${Math.round(timeUntilMidnight / 1000 / 60)} minutes.`);
    
    setTimeout(() => {
        performDailyBackup();
        setInterval(performDailyBackup, 24 * 60 * 60 * 1000); 
    }, timeUntilMidnight);
}

app.post('/api/cancel-payment', (req, res) => {
    console.log("🚫 Transaction cancelled by user or idle timeout.");

    if (paymentResolver) {
        paymentResolver({ cancelled: true }); 
        paymentResolver = null;
        currentPaidAmount = 0;
    }
    
    res.json({ success: true, message: "Payment cancelled and server freed." });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on http://127.0.1.1:${PORT}`);
});