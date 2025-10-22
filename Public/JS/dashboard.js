let currentUser = null;
let userSessions = [];
let userSubscription = null;
let socket = null;

// Configuration
const CONFIG = {
    API_BASE: window.location.origin,
    SOCKET_URL: window.location.origin,
    REFRESH_INTERVAL: 30000 // 30 seconds
};

// Initialize dashboard
document.addEventListener('DOMContentLoaded', function() {
    initializeDashboard();
    setupEventListeners();
    connectToServer();
    startAutoRefresh();
});

// FIXED: Authentication check function
function initializeDashboard() {
    showLoading(true);

    const userSession = localStorage.getItem('userSession');
    if (!userSession) {
        window.location.href = '/index.html';
        return;
    }

    try {
        currentUser = JSON.parse(userSession);
        if (!currentUser || !currentUser.token) {
            throw new Error('Invalid session data');
        }
        
        updateUserInfo();
        loadUserData();
        initializeAllSections();
    } catch (error) {
        console.error('Invalid user session:', error);
        localStorage.removeItem('userSession');
        window.location.href = '/index.html';
    } finally {
        showLoading(false);
    }
}

function updateUserInfo() {
    if (!currentUser || !currentUser.user) return;

    const userName = document.getElementById('userName');
    const userSubscription = document.getElementById('userSubscription');
    
    if (userName) userName.textContent = currentUser.user.name || 'User';
    if (userSubscription) userSubscription.textContent = currentUser.user.subscription || 'Free Plan';
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
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const sidebarToggle = document.getElementById('sidebarToggle');

    if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', toggleMobileMenu);
    if (sidebarToggle) sidebarToggle.addEventListener('click', toggleSidebar);

    // Settings tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            switchTab(this.getAttribute('data-tab'));
        });
    });

    // Session filters
    const sessionFilter = document.getElementById('sessionFilter');
    const sessionSearch = document.getElementById('sessionSearch');

    if (sessionFilter) sessionFilter.addEventListener('change', filterSessions);
    if (sessionSearch) sessionSearch.addEventListener('input', filterSessions);

    // Statistics timeframe
    const statsTimeframe = document.getElementById('statsTimeframe');
    if (statsTimeframe) {
        statsTimeframe.addEventListener('change', function() {
            loadUserStatistics(this.value);
        });
    }
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

    const pageTitle = document.getElementById('pageTitle');
    if (pageTitle) pageTitle.textContent = titles[sectionName] || 'Dashboard';

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
        case 'settings':
            loadUserSettings();
            break;
    }
}

// FIXED: Socket.io connection with proper error handling
function connectToServer() {
    if (!currentUser) {
        console.error('No current user found');
        return;
    }

    try {
        console.log('Connecting to server...');
        socket = io(CONFIG.SOCKET_URL, {
            auth: {
                token: currentUser.token
            },
            transports: ['websocket', 'polling']
        });
        
        socket.on('connect', () => {
            console.log('✅ Connected to server');
            updateConnectionStatus(true);
            
            // Join user room after connection
            if (currentUser && currentUser.user) {
                socket.emit('join-user-room', currentUser.user.id);
            }
        });
        
        socket.on('disconnect', (reason) => {
            console.log('❌ Disconnected from server:', reason);
            updateConnectionStatus(false);
        });
        
        socket.on('qrCode', (data) => {
            console.log('📱 QR Code received for session:', data.sessionId);
            displayQRCode(data.qr, data.sessionId);
        });
        
        socket.on('sessionReady', (data) => {
            console.log('✅ Session ready:', data.sessionId);
            showNotification('WhatsApp session connected successfully!', 'success');
            loadUserSessions();
            closeQRModal();
        });
        
        socket.on('sessionDisconnected', (data) => {
            console.log('⚠️ Session disconnected:', data.sessionId);
            showNotification(`Session ${data.sessionId} disconnected`, 'warning');
            loadUserSessions();
        });
        
        socket.on('connect_error', (error) => {
            console.error('Socket connection error:', error);
            showNotification('Connection error occurred', 'error');
        });
        
    } catch (error) {
        console.error('Failed to connect to server:', error);
        updateConnectionStatus(false);
    }
}
function updateConnectionStatus(isConnected) {
    const statusElement = document.getElementById('connectionStatus');
    if (!statusElement) return;

    const indicator = statusElement.querySelector('.status-indicator');
    const text = statusElement.querySelector('span');

    if (isConnected) {
        indicator.className = 'status-indicator online';
        text.textContent = 'Connected';
    } else {
        indicator.className = 'status-indicator offline';
        text.textContent = 'Disconnected';
    }
}

