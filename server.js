require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Services
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
    }
});

// Helper: Calculate Due Date
function calculateDueDate(startDateStr, termType) {
    const date = new Date(startDateStr);
    if (termType === '1week') date.setDate(date.getDate() + 7);
    else if (termType === '2weeks') date.setDate(date.getDate() + 14);
    else if (termType === '1month') date.setMonth(date.getMonth() + 1);
    return date.toISOString().split('T')[0];
}

// Helper: Calculate Overdue Late Fee (30 Pesos per 1k per day late)
function calculateLateFee(principal, daysLate) {
    if (daysLate <= 0) return 0;
    const ratePerDay = (principal / 1000) * 30;
    return daysLate * ratePerDay;
}

// OTP Store (In-Memory for demonstration)
let activeOtp = null;

// API Routes

// 1. Get Summary Stats and Borrowers
app.get('/api/dashboard', async (req, res) => {
    try {
        const { data: loans, error: loansErr } = await supabase
            .from('loans')
            .select(`*, borrowers(*)`);
            
        if (loansErr) throw loansErr;

        const today = new Date().toISOString().split('T')[0];

        let totalCapital = 0;
        let totalInterest = 0;
        let activeCount = 0;
        let dueTodayCount = 0;
        let overdueCount = 0;

        const processedLoans = loans.map(loan => {
            const principal = parseFloat(loan.principal_amount);
            const interestAmount = (principal * parseFloat(loan.interest_rate)) / 100;
            totalCapital += principal;
            totalInterest += parseFloat(loan.interest_collected || 0);

            // Date Evaluation
            const dueDate = loan.due_date;
            let computedStatus = loan.status;

            if (loan.status !== 'Paid') {
                if (dueDate === today) {
                    computedStatus = 'Due Today';
                    dueTodayCount++;
                } else if (today > dueDate) {
                    computedStatus = 'Overdue';
                    overdueCount++;
                } else {
                    computedStatus = 'Active';
                    activeCount++;
                }
            }

            // Calculate late fee if overdue
            let lateFee = 0;
            let daysOverdue = 0;
            if (today > dueDate && loan.status !== 'Paid') {
                const diffTime = Math.abs(new Date(today) - new Date(dueDate));
                daysOverdue = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                lateFee = calculateLateFee(principal, daysOverdue);
            }

            return {
                ...loan,
                status: computedStatus,
                calculatedInterest: interestAmount,
                totalPayable: principal + interestAmount + lateFee,
                daysOverdue,
                lateFee
            };
        });

        res.json({
            stats: {
                totalBorrowers: new Set(loans.map(l => l.borrower_id)).size,
                totalCapitalLent: totalCapital,
                totalInterestCollected: totalInterest,
                activeCount,
                dueTodayCount,
                overdueCount
            },
            loans: processedLoans
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Request OTP for Kitty / Critical Actions
app.post('/api/auth/request-otp', async (req, res) => {
    const { channel } = req.body; // 'email' or 'phone'
    const generatedCode = Math.floor(100000 + Math.random() * 900000).toString();
    activeOtp = generatedCode;

    try {
        if (channel === 'email') {
            await transporter.sendMail({
                from: process.env.GMAIL_USER,
                to: process.env.ADMIN_EMAIL,
                subject: 'DebtTrack Security Code',
                text: `Your OTP to confirm action on DebtTrack is: ${generatedCode}`
            });
        } else {
            await twilioClient.messages.create({
                body: `DebtTrack Security OTP: ${generatedCode}`,
                from: process.env.TWILIO_PHONE_NUMBER,
                to: process.env.ADMIN_PHONE
            });
        }
        res.json({ success: true, message: `OTP sent via ${channel}` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. Verify OTP and Create Borrower / Loan
app.post('/api/borrowers', async (req, res) => {
    const { otp, borrower, loan } = req.body;

    if (otp !== activeOtp) {
        return res.status(400).json({ error: 'Invalid or expired OTP code.' });
    }
    activeOtp = null; // Clear after use

    try {
        // Insert Borrower
        const { data: bData, error: bErr } = await supabase
            .from('borrowers')
            .insert([{ name: borrower.name, phone: borrower.phone, email: borrower.email }])
            .select();

        if (bErr) throw bErr;

        const borrowerId = bData[0].id;
        const dueDate = calculateDueDate(loan.borrowDate, loan.termType);

        // Insert Loan
        const { data: lData, error: lErr } = await supabase
            .from('loans')
            .insert([{
                borrower_id: borrowerId,
                principal_amount: loan.amount,
                interest_rate: loan.interest,
                term_type: loan.termType,
                borrow_date: loan.borrowDate,
                due_date: dueDate,
                status: 'Active'
            }])
            .select();

        if (lErr) throw lErr;

        res.json({ success: true, borrower: bData[0], loan: lData[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Update Existing Loan and Borrower Details
app.put('/api/loans/:id', async (req, res) => {
    const { id } = req.params;
    const { borrowerName, phone, email, amount, interest, termType, borrowDate, status, interestCollected } = req.body;

    try {
        const dueDate = calculateDueDate(borrowDate, termType);

        // Update Loan
        const { data: loanData, error: lErr } = await supabase
            .from('loans')
            .update({
                principal_amount: amount,
                interest_rate: interest,
                term_type: termType,
                borrow_date: borrowDate,
                due_date: dueDate,
                status,
                interest_collected: interestCollected
            })
            .eq('id', id)
            .select();

        if (lErr) throw lErr;

        // Update Borrower
        if (loanData[0]?.borrower_id) {
            await supabase
                .from('borrowers')
                .update({ name: borrowerName, phone, email })
                .eq('id', loanData[0].borrower_id);
        }

        res.json({ success: true, loan: loanData[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Delete Borrower & Loan Record
app.delete('/api/loans/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase.from('loans').delete().eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Automated Daily Cron Job (Reminders & Fee Notifications at 8:00 AM daily)
cron.schedule('0 8 * * *', async () => {
    console.log('Running automated due date check...');
    const today = new Date().toISOString().split('T')[0];

    const { data: loans } = await supabase
        .from('loans')
        .select(`*, borrowers(*)`)
        .eq('status', 'Active');

    if (!loans) return;

    for (const loan of loans) {
        if (loan.due_date === today) {
            const message = `Hello ${loan.borrowers.name}, this is a friendly reminder that your loan repayment of ₱${loan.principal_amount} is due today. Thank you!`;
            
            // Send SMS via Twilio
            try {
                await twilioClient.messages.create({
                    body: message,
                    from: process.env.TWILIO_PHONE_NUMBER,
                    to: loan.borrowers.phone
                });
            } catch (e) { console.error('Twilio SMS Error:', e); }

            // Send Email via Gmail if present
            if (loan.borrowers.email) {
                try {
                    await transporter.sendMail({
                        from: process.env.GMAIL_USER,
                        to: loan.borrowers.email,
                        subject: 'Loan Payment Due Today - DebtTrack',
                        text: message
                    });
                } catch (e) { console.error('Gmail Error:', e); }
            }
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DebtTrack Server running on port ${PORT}`));