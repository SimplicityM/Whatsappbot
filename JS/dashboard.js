// dashboard.js - User Dashboard Functionality

let currentUser = null;
let userSessions = [];
let userSubscription = null;

// Initialize dashboard
document.addEventListener('DOMContentLoaded', function() {
    console.log('Dashboard initializing...');
    initializeDashboard();
    loadUserData();
    setupEventListeners();
    connectToServer();
    initializeAllSections();
});

// function initializeDashboard() {
//     // Check if user is logged in
//     const userSession = localStorage.getItem('userSession');
//     if (!userSession) {
//         window.location.href = '/index.html';
//         return;
//     }
    
//     try {
//         currentUser = JSON.parse(userSession);
//         updateUserInfo();
//         console.log('Dashboard initialized for user:', currentUser.user.name);
//     } catch (error) {
//         console.error('Error parsing user session:', error);
//         window.location.href = '/index.html';
//     }
// }

function updateUserInfo() {
    if (currentUser && currentUser.user) {
        document.getElementById('userName').textContent = currentUser.user.name || 'User';
        document.getElementById('userSubscription').textContent = currentUser.user.subscription || 'Free Plan';
    }
}

function setupEventListeners() {
    console.log('Setting up event listeners...');
    
    // Navigation - FIXED: Use event delegation for better handling
    document.querySelector('.sidebar-nav').addEventListener('click', function(e) {
        const navLink = e.target.closest('.nav-link');
        if (navLink) {
            e.preventDefault();
            const section = navLink.getAttribute('data-section');
            console.log('Navigation clicked:', section);
            switchSection(section);
            
            // Close mobile menu if open
            if (window.innerWidth <= 768) {
                const sidebar = document.querySelector('.admin-sidebar');
                if (sidebar) {
                    sidebar.classList.remove('mobile-open');
                }
            }
        }
    });

    // Mobile menu
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', toggleMobileMenu);
    }

    // Sidebar toggle
    const sidebarToggle = document.getElementById('sidebarToggle');
    if (sidebarToggle) {
        sidebarToggle.addEventListener('click', toggleSidebar);
    }

    // Settings tabs - FIXED: Proper event delegation
    document.querySelector('.settings-tabs').addEventListener('click', function(e) {
        const tabBtn = e.target.closest('.tab-btn');
        if (tabBtn) {
            const tabName = tabBtn.getAttribute('data-tab');
            console.log('Settings tab clicked:', tabName);
            switchTab(tabName);
        }
    });

    // Session filter
    const sessionFilter = document.getElementById('sessionFilter');
    if (sessionFilter) {
        sessionFilter.addEventListener('change', filterSessions);
    }

    const sessionSearch = document.getElementById('sessionSearch');
    if (sessionSearch) {
        sessionSearch.addEventListener('input', filterSessions);
    }

    // Stats timeframe
    const statsTimeframe = document.getElementById('statsTimeframe');
    if (statsTimeframe) {
        statsTimeframe.addEventListener('change', loadUserStatistics);
    }

    console.log('Event listeners setup complete');
}

function switchSection(sectionName) {
    console.log('Switching to section:', sectionName);
    
    // Remove active class from all nav items
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });

    // Add active class to current nav item
    const currentNavLink = document.querySelector(`[data-section="${sectionName}"]`);
    if (currentNavLink) {
        currentNavLink.parentElement.classList.add('active');
    }

    // Hide all sections
    document.querySelectorAll('.content-section').forEach(section => {
        section.classList.remove('active');
    });

    // Show current section
    const currentSectionElement = document.getElementById(`${sectionName}-section`);
    if (currentSectionElement) {
        currentSectionElement.classList.add('active');
        currentSectionElement.classList.add('fade-in');
        
        // Remove animation class after animation completes
        setTimeout(() => {
            currentSectionElement.classList.remove('fade-in');
        }, 300);
    }

    // Update page title
    const titles = {
        overview: 'Dashboard Overview',
        sessions: 'My Sessions',
        subscription: 'My Subscription',
        statistics: 'Usage Statistics',
        settings: 'Bot Settings',
        payments: 'Payment History'
    };
    
    const pageTitle = document.getElementById('pageTitle');
    if (pageTitle && titles[sectionName]) {
        pageTitle.textContent = titles[sectionName];
        pageTitle.classList.add('slide-in');
        
        setTimeout(() => {
            pageTitle.classList.remove('slide-in');
        }, 300);
    }

    // Load section-specific data
    loadSectionData(sectionName);
}