// IMPROVED: User data loading with error handling
async function loadUserData() {
    if (!currentUser) return;

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/users/profile`, {
            headers: {
                'Authorization': `Bearer ${currentUser.token}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            currentUser.user = { ...currentUser.user, ...data.data.user };
            updateUserInfo();
            updateSubscriptionDisplay();
            
            // Update localStorage with fresh data
            localStorage.setItem('userSession', JSON.stringify(currentUser));
        } else if (response.status === 401) {
            // Token expired
            logout();
        }
    } catch (error) {
        console.error('Error loading user data:', error);
        showNotification('Failed to load user data', 'error');
    }
}

// IMPROVED: Session management with better error handling
async function loadUserSessions() {
    if (!currentUser) return;

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/sessions/my-sessions`, {
            headers: {
                'Authorization': `Bearer ${currentUser.token}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            userSessions = data.data.sessions || [];
            renderUserSessions();
            updateSessionStats();
        } else {
            throw new Error(`HTTP ${response.status}`);
        }
    } catch (error) {
        console.error('Error loading sessions:', error);
        showNotification('Failed to load sessions', 'error');
        
        // Show empty state
        const grid = document.getElementById('userSessionsGrid');
        if (grid) {
            grid.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-exclamation-triangle" style="font-size: 48px; color: #f56565; margin-bottom: 16px;"></i>
                    <h3>Failed to Load Sessions</h3>
                    <p>Unable to connect to the server. Please try refreshing.</p>
                    <button class="btn-primary" onclick="loadUserSessions()">
                        <i class="fas fa-refresh"></i>
                        Retry
                    </button>
                </div>
            `;
        }
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
                    <span class="status-text">${formatStatus(session.status)}</span>
                </div>
                <div class="session-actions">
                    <button class="action-btn" onclick="viewSession('${session.sessionId}')" title="View Details">
                        <i class="fas fa-eye"></i>
                    </button>
                    <button class="action-btn" onclick="restartSession('${session.sessionId}')" title="Restart">
                        <i class="fas fa-redo"></i>
                    </button>
                    <button class="action-btn danger" onclick="deleteSession('${session.sessionId}')" title="Delete">
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
                        <span class="stat-value">${formatUptime(session.uptime)}</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Messages</span>
                        <span class="stat-value">${session.messageCount || 0}</span>
                    </div>
                </div>
            </div>
        </div>
    `).join('');

    const mySessionCount = document.getElementById('mySessionCount');
    if (mySessionCount) {
        mySessionCount.textContent = userSessions.filter(s => s.status === 'connected').length;
    }
}

// FIXED: Complete session filtering implementation
function filterSessions() {
    const filter = document.getElementById('sessionFilter')?.value || 'all';
    const search = document.getElementById('sessionSearch')?.value.toLowerCase() || '';

    const filteredSessions = userSessions.filter(session => {
        const matchesFilter = filter === 'all' || session.status === filter;
        const matchesSearch = !search || 
            session.sessionId.toLowerCase().includes(search) ||
            (session.phone && session.phone.toLowerCase().includes(search));
        
        return matchesFilter && matchesSearch;
    });

    renderFilteredSessions(filteredSessions);
}

function renderFilteredSessions(sessions) {
    const grid = document.getElementById('userSessionsGrid');
    if (!grid) return;

    // Temporarily store original sessions
    const originalSessions = userSessions;
    userSessions = sessions;
    renderUserSessions();
    userSessions = originalSessions;
}

async function createNewSession() {
    if (!currentUser) return;

    try {
        showLoading(true);
        
        const response = await fetch(`${CONFIG.API_BASE}/api/sessions/create`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${currentUser.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
        });
        
        const data = await response.json();
        
        if (data.success) {
            showNotification('New session created! Scan the QR code to connect.', 'success');
            showQRModal();
            loadUserSessions();
        } else {
            showNotification(data.message || 'Failed to create session', 'error');
        }
    } catch (error) {
        console.error('Error creating session:', error);
        showNotification('Error creating session', 'error');
    } finally {
        showLoading(false);
    }
}

