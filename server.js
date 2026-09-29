require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Supabase Setup
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

let supabase;
if (SUPABASE_URL && SUPABASE_URL.startsWith('http')) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
} else {
    console.error('⚠️ Warning: SUPABASE_URL is missing or invalid in .env');
}

// Twilio Setup
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) 
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

// In-Memory OTP Storage
const activeOTPs = new Map();

/**
 * Calculates due date based on term
 */
function calculateDueDate(issueDateStr, term) {
    const issueDate = new Date(issueDateStr);
    const dueDate = new Date(issueDate);

    if (term === '1week') dueDate.setDate(dueDate.getDate() + 7);
    else if (term === '2weeks') dueDate.setDate(dueDate.getDate() + 14);
    else if (term === '1month') dueDate.setMonth(dueDate.getMonth() + 1);

    return dueDate.toISOString().split('T')[0];
}

/**
 * Calculates dynamic status & ₱30/1k/day overdue penalty
 */
function processLoanData(loan) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dueDate = new Date(loan.due_date);
    dueDate.setHours(0, 0, 0, 0);

    const diffTime = today.getTime() - dueDate.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 3600 * 24));

    let status = 'Active';
    let overdueDays = 0;
    let overdueFee = 0;

    if (diffDays === 0) {
        status = 'Due Today';
    } else if (diffDays > 0) {
        status = 'Overdue';
        overdueDays = diffDays;
        const principal = parseFloat(loan.principal_amount || 0);
        // Penalty: ₱30 per ₱1,000 principal per day
        overdueFee = Math.floor(principal / 1000) * 30 * overdueDays;
    }

    const principal = parseFloat(loan.principal_amount || 0);
    const interest = principal * (parseFloat(loan.interest_rate || 10) / 100);
    const totalPayable = principal + interest + overdueFee;

    return {
        ...loan,
        status,
        overdueDays,
        overdueFee,
        calculatedInterest: interest,
        totalPayable
    };
}

