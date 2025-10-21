// dashboard.js - User Dashboard Functionality

let currentUser = null;
let userSessions = [];
let userSubscription = null;

// Initialize dashboard
document.addEventListener('DOMContentLoaded', function() {
    initializeDashboard();
    loadUserData();
    setupEventListeners();
    connectToServer();
});

// function initializeDashboard() {
//     // Check if user is logged in
//     const userSession = localStorage.getItem('userSession');
//     if (!userSession) {
//         window.location.href = '/index.html';
//         return;
//     }
    
//     currentUser = JSON.parse(userSession);
//     updateUserInfo();
// }

function updateUserInfo() {
    document.getElementById('userName').textContent = currentUser.user.name || 'User';
    document.getElementById('userSubscription').textContent = currentUser.user.subscription || 'Free Plan';
}

function setupEventListeners() {
    // Navigation
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const section = this.getAttribute('data-section');
            switchSection(section);
        });
    });

    // Mobile menu
    document.getElementById('mobileMenuBtn').addEventListener('click', toggleMobileMenu);
    document.getElementById('sidebarToggle').addEventListener('click', toggleSidebar);

    // Settings tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            switchTab(this.getAttribute('data-tab'));
        });
    });

    // Session filter
    document.getElementById('sessionFilter').addEventListener('change', filterSessions);
    document.getElementById('sessionSearch').addEventListener('input', filterSessions);
}

function switchSection(sectionName) {
    // Update active nav
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    document.querySelectorAll('.content-section').forEach(section => section.classList.remove('active'));
    
    const activeNav = document.querySelector(`[data-section="${sectionName}"]`);
    const activeSection = document.getElementById(`${sectionName}-section`);
    
    if (activeNav) activeNav.parentElement.classList.add('active');
    if (activeSection) activeSection.classList.add('active');

    // Update page title
    const titles = {
        overview: 'Dashboard Overview',
        sessions: 'My Sessions',
        subscription: 'My Subscription',
        statistics: 'Usage Statistics',
        settings: 'Bot Settings',
        payments: 'Payment History'
    };
    
    document.getElementById('pageTitle').textContent = titles[sectionName] || 'Dashboard';

    // Load section data
    loadSectionData(sectionName);
}

function loadSectionData(section) {
    switch(section) {
        case 'sessions':
            loadUserSessions();
            break;
        case 'subscription':
            loadSubscriptionInfo();
            break;
        case 'statistics':
            loadUserStatistics();
            break;
        case 'payments':
            loadPaymentHistory();
            break;
    }
}

// Socket.io connection
function connectToServer() {
    const socket = io('http://localhost:3000');
    
    socket.emit('join-user-room', currentUser.user.id);
    
    socket.on('qrCode', (data) => {
        displayQRCode(data.qr, data.sessionId);
    });
    
    socket.on('sessionReady', (data) => {
        showNotification('WhatsApp session connected successfully!', 'success');
        loadUserSessions();
    });
    
    socket.on('newMessage', (data) => {
        addToActivityLog(`New message from ${data.from}: ${data.body}`);
    });
}

