let loansData = [];
let privacyMaskActive = false;

// Cute animal mascots for borrower cards
const cuteAvatars = ['🐱', '🐻', '🐰', '🦊', '🐼', '🐸', '🐯', '🐨', '🐥', '🐹'];

document.addEventListener('DOMContentLoaded', () => {
    fetchDashboardData();
    setupEventListeners();
    setTodayDate();
});

function setTodayDate() {
    const today = new Date().toISOString().split('T')[0];
    const dateInput = document.getElementById('formBorrowDate');
    dateInput.value = today;
    dateInput.disabled = true;
}

// Fetch Data from Server
async function fetchDashboardData() {
    try {
        const res = await fetch('/api/dashboard');
        const data = await res.json();
        loansData = data.loans;
        renderDashboardStats(data.stats);
        renderLoans();
    } catch (err) {
        console.error('Failed to load dashboard:', err);
    }
}

// Render Stats Panel
function renderDashboardStats(stats) {
    document.getElementById('totalCapital').innerText = `₱${stats.totalCapitalLent.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    document.getElementById('totalInterest').innerText = `₱${stats.totalInterestCollected.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    document.getElementById('statTotal').innerText = stats.totalBorrowers;
    document.getElementById('statActive').innerText = stats.activeCount;
    document.getElementById('statDue').innerText = stats.dueTodayCount;
    document.getElementById('statOverdue').innerText = stats.overdueCount;
}

// Filter and Sort Processing
function getProcessedLoans() {
    const searchVal = document.getElementById('searchInput').value.toLowerCase();
    const sortVal = document.getElementById('sortSelect').value;

    let filtered = loansData.filter(l => l.borrowers.name.toLowerCase().includes(searchVal));

    filtered.sort((a, b) => {
        if (sortVal === 'dueDate') return new Date(a.due_date) - new Date(b.due_date);
        if (sortVal === 'a-z') return a.borrowers.name.localeCompare(b.borrowers.name);
        if (sortVal === 'z-a') return b.borrowers.name.localeCompare(a.borrowers.name);
        if (sortVal === 'highest') return b.principal_amount - a.principal_amount;
        if (sortVal === 'lowest') return a.principal_amount - b.principal_amount;
        if (sortVal === 'term-2-1') return b.term_type.localeCompare(a.term_type);
        if (sortVal === 'term-1-2') return a.term_type.localeCompare(b.term_type);
        
        const statusOrderActive = { 'Active': 1, 'Due Today': 2, 'Overdue': 3, 'Paid': 4 };
        if (sortVal === 'tag-active') return statusOrderActive[a.status] - statusOrderActive[b.status];

        const statusOrderOverdue = { 'Overdue': 1, 'Due Today': 2, 'Active': 3, 'Paid': 4 };
        if (sortVal === 'tag-overdue') return statusOrderOverdue[a.status] - statusOrderOverdue[b.status];

        return 0;
    });

    return filtered;
}

// Helper: Pick persistent avatar based on borrower ID string
function getAvatarForId(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
        hash = id.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % cuteAvatars.length;
    return cuteAvatars[index];
}

// Render Borrower Cards
function renderLoans() {
    const container = document.getElementById('borrowersContainer');
    container.innerHTML = '';
    const loans = getProcessedLoans();

    loans.forEach(loan => {
        const displayName = privacyMaskActive ? '*** ****' : loan.borrowers.name;
        const avatar = getAvatarForId(loan.id);
        
        let badgeClass = 'badge-active';
        if (loan.status === 'Due Today') badgeClass = 'badge-due';
        if (loan.status === 'Overdue') badgeClass = 'badge-overdue';

        const card = document.createElement('div');
        card.className = 'glass-3d-card p-5 relative flex flex-col justify-between';
        
        card.innerHTML = `
            <div>
                <div class="flex justify-between items-start mb-3">
                    <div class="flex items-center gap-3">
                        <span class="w-10 h-10 rounded-2xl bg-amber-100/80 dark:bg-slate-800 flex items-center justify-center text-xl shadow-sm border border-amber-200/50">${avatar}</span>
                        <div>
                            <h3 class="text-base font-black tracking-tight">${displayName}</h3>
                            <p class="text-xs text-stone-500 font-semibold">${loan.borrowers.phone}</p>
                        </div>
                    </div>
                    <span class="text-xs font-black px-3 py-1 rounded-full ${badgeClass}">${loan.status}</span>
                </div>

                <div class="grid grid-cols-2 gap-2 text-sm my-3 border-y border-stone-200/60 dark:border-slate-800 py-3">
                    <div>
                        <p class="text-xs text-stone-400 font-bold">Principal</p>
                        <p class="font-black">₱${parseFloat(loan.principal_amount).toLocaleString()}</p>
                    </div>
                    <div>
                        <p class="text-xs text-stone-400 font-bold">Interest (${loan.interest_rate}%)</p>
                        <p class="font-black text-emerald-600 dark:text-emerald-400">₱${loan.calculatedInterest.toLocaleString()}</p>
                    </div>
                    <div>
                        <p class="text-xs text-stone-400 font-bold">Term</p>
                        <p class="font-bold text-stone-700 dark:text-stone-300">${loan.term_type}</p>
                    </div>
                    <div>
                        <p class="text-xs text-stone-400 font-bold">Due Date</p>
                        <p class="font-bold text-amber-600 dark:text-amber-400">${loan.due_date}</p>
                    </div>
                </div>

                ${loan.lateFee > 0 ? `
                    <div class="bg-rose-500/10 border border-rose-500/30 p-2.5 rounded-2xl mb-3 text-xs text-rose-600 dark:text-rose-400 font-bold flex items-center gap-1.5">
                        <span>⚠️</span>
                        <span>Overdue Fee (+30/1k/day): ₱${loan.lateFee.toLocaleString()} (${loan.daysOverdue}d)</span>
                    </div>
                ` : ''}
            </div>

            <div class="flex justify-between items-center pt-2">
                <div>
                    <span class="text-xs text-stone-400 font-bold">Total Payable:</span>
                    <span class="text-base font-black ml-1 text-stone-800 dark:text-stone-100">₱${loan.totalPayable.toLocaleString()}</span>
                </div>
                <div class="flex gap-2">
                    <button onclick="editLoan('${loan.id}')" class="px-3.5 py-1.5 bg-stone-200/70 dark:bg-slate-800 rounded-xl text-xs font-bold hover:opacity-80">Edit</button>
                    <button onclick="deleteLoan('${loan.id}')" class="px-3.5 py-1.5 bg-rose-500/20 text-rose-600 dark:text-rose-400 rounded-xl text-xs font-bold hover:opacity-80">Delete</button>
                </div>
            </div>
        `;

        container.appendChild(card);
    });
}

// Setup Event Listeners
function setupEventListeners() {
    // Theme Switch
    document.getElementById('themeToggle').addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
    });

    // Privacy Mask Switch
    document.getElementById('privacyToggle').addEventListener('click', () => {
        privacyMaskActive = !privacyMaskActive;
        document.getElementById('privacyStatus').innerText = privacyMaskActive ? 'Privacy ON' : 'Privacy OFF';
        renderLoans();
    });

    // Custom Date Toggle
    document.getElementById('customDateSwitch').addEventListener('change', (e) => {
        const dateInput = document.getElementById('formBorrowDate');
        dateInput.disabled = !e.target.checked;
        if (!e.target.checked) setTodayDate();
    });

    // Filter Listeners
    document.getElementById('searchInput').addEventListener('input', renderLoans);
    document.getElementById('sortSelect').addEventListener('change', renderLoans);

    // Modal Control
    const modal = document.getElementById('borrowerModal');
    document.getElementById('openAddModal').addEventListener('click', () => {
        document.getElementById('loanForm').reset();
        document.getElementById('loanId').value = '';
        document.getElementById('modalTitle').innerText = 'Add Borrower';
        document.getElementById('otpSection').style.display = 'block';
        setTodayDate();
        modal.classList.remove('hidden');
    });

    document.getElementById('closeModalBtn').addEventListener('click', () => {
        modal.classList.add('hidden');
    });

    // Send OTP Buttons
    document.getElementById('btnSendOtpEmail').addEventListener('click', () => requestOtp('email'));
    document.getElementById('btnSendOtpPhone').addEventListener('click', () => requestOtp('phone'));

    // Form Submit
    document.getElementById('loanForm').addEventListener('submit', handleFormSubmit);
}