// GET /api/dashboard
app.get('/api/dashboard', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Supabase is not configured in .env' });

    try {
        const { data: loans, error } = await supabase
            .from('loans')
            .select(`
                id,
                principal_amount,
                interest_rate,
                term,
                issue_date,
                due_date,
                borrowers (
                    id,
                    name,
                    phone,
                    email
                )
            `);

        if (error) throw error;

        const processedLoans = (loans || []).map(processLoanData);

        const stats = {
            totalCapitalLent: 0,
            totalInterest: 0,
            totalBorrowers: 0,
            activeCount: 0,
            dueTodayCount: 0,
            overdueCount: 0
        };

        const borrowerSet = new Set();

        processedLoans.forEach(loan => {
            stats.totalCapitalLent += parseFloat(loan.principal_amount || 0);
            stats.totalInterest += loan.calculatedInterest;
            if (loan.borrowers?.id) borrowerSet.add(loan.borrowers.id);

            if (loan.status === 'Active') stats.activeCount++;
            else if (loan.status === 'Due Today') stats.dueTodayCount++;
            else if (loan.status === 'Overdue') stats.overdueCount++;
        });

        stats.totalBorrowers = borrowerSet.size;

        res.json({ stats, loans: processedLoans });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/otp/request
app.post('/api/otp/request', async (req, res) => {
    const { channel } = req.body; // 'email' or 'phone'
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const target = channel === 'email' ? process.env.ADMIN_CONSTANT_EMAIL : process.env.ADMIN_CONSTANT_PHONE;

    activeOTPs.set('ADMIN_ACTION', { code, expires: Date.now() + 5 * 60 * 1000 });

    console.log(`\n🔑 [OTP DISPATCH] Channel: ${channel.toUpperCase()} | Target: ${target} \vert{} Code:${code}\n`);

    if (channel === 'phone' && twilioClient && process.env.TWILIO_PHONE_NUMBER) {
        try {
            await twilioClient.messages.create({
                body: `[DebtTrack Security] Your verification OTP code is: ${code}`,
                from: process.env.TWILIO_PHONE_NUMBER,
                to: target
            });
        } catch (e) {
            console.error('[Twilio OTP Error]:', e.message);
        }
    }

    res.json({ success: true, message: `OTP sent to constant ${channel} (${target})` });
});

// POST /api/loans (Create Loan with OTP)
app.post('/api/loans', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Supabase is not configured' });
    const { name, phone, email, principal_amount, interest_rate, term, issue_date, otpCode } = req.body;

    // OTP Verification
    const storedOTP = activeOTPs.get('ADMIN_ACTION');
    if (!storedOTP || storedOTP.code !== otpCode || Date.now() > storedOTP.expires) {
        return res.status(401).json({ error: 'Invalid or expired OTP code.' });
    }
    activeOTPs.delete('ADMIN_ACTION');

    try {
        const computedDueDate = calculateDueDate(issue_date, term);

        const { data: borrower, error: bErr } = await supabase
            .from('borrowers')
            .insert([{ name, phone, email }])
            .select()
            .single();

        if (bErr) throw bErr;

        const { data: loan, error: lErr } = await supabase
            .from('loans')
            .insert([{
                borrower_id: borrower.id,
                principal_amount: parseFloat(principal_amount),
                interest_rate: parseFloat(interest_rate || 10),
                term,
                issue_date,
                due_date: computedDueDate
            }])
            .select();

        if (lErr) throw lErr;

        res.json({ success: true, message: 'New loan created successfully!', loan });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/loans/:id (Edit Existing Client Loan)
app.put('/api/loans/:id', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Supabase is not configured' });
    const loanId = req.params.id;
    const { borrower_id, name, phone, email, principal_amount, interest_rate, term, issue_date } = req.body;

    try {
        const computedDueDate = calculateDueDate(issue_date, term);

        if (borrower_id) {
            const { error: bErr } = await supabase
                .from('borrowers')
                .update({ name, phone, email })
                .eq('id', borrower_id);
            if (bErr) throw bErr;
        }

        const { data: loan, error: lErr } = await supabase
            .from('loans')
            .update({
                principal_amount: parseFloat(principal_amount),
                interest_rate: parseFloat(interest_rate),
                term,
                issue_date,
                due_date: computedDueDate
            })
            .eq('id', loanId)
            .select();

        if (lErr) throw lErr;

        res.json({ success: true, message: 'Loan updated successfully!', loan });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/loans/:id
app.delete('/api/loans/:id', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Supabase is not configured' });
    try {
        const { error } = await supabase.from('loans').delete().eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true, message: 'Loan record deleted.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/loans/:id/send-reminder (Twilio SMS Integration)
app.post('/api/loans/:id/send-reminder', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Supabase is not configured' });
    const loanId = req.params.id;

    try {
        const { data: rawLoan, error } = await supabase
            .from('loans')
            .select(`
                id,
                principal_amount,
                due_date,
                borrowers (
                    name,
                    phone
                )
            `)
            .eq('id', loanId)
            .single();

        if (error || !rawLoan) return res.status(404).json({ error: 'Loan record not found' });

        const loan = processLoanData(rawLoan);
        const borrower = loan.borrowers;
        const msg = `Hello ${borrower.name}, friendly reminder from DebtTrack: Your loan of ₱${loan.totalPayable.toLocaleString()} is${loan.status === 'Overdue' ? 'OVERDUE' : 'due on ' + loan.due_date}. Please settle promptly.`;

        let smsSent = false;
        if (twilioClient && process.env.TWILIO_PHONE_NUMBER && borrower.phone) {
            try {
                await twilioClient.messages.create({
                    body: msg,
                    from: process.env.TWILIO_PHONE_NUMBER,
                    to: borrower.phone
                });
                smsSent = true;
            } catch (tErr) {
                console.error('[Twilio Error]:', tErr.message);
            }
        } else {
            console.log(`\n📱 [MOCK SMS REMINDER SENT TO ${borrower.phone}]:${msg}\n`);
            smsSent = true;
        }

        res.json({ success: true, message: `Reminder dispatched to ${borrower.name}!`, smsSent });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 DebtTrack running on http://localhost:${PORT}`);
});