// User data loading
async function loadUserData() {
    try {
        const response = await fetch('/api/users/profile', {
            headers: {
                'Authorization': `Bearer ${currentUser.token}`
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            currentUser.user = data.data.user;
            updateUserInfo();
            updateSubscriptionDisplay();
        }
    } catch (error) {
        console.error('Error loading user data:', error);
    }
}

// Session management
async function loadUserSessions() {
    try {
        const response = await fetch('/api/sessions/my-sessions', {
            headers: {
                'Authorization': `Bearer ${currentUser.token}`
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            userSessions = data.data.sessions || [];
            renderUserSessions();
            updateSessionStats();
        }
    } catch (error) {
        console.error('Error loading sessions:', error);
    }
}

function renderUserSessions() {
    const grid = document.getElementById('userSessionsGrid');
    if (!grid) return;

    if (userSessions.length === 0) {
        grid.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-plug" style="font-size: 48px; color: #667eea; margin-bottom: 16px;"></i>
                <h3>No WhatsApp Sessions</h3>
                <p>Create your first session to start using the bot</p>
                <button class="btn-primary" onclick="createNewSession()">
                    <i class="fas fa-plus"></i>
                    Create Session
                </button>
            </div>
        `;
        return;
    }

    grid.innerHTML = userSessions.map(session => `
        <div class="session-card ${session.status}">
            <div class="session-header">
                <div class="session-status">
                    <span class="status-indicator ${session.status}"></span>
                    <span class="status-text">${session.status.charAt(0).toUpperCase() + session.status.slice(1)}</span>
                </div>
                <div class="session-actions">
                    <button class="action-btn" onclick="viewSession('${session.sessionId}')">
                        <i class="fas fa-eye"></i>
                    </button>
                    <button class="action-btn" onclick="restartSession('${session.sessionId}')">
                        <i class="fas fa-redo"></i>
                    </button>
                    <button class="action-btn danger" onclick="deleteSession('${session.sessionId}')">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="session-info">
                <h4>${session.phone || 'Not connected'}</h4>
                <p class="session-phone">Session: ${session.sessionId}</p>
                <div class="session-stats">
                    <div class="stat">
                        <span class="stat-label">Uptime</span>
                        <span class="stat-value">${session.uptime || '0m'}</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Messages</span>
                        <span class="stat-value">${session.messageCount || 0}</span>
                    </div>
                </div>
            </div>
        </div>
    `).join('');

    document.getElementById('mySessionCount').textContent = userSessions.filter(s => s.status === 'connected').length;
}

function createNewSession() {
    fetch('/api/sessions/create', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${currentUser.token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showNotification('New session created! Scan the QR code to connect.', 'success');
            showQRModal();
        } else {
            showNotification(data.message, 'error');
        }
    })
    .catch(error => {
        console.error('Error creating session:', error);
        showNotification('Error creating session', 'error');
    });
}

// QR Code Modal
function showQRModal() {
    document.getElementById('qrModal').classList.add('active');
}

function closeQRModal() {
    document.getElementById('qrModal').classList.remove('active');
}

function displayQRCode(qrData, sessionId) {
    const qrContainer = document.getElementById('qrCodeDisplay');
    qrContainer.innerHTML = `
        <div class="qr-code-image">
            <div style="width: 200px; height: 200px; background: white; display: flex; align-items: center; justify-content: center; border-radius: 8px;">
                <div style="text-align: center;">
                    <i class="fas fa-qrcode" style="font-size: 48px; color: #667eea;"></i>
                    <p style="margin-top: 10px; font-size: 12px; color: #666;">QR Code for Session</p>
                    <p style="font-size: 10px; color: #999;">Session: ${sessionId}</p>
                </div>
            </div>
        </div>
        <p>Scan this code with WhatsApp</p>
    `;
}

// Subscription management
async function loadSubscriptionInfo() {
    try {
        const response = await fetch('/api/payments/subscription-status', {
            headers: {
                'Authorization': `Bearer ${currentUser.token}`
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            userSubscription = data.data;
            updateSubscriptionDisplay();
        }
    } catch (error) {
        console.error('Error loading subscription:', error);
    }
}

function updateSubscriptionDisplay() {
    if (!userSubscription) return;

    document.getElementById('currentPlan').textContent = userSubscription.subscription;
    document.getElementById('paymentStatus').textContent = userSubscription.paymentStatus;
    document.getElementById('expiryDate').textContent = userSubscription.daysRemaining + ' days';
    document.getElementById('maxSessions').textContent = userSubscription.limits?.maxSessions || 1;
    
    document.getElementById('planDaysLeft').textContent = userSubscription.daysRemaining;
    document.getElementById('planStatus').textContent = userSubscription.subscription;
    document.getElementById('sessionLimit').textContent = `Limit: ${userSubscription.limits?.maxSessions || 1}`;
}

function upgradeSubscription() {
    showUpgradeModal();
}

function showUpgradeModal() {
    document.getElementById('upgradeModal').classList.add('active');
    loadUpgradePlans();
}

function closeUpgradeModal() {
    document.getElementById('upgradeModal').classList.remove('active');
}

async function loadUpgradePlans() {
    try {
        const response = await fetch('/api/payments/plans');
        if (response.ok) {
            const data = await response.json();
            renderUpgradePlans(data.data.plans);
        }
    } catch (error) {
        console.error('Error loading plans:', error);
    }
}

function renderUpgradePlans(plans) {
    const container = document.getElementById('upgradePlansContainer');
    container.innerHTML = plans.map(plan => `
        <div class="plan-card-upgrade">
            <div class="plan-header">
                <h4>${plan.name}</h4>
                <span class="plan-price">₦${plan.amount}/month</span>
            </div>
            <div class="plan-features">
                ${plan.features.map(feature => `<div class="feature-item"><i class="fas fa-check"></i> ${feature}</div>`).join('')}
            </div>
            <button class="btn-primary" onclick="selectPlan('${plan.id}')">
                Select Plan
            </button>
        </div>
    `).join('');
}

function selectPlan(planId) {
    // Redirect to payment page or initialize payment
    window.location.href = `/payment.html?plan=${planId}`;
}

// Statistics
async function loadUserStatistics() {
    // Load user statistics
    updateStatisticsDisplay();
}

function updateStatisticsDisplay() {
    // Update statistics cards with user data
}

// Payment History
async function loadPaymentHistory() {
    try {
        const response = await fetch('/api/payments/history', {
            headers: {
                'Authorization': `Bearer ${currentUser.token}`
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            renderPaymentHistory(data.data.transactions);
        }
    } catch (error) {
        console.error('Error loading payment history:', error);
    }
}

function renderPaymentHistory(transactions) {
    const tbody = document.getElementById('paymentsTableBody');
    if (!tbody) return;

    if (transactions.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align: center; padding: 40px;">
                    <i class="fas fa-receipt" style="font-size: 48px; color: #667eea; margin-bottom: 16px;"></i>
                    <p>No payment history found</p>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = transactions.map(payment => `
        <tr>
            <td>${new Date(payment.createdAt).toLocaleDateString()}</td>
            <td>${payment.reference}</td>
            <td>${payment.metadata?.subscription || 'Unknown'}</td>
            <td>₦${payment.amount}</td>
            <td>
                <span class="status-badge ${payment.status === 'success' ? 'success' : 'error'}">
                    ${payment.status}
                </span>
            </td>
            <td>
                <button class="action-btn" onclick="viewReceipt('${payment.reference}')">
                    <i class="fas fa-receipt"></i>
                </button>
            </td>
        </tr>
    `).join('');
}

// Utility functions
function showNotification(message, type = 'info') {
    // Implementation for showing notifications
    console.log(`[${type.toUpperCase()}] ${message}`);
}

function addToActivityLog(message) {
    const activityList = document.getElementById('recentActivityList');
    if (activityList) {
        const activityItem = document.createElement('div');
        activityItem.className = 'activity-item info';
        activityItem.innerHTML = `
            <div class="activity-icon">
                <i class="fas fa-info-circle"></i>
            </div>
            <div class="activity-content">
                <p>${message}</p>
                <span class="activity-time">${new Date().toLocaleTimeString()}</span>
            </div>
        `;
        activityList.insertBefore(activityItem, activityList.firstChild);
    }
}

function toggleMobileMenu() {
    document.querySelector('.admin-sidebar').classList.toggle('mobile-open');
}

function toggleSidebar() {
    document.querySelector('.admin-sidebar').classList.toggle('collapsed');
}

function refreshData() {
    loadUserData();
    loadUserSessions();
    showNotification('Data refreshed', 'success');
}

function logout() {
    localStorage.removeItem('userSession');
    window.location.href = '/index.html';
}

// Placeholder functions for future implementation
function viewSession(sessionId) {
    showNotification(`Viewing session: ${sessionId}`, 'info');
}

function restartSession(sessionId) {
    showNotification(`Restarting session: ${sessionId}`, 'warning');
}

function deleteSession(sessionId) {
    if (confirm('Are you sure you want to delete this session?')) {
        showNotification(`Session ${sessionId} deleted`, 'success');
        loadUserSessions();
    }
}

function openSettings() {
    switchSection('settings');
}

function saveSettings() {
    showNotification('Settings saved successfully', 'success');
}

function exportPayments() {
    showNotification('Exporting payment history...', 'info');
}

function viewReceipt(reference) {
    showNotification(`Viewing receipt for: ${reference}`, 'info');
}

function updateSessionStats() {
    const activeSessions = userSessions.filter(s => s.status === 'connected').length;
    document.getElementById('activeSessionsCount').textContent = activeSessions;
}

function filterSessions() {
    // Implementation for filtering sessions
}