require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Supabase using Service Role Key (Bypasses Row Level Security)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Gmail Transporter
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
    }
});

/**
 * Sends SMS via Cloud SMS Gateway API App
 */
async function sendSmsViaPersonalPhone(toPhone, messageText) {
    if (!process.env.SMS_GATEWAY_URL || !process.env.SMS_GATEWAY_KEY) {
        console.log("[SMS Gateway] Gateway URL or API Key missing in .env");
        return;
    }

    try {
        const response = await fetch(process.env.SMS_GATEWAY_URL, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-API-Key': process.env.SMS_GATEWAY_KEY
            },
            body: JSON.stringify({
                phoneNumber: toPhone,
                message: messageText
            })
        });

        if (response.ok) {
            console.log(`[SMS Gateway] SMS queued to ${toPhone}`);
        } else {
            const errText = await response.text();
            console.error(`[SMS Gateway Error] Status ${response.status}:`, errText);
        }
    } catch (err) {
        console.error("[SMS Gateway Exception]:", err.message);
    }
}

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

// In-Memory OTP Store
let activeOtp = null;

// --- API ROUTES ---

// 1. Get Summary Stats and Loans
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

// 2. Request OTP Code
app.post('/api/auth/request-otp', async (req, res) => {
    const { channel } = req.body;
    const generatedCode = Math.floor(100000 + Math.random() * 900000).toString();
    activeOtp = generatedCode;

    try {
        if (channel === 'email') {
            await transporter.sendMail({
                from: process.env.GMAIL_USER,
                to: process.env.ADMIN_EMAIL,
                subject: 'DebtTrack Security Verification Code',
                text: `Your OTP code is: ${generatedCode}`
            });
        } else {
            await sendSmsViaPersonalPhone(
                process.env.ADMIN_PHONE, 
                `DebtTrack OTP Verification Code: ${generatedCode}`
            );
        }
        res.json({ success: true, message: `OTP sent via ${channel}` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. Verify OTP & Create Borrower/Loan
app.post('/api/borrowers', async (req, res) => {
    const { otp, borrower, loan } = req.body;

    if (otp !== activeOtp) {
        return res.status(400).json({ error: 'Invalid or expired OTP code.' });
    }
    activeOtp = null;

    try {
        const { data: bData, error: bErr } = await supabase
            .from('borrowers')
            .insert([{ name: borrower.name, phone: borrower.phone, email: borrower.email }])
            .select();

        if (bErr) throw bErr;

        const borrowerId = bData[0].id;
        const dueDate = calculateDueDate(loan.borrowDate, loan.termType);

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

// 4. Update Existing Loan & Borrower
app.put('/api/loans/:id', async (req, res) => {
    const { id } = req.params;
    const { borrowerName, phone, email, amount, interest, termType, borrowDate, status, interestCollected } = req.body;

    try {
        const dueDate = calculateDueDate(borrowDate, termType);

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

// 5. Delete Loan Record
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

// 6. Manual Send Reminder Endpoint
app.post('/api/loans/:id/send-reminder', async (req, res) => {
    const { id } = req.params;
    const { channel } = req.body;

    try {
        const { data: loan, error } = await supabase
            .from('loans')
            .select(`*, borrowers(*)`)
            .eq('id', id)
            .single();

        if (error || !loan) {
            return res.status(404).json({ error: 'Loan or borrower record not found.' });
        }

        const borrower = loan.borrowers;
        const message = `Hello ${borrower.name}, this is a reminder regarding your loan of ₱${loan.principal_amount} (Due: ${loan.due_date}). Please contact us for payment updates. Thank you!`;

        let smsSent = false;
        let emailSent = false;

        if ((channel === 'sms' || channel === 'both') && borrower.phone) {
            await sendSmsViaPersonalPhone(borrower.phone, message);
            smsSent = true;
        }

        if ((channel === 'email' || channel === 'both') && borrower.email) {
            await transporter.sendMail({
                from: process.env.GMAIL_USER,
                to: borrower.email,
                subject: 'Payment Reminder - DebtTrack',
                text: message
            });
            emailSent = true;
        }

        res.json({
            success: true,
            message: `Reminder dispatched! (SMS: ${smsSent ? 'Queued' : 'Skipped'}, Email: ${emailSent ? 'Sent' : 'Skipped'})`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Automated Daily Cron Job (Executes strictly at 8:00 AM GMT+8)
cron.schedule('0 8 * * *', async () => {
    console.log('[Cron Job] Executing 8:00 AM GMT+8 payment due check...');
    const today = new Date().toISOString().split('T')[0];

    const { data: loans, error } = await supabase
        .from('loans')
        .select(`*, borrowers(*)`)
        .neq('status', 'Paid');

    if (error || !loans) return;

    const dueTodayLoans = loans.filter(l => l.due_date === today);

    // If there are loans due today, notify borrowers and admin
    if (dueTodayLoans.length > 0) {
        let adminSummaryLines = [`[DebtTrack Admin Notice] ${dueTodayLoans.length} loan(s) due today (${today}):\n`];

        for (const loan of dueTodayLoans) {
            const borrower = loan.borrowers;
            const borrowerMessage = `Hello ${borrower.name}, friendly reminder that your loan payment of ₱${loan.principal_amount} is due today (${today}). Thank you!`;

            // Notify Borrower via SMS
            if (borrower.phone) {
                await sendSmsViaPersonalPhone(borrower.phone, borrowerMessage);
            }

            // Notify Borrower via Email
            if (borrower.email) {
                try {
                    await transporter.sendMail({
                        from: process.env.GMAIL_USER,
                        to: borrower.email,
                        subject: 'Payment Due Today - DebtTrack',
                        text: borrowerMessage
                    });
                } catch (e) {
                    console.error('[Gmail Cron Error]:', e.message);
                }
            }

            adminSummaryLines.push(`• ${borrower.name}: ₱${loan.principal_amount} (${borrower.phone || 'No Phone'})`);
        }

        // Notify Admin constant phone number
        if (process.env.ADMIN_PHONE) {
            await sendSmsViaPersonalPhone(process.env.ADMIN_PHONE, adminSummaryLines.join('\n'));
            console.log('[Cron Job] Summary notification dispatched to Admin.');
        }
    } else {
        console.log('[Cron Job] No loans due today. Admin notification skipped.');
    }
}, {
    timezone: "Asia/Manila"
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DebtTrack Server running on http://localhost:${PORT}`));