// IMPROVED: QR Code display with proper error handling
function displayQRCode(qrData, sessionId) {
    const qrCodeDisplay = document.getElementById('qrCodeDisplay');
    if (!qrCodeDisplay) {
        console.error('QR code display element not found');
        return;
    }

    // Clear previous content and update structure
    qrCodeDisplay.innerHTML = '';
    qrCodeDisplay.className = 'qr-code-active';
    
    // Create QR code container
    const qrCodeContainer = document.createElement('div');
    qrCodeContainer.id = `qrcode-${sessionId}`;
    qrCodeContainer.className = 'qr-code-canvas';
    
    qrCodeDisplay.appendChild(qrCodeContainer);

    // Generate QR code
    try {
        if (typeof QRCode !== 'undefined') {
            new QRCode(qrCodeContainer, {
                text: qrData,
                width: 256,
                height: 256,
                colorDark: "#000000",
                colorLight: "#ffffff",
                correctLevel: QRCode.CorrectLevel.H
            });
            
            console.log('✅ QR code generated successfully');
        } else {
            // Fallback display
            qrCodeContainer.innerHTML = `
                <div class="qr-fallback">
                    <i class="fas fa-qrcode" style="font-size: 64px; color: #667eea; margin-bottom: 16px;"></i>
                    <h4>QR Code Ready</h4>
                    <p style="color: #666; margin: 10px 0;">QR Code library not loaded.</p>
                    <p style="font-size: 12px; color: #999;">Please check browser console</p>
                </div>
            `;
            console.error('QRCode library not loaded. Add: <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>');
        }
    } catch (error) {
        console.error('Error generating QR code:', error);
        qrCodeContainer.innerHTML = `
            <div class="qr-error">
                <i class="fas fa-exclamation-triangle" style="font-size: 64px; color: #f56565; margin-bottom: 16px;"></i>
                <h4>QR Code Error</h4>
                <p style="color: #666;">Failed to generate QR code</p>
            </div>
        `;
    }
    
    // Show the modal
    showQRModal();
}

// IMPROVED: Subscription management
async function loadSubscriptionInfo() {
    if (!currentUser) return;

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/payments/subscription-status`, {
            headers: {
                'Authorization': `Bearer ${currentUser.token}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            userSubscription = data.data;
            updateSubscriptionDisplay();
            loadCurrentPlan();
            loadAvailablePlans();
        }
    } catch (error) {
        console.error('Error loading subscription:', error);
        showNotification('Failed to load subscription info', 'error');
    }
}

function updateSubscriptionDisplay() {
    if (!userSubscription) return;

    const elements = {
        currentPlan: document.getElementById('currentPlan'),
        paymentStatus: document.getElementById('paymentStatus'),
        expiryDate: document.getElementById('expiryDate'),
        maxSessions: document.getElementById('maxSessions'),
        planDaysLeft: document.getElementById('planDaysLeft'),
        planStatus: document.getElementById('planStatus'),
        sessionLimit: document.getElementById('sessionLimit')
    };

    if (elements.currentPlan) elements.currentPlan.textContent = userSubscription.subscription || 'Free';
    if (elements.paymentStatus) elements.paymentStatus.textContent = userSubscription.paymentStatus || 'Active';
    if (elements.expiryDate) elements.expiryDate.textContent = userSubscription.daysRemaining ? `${userSubscription.daysRemaining} days` : 'Never';
    if (elements.maxSessions) elements.maxSessions.textContent = userSubscription.limits?.maxSessions || 1;
    if (elements.planDaysLeft) elements.planDaysLeft.textContent = userSubscription.daysRemaining || 0;
    if (elements.planStatus) elements.planStatus.textContent = userSubscription.subscription || 'Free';
    if (elements.sessionLimit) elements.sessionLimit.textContent = `Limit: ${userSubscription.limits?.maxSessions || 1}`;
}