function switchTab(tabName) {
    console.log('Switching to tab:', tabName);
    
    // Remove active class from all tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Remove active class from all tab content
    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    
    // Add active class to current tab button
    const currentTabBtn = document.querySelector(`[data-tab="${tabName}"]`);
    if (currentTabBtn) {
        currentTabBtn.classList.add('active');
    }
    
    // Add active class to current tab content
    const currentTabContent = document.getElementById(`${tabName}-settings`);
    if (currentTabContent) {
        currentTabContent.classList.add('active');
        currentTabContent.classList.add('fade-in');
        
        setTimeout(() => {
            currentTabContent.classList.remove('fade-in');
        }, 300);
    }
}

function loadSectionData(section) {
    console.log('Loading data for section:', section);
    
    switch(section) {
        case 'overview':
            loadOverviewData();
            break;
        case 'sessions':
            loadUserSessions();
            break;
        case 'subscription':
            loadSubscriptionInfo();
            break;
        case 'statistics':
            loadUserStatistics();
            break;
        case 'settings':
            loadSettings();
            break;
        case 'payments':
            loadPaymentHistory();
            break;
    }
}

// Socket.io connection
function connectToServer() {
    try {
        const socket = io('http://localhost:3000');
        
        socket.emit('join-user-room', currentUser.user.id);
        
        socket.on('qrCode', (data) => {
            console.log('QR code received');
            displayQRCode(data.qr, data.sessionId);
        });
        
        socket.on('sessionReady', (data) => {
            showNotification('WhatsApp session connected successfully!', 'success');
            loadUserSessions();
        });
        
        socket.on('newMessage', (data) => {
            addToActivityLog(`New message from ${data.from}: ${data.body}`);
        });
        
        socket.on('connect', () => {
            console.log('Connected to server');
            updateConnectionStatus(true);
        });
        
        socket.on('disconnect', () => {
            console.log('Disconnected from server');
            updateConnectionStatus(false);
        });
        
    } catch (error) {
        console.error('Error connecting to server:', error);
    }
}

