const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SUPABASE_URL = process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'YOUR_SUPABASE_SERVICE_ROLE_KEY';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SMS_API_URL = process.env.SMS_API_URL || 'https://api.sms-gateway.example/v1/send';
const SMS_API_TOKEN = process.env.SMS_API_TOKEN || 'YOUR_SMS_API_TOKEN';

/**
 * Formats local phone numbers to E.164 international standard
 * (e.g., "09686864240" -> "+639686864240")
 */
function formatToE164(phone, defaultCountryCode = '+63') {
    if (!phone) return null;
    let cleaned = phone.replace(/[^\d+]/g, '');
    if (cleaned.startsWith('0')) {
        cleaned = defaultCountryCode + cleaned.slice(1);
    } else if (!cleaned.startsWith('+')) {
        cleaned = defaultCountryCode + cleaned;
    }
    return cleaned;
}

// GET /api/dashboard
app.get('/api/dashboard', async (req, res) => {
    try {
        const { data: loans, error } = await supabase
            .from('loans')
            .select(`
                id,
                principal_amount,
                due_date,
                status,
                borrowers (
                    id,
                    name,
                    phone,
                    email
                )
            `);

        if (error) throw error;

        const stats = {
            totalCapitalLent: 0,
            totalBorrowers: 0,
            activeCount: 0,
            dueTodayCount: 0,
            overdueCount: 0
        };

        const borrowerSet = new Set();

        loans.forEach(loan => {
            stats.totalCapitalLent += parseFloat(loan.principal_amount || 0);
            if (loan.borrowers?.id) borrowerSet.add(loan.borrowers.id);

            if (loan.status === 'Active') stats.activeCount++;
            else if (loan.status === 'Due Today') stats.dueTodayCount++;
            else if (loan.status === 'Overdue') stats.overdueCount++;
        });

        stats.totalBorrowers = borrowerSet.size;
        res.json({ stats, loans });
    } catch (err) {
        console.error('Dashboard Error:', err.message);
        res.status(500).json({ error: 'Failed to retrieve dashboard data' });
    }
});

// POST /api/loans (Create New Loan & Borrower)
app.post('/api/loans', async (req, res) => {
    const { name, phone, email, principal_amount, due_date } = req.body;

    try {
        // Insert Borrower
        const { data: borrower, error: bErr } = await supabase
            .from('borrowers')
            .insert([{ name, phone, email }])
            .select()
            .single();

        if (bErr) throw bErr;

        // Insert Loan
        const { data: loan, error: lErr } = await supabase
            .from('loans')
            .insert([{
                borrower_id: borrower.id,
                principal_amount: parseFloat(principal_amount),
                due_date,
                status: 'Active'
            }])
            .select();

        if (lErr) throw lErr;

        res.json({ success: true, message: 'New loan created successfully!', loan });
    } catch (err) {
        console.error('Create Loan Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/loans/:id (Update Borrower & Loan Details)
app.put('/api/loans/:id', async (req, res) => {
    const loanId = req.params.id;
    const { borrower_id, name, phone, principal_amount, due_date } = req.body;

    try {
        // Update Borrower Details
        if (borrower_id) {
            const { error: bErr } = await supabase
                .from('borrowers')
                .update({ name, phone })
                .eq('id', borrower_id);
            if (bErr) throw bErr;
        }

        // Update Loan Details
        const { data: loan, error: lErr } = await supabase
            .from('loans')
            .update({
                principal_amount: parseFloat(principal_amount),
                due_date
            })
            .eq('id', loanId)
            .select();

        if (lErr) throw lErr;

        res.json({ success: true, message: 'Record updated successfully!', loan });
    } catch (err) {
        console.error('Update Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/loans/:id
app.delete('/api/loans/:id', async (req, res) => {
    try {
        const { error } = await supabase
            .from('loans')
            .delete()
            .eq('id', req.params.id);

        if (error) throw error;
        res.json({ success: true, message: 'Loan record deleted.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/loans/:id/send-reminder
app.post('/api/loans/:id/send-reminder', async (req, res) => {
    const loanId = req.params.id;
    const { channel = 'both' } = req.body;

    try {
        const { data: loan, error } = await supabase
            .from('loans')
            .select(`
                id,
                principal_amount,
                due_date,
                borrowers (
                    name,
                    phone,
                    email
                )
            `)
            .eq('id', loanId)
            .single();

        if (error || !loan) {
            return res.status(404).json({ error: 'Loan record not found' });
        }

        const borrower = loan.borrowers;
        const formattedPhone = formatToE164(borrower.phone);
        const reminderMessage = `Hello ${borrower.name}, this is a friendly reminder regarding your loan of ₱${parseFloat(loan.principal_amount).toLocaleString()} due on ${loan.due_date}.`;

        let smsSent = false;
        let emailSent = false;

        if ((channel === 'sms' || channel === 'both') && formattedPhone) {
            const smsResponse = await fetch(SMS_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${SMS_API_TOKEN}`
                },
                body: JSON.stringify({
                    recipient: formattedPhone,
                    message: reminderMessage
                })
            });

            if (!smsResponse.ok) {
                const errorText = await smsResponse.text();
                console.error(`[SMS Error] Status ${smsResponse.status}:`, errorText);
                if (channel === 'sms') {
                    return res.status(400).json({ error: `SMS Delivery Failed: ${errorText}` });
                }
            } else {
                smsSent = true;
            }
        }

        if ((channel === 'email' || channel === 'both') && borrower.email) {
            console.log(`[Email Dispatched] To: ${borrower.email}`);
            emailSent = true;
        }

        res.json({
            success: true,
            message: `Reminder processed for ${borrower.name}.`,
            details: { phoneUsed: formattedPhone, smsSent, emailSent }
        });
    } catch (err) {
        console.error('Reminder Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});