// IMPROVED: Statistics with real data
async function loadUserStatistics(timeframe = 'today') {
    if (!currentUser) return;

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/statistics/user?timeframe=${timeframe}`, {
            headers: {
                'Authorization': `Bearer ${currentUser.token}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            updateStatisticsDisplay(data.data);
        } else {
            // Fallback to calculated stats
            updateStatisticsDisplay();
        }
    } catch (error) {
        console.error('Error loading statistics:', error);
        updateStatisticsDisplay();
    }
}

function updateStatisticsDisplay(stats = null) {
    if (stats) {
        // Use real API data
        const totalMessages = document.getElementById('totalMessages');
        const totalGroups = document.getElementById('totalGroups');
        const commandsUsed = document.getElementById('commandsUsed');
        const messagesToday = document.getElementById('messagesToday');
        const groupsManaged = document.getElementById('groupsManaged');
        
        if (totalMessages) totalMessages.textContent = stats.totalMessages?.toLocaleString() || '0';
        if (totalGroups) totalGroups.textContent = stats.totalGroups || '0';
        if (commandsUsed) commandsUsed.textContent = stats.commandsUsed || '0';
        if (messagesToday) messagesToday.textContent = stats.messagesToday || '0';
        if (groupsManaged) groupsManaged.textContent = stats.groupsManaged || '0';
    } else {
        // Calculate from available data
        const activeSessions = userSessions.filter(s => s.status === 'connected').length;
        const totalMessages = userSessions.reduce((sum, session) => sum + (session.messageCount || 0), 0);

        const totalMessagesEl = document.getElementById('totalMessages');
        const totalGroupsEl = document.getElementById('totalGroups');
        const commandsUsedEl = document.getElementById('commandsUsed');
        const messagesTodayEl = document.getElementById('messagesToday');
        const groupsManagedEl = document.getElementById('groupsManaged');

        if (totalMessagesEl) totalMessagesEl.textContent = totalMessages.toLocaleString();
        if (totalGroupsEl) totalGroupsEl.textContent = userSessions.length;
        if (commandsUsedEl) commandsUsedEl.textContent = Math.floor(totalMessages * 0.1);
        if (messagesTodayEl) messagesTodayEl.textContent = Math.floor(totalMessages * 0.05);
        if (groupsManagedEl) groupsManagedEl.textContent = userSessions.length;
    }
}

// IMPROVED: Settings management with persistence
async function loadUserSettings() {
    if (!currentUser) return;

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/users/settings`, {
            headers: {
                'Authorization': `Bearer ${currentUser.token}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            populateSettings(data.data.settings);
        }
    } catch (error) {
        console.error('Error loading settings:', error);
        // Load default settings
        populateSettings({});
    }

    loadAvailableCommands();
}

function populateSettings(settings) {
    const elements = {
        autoSaveContacts: document.getElementById('autoSaveContacts'),
        autoJoinGroups: document.getElementById('autoJoinGroups'),
        commandPrefix: document.getElementById('commandPrefix'),
        notifyNewMessages: document.getElementById('notifyNewMessages'),
        notifySessionStatus: document.getElementById('notifySessionStatus')
    };

    if (elements.autoSaveContacts) elements.autoSaveContacts.checked = settings.autoSaveContacts !== false;
    if (elements.autoJoinGroups) elements.autoJoinGroups.checked = settings.autoJoinGroups === true;
    if (elements.commandPrefix) elements.commandPrefix.value = settings.commandPrefix || '!';
    if (elements.notifyNewMessages) elements.notifyNewMessages.checked = settings.notifyNewMessages !== false;
    if (elements.notifySessionStatus) elements.notifySessionStatus.checked = settings.notifySessionStatus !== false;
}

async function saveSettings() {
    if (!currentUser) return;

    const settings = {
        autoSaveContacts: document.getElementById('autoSaveContacts')?.checked || false,
        autoJoinGroups: document.getElementById('autoJoinGroups')?.checked || false,
        commandPrefix: document.getElementById('commandPrefix')?.value || '!',
        notifyNewMessages: document.getElementById('notifyNewMessages')?.checked || false,
        notifySessionStatus: document.getElementById('notifySessionStatus')?.checked || false
    };

    try {
        showLoading(true);
        
        const response = await fetch(`${CONFIG.API_BASE}/api/users/settings`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${currentUser.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(settings)
        });
        
        const data = await response.json();
        
        if (data.success) {
            showNotification('Settings saved successfully', 'success');
        } else {
            showNotification(data.message || 'Failed to save settings', 'error');
        }
    } catch (error) {
        console.error('Error saving settings:', error);
        showNotification('Error saving settings', 'error');
    } finally {
        showLoading(false);
    }
}