function updateConnectionStatus(connected) {
    const statusElement = document.getElementById('connectionStatus');
    if (!statusElement) return;

    if (connected) {
        statusElement.innerHTML = '<div class="status-indicator online"></div><span>Connected</span>';
    } else {
        statusElement.innerHTML = '<div class="status-indicator offline"></div><span>Disconnected</span>';
    }
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

// Overview section
function loadOverviewData() {
    updateOverviewStats();
    loadRecentActivity();
}

function updateOverviewStats() {
    const activeSessions = userSessions.filter(s => s.status === 'connected').length;
    const totalMessages = userSessions.reduce((sum, session) => sum + (session.messageCount || 0), 0);
    
    document.getElementById('activeSessionsCount').textContent = activeSessions;
    document.getElementById('messagesToday').textContent = Math.floor(totalMessages * 0.05);
    document.getElementById('groupsManaged').textContent = userSessions.length;
    
    // Update plan days (mock data)
    const daysLeft = userSubscription?.daysRemaining || 30;
    document.getElementById('planDaysLeft').textContent = daysLeft;
    document.getElementById('planStatus').textContent = currentUser.user.subscription || 'Free';
    document.getElementById('sessionLimit').textContent = `Limit: ${userSubscription?.limits?.maxSessions || 1}`;
}

function loadRecentActivity() {
    const activities = [
        { type: 'info', message: 'Welcome to your dashboard!', time: 'Just now' },
        { type: 'success', message: 'Dashboard initialized successfully', time: '1 minute ago' }
    ];
    
    const activityList = document.getElementById('recentActivityList');
    if (activityList) {
        activityList.innerHTML = activities.map(activity => `
            <div class="activity-item ${activity.type}">
                <div class="activity-icon">
                    <i class="fas fa-${activity.type === 'success' ? 'check' : 'info-circle'}"></i>
                </div>
                <div class="activity-content">
                    <p>${activity.message}</p>
                    <span class="activity-time">${activity.time}</span>
                </div>
            </div>
        `).join('');
    }
}

// Session management
async function loadUserSessions() {
    try {
        // Mock data for demonstration
        userSessions = [
            { 
                sessionId: 'session-001', 
                status: 'connected', 
                phone: '+1234567890', 
                uptime: '2h 30m', 
                messageCount: 145 
            },
            { 
                sessionId: 'session-002', 
                status: 'waiting_qr', 
                phone: null, 
                uptime: '0m', 
                messageCount: 0 
            }
        ];
        
        renderUserSessions();
        updateSessionStats();
        
    } catch (error) {
        console.error('Error loading sessions:', error);
        showNotification('Error loading sessions', 'error');
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
    showNotification('Creating new session...', 'info');
    showQRModal();
    
    // Simulate session creation
    setTimeout(() => {
        const newSession = {
            sessionId: 'session-' + Date.now(),
            status: 'waiting_qr',
            phone: null,
            uptime: '0m',
            messageCount: 0
        };
        userSessions.push(newSession);
        renderUserSessions();
        showNotification('New session created! Scan the QR code.', 'success');
    }, 1000);
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
                    <p style="margin-top: 10px; font-size: 12px; color: #666;">QR Code Ready</p>
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
        // Mock subscription data
        userSubscription = {
            subscription: currentUser.user.subscription || 'free',
            paymentStatus: 'active',
            daysRemaining: 30,
            limits: { maxSessions: 1 },
            features: ['Basic features']
        };
        
        updateSubscriptionDisplay();
        loadAvailablePlans();
        loadCurrentPlan();
        
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
        const plans = [
            {
                id: 'starter',
                name: 'Starter Plan',
                amount: 29,
                features: [
                    'Basic group tagging (tagall)',
                    'Contact auto-save',
                    'Basic media sharing',
                    '5 active sessions',
                    'Standard support'
                ]
            },
            {
                id: 'professional', 
                name: 'Professional Plan',
                amount: 79,
                features: [
                    'All Starter features',
                    'Advanced tagging (tagallexcept)',
                    'Event & meeting scheduling',
                    'Reminder management',
                    '25 active sessions',
                    'Priority support'
                ]
            }
        ];
        
        renderUpgradePlans(plans);
    } catch (error) {
        console.error('Error loading plans:', error);
    }
}

function renderUpgradePlans(plans) {
    const container = document.getElementById('upgradePlansContainer');
    if (!container) return;
    
    container.innerHTML = plans.map(plan => `
        <div class="plan-card-upgrade">
            <div class="plan-header">
                <h4>${plan.name}</h4>
                <span class="plan-price">₦${plan.amount}/month</span>
            </div>
            <div class="plan-features">
                ${plan.features.map(feature => `
                    <div class="feature-item">
                        <i class="fas fa-check"></i>
                        <span>${feature}</span>
                    </div>
                `).join('')}
            </div>
            <button class="btn-primary" onclick="selectPlan('${plan.id}')">
                Select Plan
            </button>
        </div>
    `).join('');
}

function selectPlan(planId) {
    showNotification(`Selected plan: ${planId}`, 'info');
    closeUpgradeModal();
    // In real implementation, redirect to payment page
    // window.location.href = `/payment.html?plan=${planId}`;
}

function loadCurrentPlan() {
    const currentPlan = {
        name: currentUser.user.subscription || 'Free Plan',
        price: 0,
        features: [
            'Basic group tagging',
            '1 active session', 
            'Standard support'
        ]
    };
    
    renderCurrentPlan(currentPlan);
}

function renderCurrentPlan(plan) {
    const nameElement = document.getElementById('currentPlanName');
    const priceElement = document.getElementById('currentPlanPrice');
    const featuresContainer = document.getElementById('currentPlanFeatures');
    
    if (nameElement) nameElement.textContent = plan.name;
    if (priceElement) priceElement.textContent = `₦${plan.price}`;
    
    if (featuresContainer) {
        featuresContainer.innerHTML = plan.features.map(feature => `
            <div class="feature-item">
                <i class="fas fa-check"></i>
                <span>${feature}</span>
            </div>
        `).join('');
    }
}

function loadAvailablePlans() {
    const plans = [
        {
            id: 'starter',
            name: 'Starter Plan',
            amount: 29,
            features: [
                'Basic group tagging (tagall)',
                'Contact auto-save',
                'Basic media sharing',
                '5 active sessions',
                'Standard support'
            ]
        },
        {
            id: 'professional', 
            name: 'Professional Plan',
            amount: 79,
            features: [
                'All Starter features',
                'Advanced tagging (tagallexcept)',
                'Event & meeting scheduling',
                'Reminder management',
                '25 active sessions',
                'Priority support'
            ]
        }
    ];
    
    renderAvailablePlans(plans);
}

function renderAvailablePlans(plans) {
    const container = document.getElementById('availablePlansGrid');
    if (!container) return;
    
    container.innerHTML = plans.map(plan => `
        <div class="plan-card-upgrade">
            <div class="plan-header">
                <h4>${plan.name}</h4>
                <span class="plan-price">₦${plan.amount}/month</span>
            </div>
            <div class="plan-features">
                ${plan.features.map(feature => `
                    <div class="feature-item">
                        <i class="fas fa-check"></i>
                        <span>${feature}</span>
                    </div>
                `).join('')}
            </div>
            <button class="btn-primary" onclick="selectPlan('${plan.id}')">
                Select Plan
            </button>
        </div>
    `).join('');
}

// Statistics
async function loadUserStatistics() {
    updateStatisticsDisplay();
}

function updateStatisticsDisplay() {
    const activeSessions = userSessions.filter(s => s.status === 'connected').length;
    const totalMessages = userSessions.reduce((sum, session) => sum + (session.messageCount || 0), 0);
    
    document.getElementById('totalMessages').textContent = totalMessages.toLocaleString();
    document.getElementById('totalGroups').textContent = userSessions.length;
    document.getElementById('commandsUsed').textContent = Math.floor(totalMessages * 0.1);
}

// Settings
function loadSettings() {
    loadAvailableCommands();
}

function loadAvailableCommands() {
    const commands = [
        { name: '!tagall', description: 'Tag all group members', enabled: true },
        { name: '!tagallexcept', description: 'Tag all except specific members', enabled: currentUser.user.subscription !== 'free' },
        { name: '!meeting', description: 'Schedule meetings', enabled: currentUser.user.subscription !== 'free' },
        { name: '!savecontact', description: 'Save contacts automatically', enabled: true }
    ];
    
    renderAvailableCommands(commands);
}

function renderAvailableCommands(commands) {
    const container = document.getElementById('availableCommandsList');
    if (!container) return;
    
    container.innerHTML = commands.map(cmd => `
        <div class="setting-item">
            <label for="cmd-${cmd.name}">
                <strong>${cmd.name}</strong> - ${cmd.description}
            </label>
            <label class="toggle-switch">
                <input type="checkbox" id="cmd-${cmd.name}" ${cmd.enabled ? 'checked' : ''} ${!cmd.enabled ? 'disabled' : ''}>
                <span class="slider ${!cmd.enabled ? 'disabled' : ''}"></span>
            </label>
        </div>
    `).join('');
}

// Payment History
async function loadPaymentHistory() {
    try {
        // Mock payment data
        const payments = [
            {
                reference: 'PAY-001',
                amount: 29,
                status: 'success',
                createdAt: new Date('2024-01-15'),
                metadata: { subscription: 'starter' }
            }
        ];
        
        renderPaymentHistory(payments);
        
    } catch (error) {
        console.error('Error loading payment history:', error);
    }
}

function renderPaymentHistory(payments) {
    const tbody = document.getElementById('paymentsTableBody');
    if (!tbody) return;

    if (payments.length === 0) {
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

    tbody.innerHTML = payments.map(payment => `
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
    // Simple notification implementation
    console.log(`[${type.toUpperCase()}] ${message}`);
    alert(`[${type.toUpperCase()}] ${message}`); // Temporary until we implement proper notifications
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
    const sidebar = document.querySelector('.admin-sidebar');
    const toggleIcon = document.querySelector('#sidebarToggle i');
    
    if (sidebar) {
        sidebar.classList.toggle('collapsed');
        
        if (toggleIcon) {
            if (sidebar.classList.contains('collapsed')) {
                toggleIcon.className = 'fas fa-chevron-right';
            } else {
                toggleIcon.className = 'fas fa-chevron-left';
            }
        }
    }
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

function initializeAllSections() {
    loadCurrentPlan();
    loadAvailablePlans();
    loadAvailableCommands();
    updateStatisticsDisplay();
}

// Placeholder functions
function viewSession(sessionId) {
    showNotification(`Viewing session: ${sessionId}`, 'info');
}

function restartSession(sessionId) {
    showNotification(`Restarting session: ${sessionId}`, 'warning');
}

function deleteSession(sessionId) {
    if (confirm('Are you sure you want to delete this session?')) {
        userSessions = userSessions.filter(s => s.sessionId !== sessionId);
        renderUserSessions();
        showNotification(`Session ${sessionId} deleted`, 'success');
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
    showNotification('Filtering sessions...', 'info');
}

function viewSessions() {
    switchSection('sessions');
}