// Request OTP API Call
async function requestOtp(channel) {
    try {
        const res = await fetch('/api/auth/request-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel })
        });
        const data = await res.json();
        alert(data.message || 'OTP Sent!');
    } catch (e) {
        alert('Failed to send OTP');
    }
}

// Submit Form (Add / Edit)
async function handleFormSubmit(e) {
    e.preventDefault();
    const loanId = document.getElementById('loanId').value;
    
    const payload = {
        borrowerName: document.getElementById('formName').value,
        phone: document.getElementById('formPhone').value,
        email: document.getElementById('formEmail').value,
        amount: parseFloat(document.getElementById('formAmount').value),
        interest: parseFloat(document.getElementById('formInterest').value),
        termType: document.getElementById('formTerm').value,
        borrowDate: document.getElementById('formBorrowDate').value
    };

    if (!loanId) {
        // Create Action requiring OTP
        const otp = document.getElementById('formOtp').value;
        if (!otp) return alert('Please enter OTP');

        const res = await fetch('/api/borrowers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                otp,
                borrower: { name: payload.borrowerName, phone: payload.phone, email: payload.email },
                loan: { amount: payload.amount, interest: payload.interest, termType: payload.termType, borrowDate: payload.borrowDate }
            })
        });

        if (res.ok) {
            document.getElementById('borrowerModal').classList.add('hidden');
            fetchDashboardData();
        } else {
            const err = await res.json();
            alert(err.error || 'Operation failed');
        }
    } else {
        // Edit Existing Loan
        const res = await fetch(`/api/loans/${loanId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            document.getElementById('borrowerModal').classList.add('hidden');
            fetchDashboardData();
        }
    }
}

// Edit Existing Borrower
function editLoan(id) {
    const loan = loansData.find(l => l.id === id);
    if (!loan) return;

    document.getElementById('loanId').value = loan.id;
    document.getElementById('formName').value = loan.borrowers.name;
    document.getElementById('formPhone').value = loan.borrowers.phone;
    document.getElementById('formEmail').value = loan.borrowers.email || '';
    document.getElementById('formAmount').value = loan.principal_amount;
    document.getElementById('formInterest').value = loan.interest_rate;
    document.getElementById('formTerm').value = loan.term_type;
    document.getElementById('formBorrowDate').value = loan.borrow_date;
    
    document.getElementById('otpSection').style.display = 'none'; // Skip OTP on editing
    document.getElementById('modalTitle').innerText = 'Edit Borrower & Loan';
    document.getElementById('borrowerModal').classList.remove('hidden');
}

// Delete Borrower & Loan Record
async function deleteLoan(id) {
    if (confirm('Are you sure you want to delete this loan record?')) {
        await fetch(`/api/loans/${id}`, { method: 'DELETE' });
        fetchDashboardData();
    }
}