// IMPROVED: Payment history
async function loadPaymentHistory() {
    if (!currentUser) return;

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/payments/history`, {
            headers: {
                'Authorization': `Bearer ${currentUser.token}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            renderPaymentHistory(data.data.transactions || []);
            updatePaymentStats(data.data.stats);
        }
    } catch (error) {
        console.error('Error loading payment history:', error);
        renderPaymentHistory([]);
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
            <td>${formatDate(payment.createdAt)}</td>
            <td>${payment.reference}</td>
            <td>${payment.metadata?.subscription || 'Unknown'}</td>
            <td>₦${payment.amount.toLocaleString()}</td>
            <td>
                <span class="status-badge ${payment.status === 'success' ? 'success' : 'error'}">
                    ${payment.status}
                </span>
            </td>
            <td>
                <button class="action-btn" onclick="viewReceipt('${payment.reference}')" title="View Receipt">
                    <i class="fas fa-receipt"></i>
                </button>
            </td>
        </tr>
    `).join('');
}

function updatePaymentStats(stats) {
    if (!stats) return;

    const elements = {
        totalSpent: document.getElementById('totalSpent'),
        paymentsCount: document.getElementById('paymentsCount'),
        lastPayment: document.getElementById('lastPayment')
    };

    if (elements.totalSpent) elements.totalSpent.textContent = `₦${stats.totalSpent?.toLocaleString() || '0'}`;
    if (elements.paymentsCount) elements.paymentsCount.textContent = stats.paymentsCount || '0';
    if (elements.lastPayment) elements.lastPayment.textContent = stats.lastPayment ? formatDate(stats.lastPayment) : '-';
}

// Modal management
function showQRModal() {
    const qrModal = document.getElementById('qrModal');
    if (qrModal) {
        qrModal.classList.add('active');
        document.body.style.overflow = 'hidden'; // Prevent scrolling
        console.log('✅ QR modal opened');
    } else {
        console.error('QR modal element not found');
    }
}

function closeQRModal() {
    const qrModal = document.getElementById('qrModal');
    if (qrModal) {
        qrModal.classList.remove('active');
        document.body.style.overflow = 'auto'; // Restore scrolling
        
        // Reset QR code display
        const qrCodeDisplay = document.getElementById('qrCodeDisplay');
        if (qrCodeDisplay) {
            qrCodeDisplay.innerHTML = `
                <i class="fas fa-qrcode"></i>
                <p>Generating QR Code...</p>
            `;
            qrCodeDisplay.className = 'qr-placeholder';
        }
        
        console.log('✅ QR modal closed');
    }
}s

function closeQRModal() {
    const qrModal = document.getElementById('qrModal');
    if (qrModal) {
        qrModal.style.display = 'none';
        qrModal.classList.remove('active');
        // Restore body scroll
        document.body.style.overflow = 'auto';
        
        // Clear QR code content
        const qrContainer = document.getElementById('qrCodeDisplay');
        if (qrContainer) {
            qrContainer.innerHTML = '';
        }
    }
}

function closeQRModal() {
    const qrModal = document.getElementById('qrModal');
    if (qrModal) qrModal.classList.remove('active');
}

function showUpgradeModal() {
    const upgradeModal = document.getElementById('upgradeModal');
    if (upgradeModal) {
        upgradeModal.classList.add('active');
        loadUpgradePlans();
    }
}

function closeUpgradeModal() {
    const upgradeModal = document.getElementById('upgradeModal');
    if (upgradeModal) upgradeModal.classList.remove('active');
}

// IMPROVED: Plan management
async function loadUpgradePlans() {
    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/payments/plans`);
        if (response.ok) {
            const data = await response.json();
            renderUpgradePlans(data.data.plans);
        } else {
            // Fallback to static plans
            renderUpgradePlans(getStaticPlans());
        }
    } catch (error) {
        console.error('Error loading plans:', error);
        renderUpgradePlans(getStaticPlans());
    }
}

function getStaticPlans() {
    return [
        {
            id: 'starter',
            name: 'Starter Plan',
            amount: 2900,
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
            amount: 7900,
            features: [
                'All Starter features',
                'Advanced tagging (tagallexcept)',
                'Event & meeting scheduling',
                'Reminder management',
                '25 active sessions',
                'Priority support'
            ]
        },
        {
            id: 'business',
            name: 'Business Plan',
            amount: 14900,
            features: [
                'All Professional features',
                'Advanced admin controls',
                'Sudo user management',
                'System monitoring',
                '100 active sessions',
                'Broadcast messaging'
            ]
        },
        {
            id: 'enterprise',
            name: 'Enterprise Plan',
            amount: 27900,
            features: [
                'All Business features',
                'Unlimited active sessions',
                'Advanced automation workflows',
                'Custom bot commands',
                'API access',
                'White-label solution'
            ]
        }
    ];
}

function renderUpgradePlans(plans) {
    const container = document.getElementById('upgradePlansContainer');
    if (!container) return;

    container.innerHTML = plans.map(plan => `
        <div class="plan-card-upgrade">
            <div class="plan-header">
                <h4>${plan.name}</h4>
                <span class="plan-price">₦${(plan.amount / 100).toLocaleString()}/month</span>
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

function loadAvailablePlans() {
    const plans = getStaticPlans();
    renderAvailablePlans(plans);
}

function renderAvailablePlans(plans) {
    const container = document.getElementById('availablePlansGrid');
    if (!container) return;

    container.innerHTML = plans.map(plan => `
        <div class="plan-card-upgrade">
            <div class="plan-header">
                <h4>${plan.name}</h4>
                <span class="plan-price">₦${(plan.amount / 100).toLocaleString()}/month</span>
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

function loadCurrentPlan() {
    const currentPlan = {
        name: currentUser?.user?.subscription || 'Free Plan',
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
    const elements = {
        name: document.getElementById('currentPlanName'),
        price: document.getElementById('currentPlanPrice'),
        features: document.getElementById('currentPlanFeatures')
    };

    if (elements.name) elements.name.textContent = plan.name;
    if (elements.price) elements.price.textContent = `₦${plan.price.toLocaleString()}`;

    if (elements.features) {
        elements.features.innerHTML = plan.features.map(feature => `
            <div class="feature-item">
                <i class="fas fa-check"></i>
                <span>${feature}</span>
            </div>
        `).join('');
    }
}

function loadAvailableCommands() {
    const userSubscription = currentUser?.user?.subscription || 'free';

    const commands = [
        { name: '!tagall', description: 'Tag all group members', enabled: true },
        { name: '!tagallexcept', description: 'Tag all except specific members', enabled: userSubscription !== 'free' },
        { name: '!meeting', description: 'Schedule meetings', enabled: userSubscription !== 'free' },
        { name: '!savecontact', description: 'Save contacts automatically', enabled: true },
        { name: '!broadcast', description: 'Send broadcast messages', enabled: ['business', 'enterprise'].includes(userSubscription) },
        { name: '!reminder', description: 'Set reminders', enabled: userSubscription !== 'free' },
        { name: '!sudo', description: 'Admin commands', enabled: ['business', 'enterprise'].includes(userSubscription) }
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
                ${!cmd.enabled ? '<span class="upgrade-required">(Upgrade Required)</span>' : ''}
            </label>
            <label class="toggle-switch">
                <input type="checkbox" id="cmd-${cmd.name}" ${cmd.enabled ? 'checked' : ''} ${!cmd.enabled ? 'disabled' : ''}>
                <span class="slider ${!cmd.enabled ? 'disabled' : ''}"></span>
            </label>
        </div>
    `).join('');
}

// Action functions
function selectPlan(planId) {
    window.location.href = `/payment.html?plan=${planId}`;
}

function upgradeSubscription() {
    showUpgradeModal();
}

async function viewSession(sessionId) {
    // Could open a detailed session view modal
    showNotification(`Loading session details for: ${sessionId}`, 'info');
}

async function restartSession(sessionId) {
    if (!confirm('Are you sure you want to restart this session?')) return;

    try {
        showLoading(true);
        
        const response = await fetch(`${CONFIG.API_BASE}/api/sessions/${sessionId}/restart`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${currentUser.token}`,
                'Content-Type': 'application/json'
            }
        });
        
        const data = await response.json();
        
        if (data.success) {
            showNotification('Session restart initiated', 'success');
            loadUserSessions();
        } else {
            showNotification(data.message || 'Failed to restart session', 'error');
        }
    } catch (error) {
        console.error('Error restarting session:', error);
        showNotification('Error restarting session', 'error');
    } finally {
        showLoading(false);
    }
}

async function deleteSession(sessionId) {
    if (!confirm('Are you sure you want to delete this session? This action cannot be undone.')) return;

    try {
        showLoading(true);
        
        const response = await fetch(`${CONFIG.API_BASE}/api/sessions/${sessionId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${currentUser.token}`,
                'Content-Type': 'application/json'
            }
        });
        
        const data = await response.json();
        
        if (data.success) {
            showNotification('Session deleted successfully', 'success');
            loadUserSessions();
        } else {
            showNotification(data.message || 'Failed to delete session', 'error');
        }
    } catch (error) {
        console.error('Error deleting session:', error);
        showNotification('Error deleting session', 'error');
    } finally {
        showLoading(false);
    }
}

function openSettings() {
    switchSection('settings');
}

function viewSessions() {
    switchSection('sessions');
}

function exportPayments() {
    showNotification('Preparing export...', 'info');

    // Create CSV export
    const csvContent = "data:text/csv;charset=utf-8," + 
        "Date,Reference,Plan,Amount,Status\n" +
        userSessions.map(payment => 
            `${formatDate(payment.createdAt)},${payment.reference},${payment.metadata?.subscription || 'Unknown'},₦${payment.amount},${payment.status}`
        ).join("\n");

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `payment_history_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showNotification('Export completed', 'success');
}

function viewReceipt(reference) {
    // Open receipt in new window or modal
    window.open(`${CONFIG.API_BASE}/api/payments/receipt/${reference}`, '_blank');
}

// Utility functions
function showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.innerHTML = `
        <div class="notification-content">
            <i class="fas fa-${getNotificationIcon(type)}"></i>
            <span>${message}</span>
        </div>
        <button class="notification-close" onclick="this.parentElement.remove()">
            <i class="fas fa-times"></i>
        </button>
    `;

    // Add to page
    let container = document.querySelector('.notifications-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'notifications-container';
        document.body.appendChild(container);
    }

    container.appendChild(notification);

    // Auto remove after 5 seconds
    setTimeout(() => {
        if (notification.parentElement) {
            notification.remove();
        }
    }, 5000);

    console.log(`[${type.toUpperCase()}] ${message}`);
}

function getNotificationIcon(type) {
    const icons = {
        success: 'check-circle',
        error: 'exclamation-circle',
        warning: 'exclamation-triangle',
        info: 'info-circle'
    };
    return icons[type] || 'info-circle';
}

function addToActivityLog(message) {
    const activityList = document.getElementById('recentActivityList');
    if (!activityList) return;

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

    // Keep only last 10 activities
    const activities = activityList.querySelectorAll('.activity-item');
    if (activities.length > 10) {
        activities[activities.length - 1].remove();
    }
}

function showLoading(show) {
    const loading = document.getElementById('loadingOverlay');
    if (loading) {
        loading.style.display = show ? 'flex' : 'none';
    }
}

function updateSessionStats() {
    const totalSessions = userSessions.length;
    const activeSessions = userSessions.filter(s => s.status === 'connected').length;
    const totalMessages = userSessions.reduce((sum, session) => sum + (session.messageCount || 0), 0);

    const mySessionCount = document.getElementById('mySessionCount');
    const activeSessionCount = document.getElementById('activeSessionCount');
    const totalMessagesCount = document.getElementById('totalMessagesCount');

    if (mySessionCount) mySessionCount.textContent = activeSessions;
    if (activeSessionCount) activeSessionCount.textContent = activeSessions;
    if (totalMessagesCount) totalMessagesCount.textContent = totalMessages.toLocaleString();
}

function updateMessageStats() {
    // Update message statistics when new messages arrive
    const totalMessages = userSessions.reduce((sum, session) => sum + (session.messageCount || 0), 0);
    const totalMessagesEl = document.getElementById('totalMessages');
    const totalMessagesCountEl = document.getElementById('totalMessagesCount');

    if (totalMessagesEl) totalMessagesEl.textContent = totalMessages.toLocaleString();
    if (totalMessagesCountEl) totalMessagesCountEl.textContent = totalMessages.toLocaleString();
}

function formatStatus(status) {
    const statusMap = {
        'connected': 'Connected',
        'connecting': 'Connecting',
        'disconnected': 'Disconnected',
        'error': 'Error'
    };
    return statusMap[status] || status;
}

function formatUptime(uptime) {
    if (!uptime) return '0m';
    
    const seconds = Math.floor(uptime / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
}

function formatDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function switchTab(tabName) {
    // Update active tab
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

    const activeBtn = document.querySelector(`[data-tab="${tabName}"]`);
    const activeContent = document.getElementById(`${tabName}-tab`);

    if (activeBtn) activeBtn.classList.add('active');
    if (activeContent) activeContent.classList.add('active');
}

function toggleMobileMenu() {
    const mobileMenu = document.getElementById('mobileMenu');
    if (mobileMenu) mobileMenu.classList.toggle('active');
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.toggle('collapsed');
}

function initializeAllSections() {
    // Initialize all sections with default data
    loadUserSessions();
    loadSubscriptionInfo();
    loadUserStatistics();
    loadPaymentHistory();
    loadUserSettings();
}

function startAutoRefresh() {
    // Auto-refresh data every 30 seconds
    setInterval(() => {
        if (document.visibilityState === 'visible') {
            loadUserSessions();
            loadUserStatistics();
        }
    }, CONFIG.REFRESH_INTERVAL);
}

function logout() {
    if (socket) {
        socket.disconnect();
    }
    
    localStorage.removeItem('userSession');
    window.location.href = '/index.html';
}

// Close modals when clicking outside
document.addEventListener('click', function(e) {
    const qrModal = document.getElementById('qrModal');
    const upgradeModal = document.getElementById('upgradeModal');

    if (qrModal && e.target === qrModal) {
        closeQRModal();
    }
    if (upgradeModal && e.target === upgradeModal) {
        closeUpgradeModal();
    }
});

// Close mobile menu when clicking outside
document.addEventListener('click', function(e) {
    const mobileMenu = document.getElementById('mobileMenu');
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');

    if (mobileMenu && mobileMenu.classList.contains('active') && 
        !mobileMenu.contains(e.target) && 
        !mobileMenuBtn.contains(e.target)) {
        mobileMenu.classList.remove('active');
    }
});

// Handle page visibility changes
document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
        // Page became visible, refresh data
        loadUserSessions();
        loadUserStatistics();
    }
});

// Add CSS for notifications if not already present
if (!document.querySelector('#notification-styles')) {
    const style = document.createElement('style');
    style.id = 'notification-styles';
    style.textContent = `
        .notifications-container {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 10000;
            max-width: 400px;
        }
        
        .notification {
            background: white;
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 10px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            border-left: 4px solid #667eea;
            display: flex;
            align-items: center;
            justify-content: space-between;
            animation: slideInRight 0.3s ease;
        }
        
        .notification.success {
            border-left-color: #48bb78;
        }
        
        .notification.error {
            border-left-color: #f56565;
        }
        
        .notification.warning {
            border-left-color: #ed8936;
        }
        
        .notification-content {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .notification-close {
            background: none;
            border: none;
            cursor: pointer;
            color: #718096;
            padding: 4px;
        }
        
        @keyframes slideInRight {
            from {
                transform: translateX(100%);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
    `;
    document.head.appendChild(style);
}

// Close modal when clicking outside
document.addEventListener('click', function(e) {
    const qrModal = document.getElementById('qrModal');
    if (qrModal && e.target === qrModal) {
        closeQRModal();
    }
});

// Close modal with Escape key
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        closeQRModal();
    }
});