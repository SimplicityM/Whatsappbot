// Add this at the beginning of your DOMContentLoaded event handler
document.addEventListener('DOMContentLoaded', function() {
    // Check if required elements exist before setting up event listeners
    const requiredElements = [
        'mobileMenuBtn',
        'sidebarToggle', 
        'sessionFilter',
        'sessionSearch',
        'statsTimeframe'
    ];
    
    requiredElements.forEach(elementId => {
        const element = document.getElementById(elementId);
        if (!element) {
            console.warn(`⚠️ Element not found: ${elementId}`);
        }
    });
    
    // Then continue with your existing initialization
    initializeDashboard();
    setupEventListeners();
    connectToServer();
    startAutoRefresh();
});



// Update your initializeDashboard function
function initializeDashboard() {
    showLoading(true);

    const userSession = localStorage.getItem('userSession');
    if (!userSession) {
        window.location.href = '/index.html';
        return;
    }

    try {
        currentUser = JSON.parse(userSession);
        
        // Normalize user data
        currentUser = normalizeUserData(currentUser);
        
        if (!currentUser || !currentUser.token) {
            throw new Error('Invalid session data');
        }
        
        console.log('👤 Normalized user data:', {
            id: currentUser.user.id,
            _id: currentUser.user._id,
            name: currentUser.user.fullName
        });
        
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

let currentUser = null;
let userSessions = [];
let userSubscription = null;
let socket = null;

// Normalize user data - ensure id field exists
function normalizeUserData(userData) {
    if (userData && userData.user && userData.user._id) {
        // Copy _id to id for consistency
        userData.user.id = userData.user._id;
        console.log('🔄 Normalized user data:', { 
            id: userData.user.id, 
            _id: userData.user._id 
        });
    }
    return userData;
}

// Configuration
const CONFIG = {
    API_BASE: window.location.origin,
    SOCKET_URL: window.location.origin,
    REFRESH_INTERVAL: 30000 // 30 seconds
};



// FIXED: Authentication check function with normalization
// function initializeDashboard() {
//     showLoading(true);

//     const userSession = localStorage.getItem('userSession');
//     if (!userSession) {
//         window.location.href = '/index.html';
//         return;
//     }

//     try {
//         currentUser = JSON.parse(userSession);
        
//         // NORMALIZE USER DATA - This is the key fix!
//         currentUser = normalizeUserData(currentUser);
        
//         if (!currentUser || !currentUser.token) {
//             throw new Error('Invalid session data');
//         }
        
//         console.log('✅ User session loaded and normalized:', {
//             id: currentUser.user.id,
//             name: currentUser.user.fullName,
//             email: currentUser.user.email
//         });
        
//         updateUserInfo();
//         loadUserData();
//         initializeAllSections();
        
//     } catch (error) {
//         console.error('Invalid user session:', error);
//         localStorage.removeItem('userSession');
//         window.location.href = '/index.html';
//     } finally {
//         showLoading(false);
//     }
// }

function updateUserInfo() {
    if (!currentUser || !currentUser.user) return;

    const userName = document.getElementById('userName');
    const userSubscription = document.getElementById('userSubscription');
    
    if (userName) userName.textContent = currentUser.user.name || 'User';
    if (userSubscription) userSubscription.textContent = currentUser.user.subscription || 'Free Plan';
}

function setupEventListeners() {
    console.log('🔧 Setting up event listeners...');
    
    // Safe navigation function
    function safeAddListener(selector, event, handler) {
        const element = typeof selector === 'string' ? document.querySelector(selector) : selector;
        if (element && typeof handler === 'function') {
            element.addEventListener(event, handler);
            return true;
        } else {
            console.warn(`⚠️ Cannot add ${event} listener to:`, selector);
            return false;
        }
    }

    // Navigation - safe version
    document.querySelectorAll('.nav-link').forEach(link => {
        safeAddListener(link, 'click', function(e) {
            e.preventDefault();
            const section = this.getAttribute('data-section');
            switchSection(section);
        });
    });

    // Mobile menu - with null checks
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const sidebarToggle = document.getElementById('sidebarToggle');
    
    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', toggleMobileMenu);
    } else {
        console.warn('⚠️ mobileMenuBtn not found');
    }
    
    if (sidebarToggle) {
        sidebarToggle.addEventListener('click', toggleSidebar);
    } else {
        console.warn('⚠️ sidebarToggle not found');
    }

    // Settings tabs - safe version
    document.querySelectorAll('.tab-btn').forEach(btn => {
        safeAddListener(btn, 'click', function() {
            switchTab(this.getAttribute('data-tab'));
        });
    });

    // Session filters - with null checks
    const sessionFilter = document.getElementById('sessionFilter');
    const sessionSearch = document.getElementById('sessionSearch');

    if (sessionFilter) {
        sessionFilter.addEventListener('change', filterSessions);
    } else {
        console.warn('⚠️ sessionFilter not found');
    }
    
    if (sessionSearch) {
        sessionSearch.addEventListener('input', filterSessions);
    } else {
        console.warn('⚠️ sessionSearch not found');
    }

    // Statistics timeframe - with null check
    const statsTimeframe = document.getElementById('statsTimeframe');
    if (statsTimeframe) {
        statsTimeframe.addEventListener('change', function() {
            loadUserStatistics(this.value);
        });
    } else {
        console.warn('⚠️ statsTimeframe not found');
    }
    
    console.log('✅ Event listeners setup completed');
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

// IMPROVED: Socket.io connection with better timing
function connectToServer() {
    if (!currentUser) {
        console.error('❌ No current user found for socket connection');
        return;
    }

    try {
        const userId = currentUser.user.id;
        console.log('🔌 Connecting to server with user id:', userId);
        
        socket = io(CONFIG.SOCKET_URL, {
            auth: {
                token: currentUser.token
            },
            transports: ['websocket', 'polling'],
            timeout: 20000, // Increased timeout
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000
        });
        
        // Set up QR event handler IMMEDIATELY
        socket.on('qrCode', (data) => {
            console.log('🎯 QR CODE EVENT RECEIVED:', {
                sessionId: data.sessionId,
                hasQRData: !!data.qr,
                qrDataLength: data.qr?.length,
                userId: data.userId,
                broadcast: data.broadcast,
                timestamp: new Date().toLocaleTimeString()
            });
            
            if (data.qr && data.sessionId) {
                displayQRCode(data.qr, data.sessionId);
            } else {
                console.error('❌ Invalid QR data:', data);
                showNotification('Invalid QR code data received', 'error');
            }
        });
        
        socket.on('connect', () => {
            console.log('✅ Connected to server, socket ID:', socket.id);
            updateConnectionStatus(true);
            
            // Join user room immediately
            socket.emit('join-user-room', userId);
            console.log('👤 Joined user room: user-' + userId);
            
            // Verify room membership
            setTimeout(() => {
                socket.emit('verify-room', userId, (response) => {
                    console.log('🔍 Room verification:', response);
                });
            }, 1000);
        });
        
        socket.on('sessionReady', (data) => {
            console.log('✅ Session ready:', data.sessionId);
            // Update session status to connected with timestamp
            handleSessionStatusUpdate({
                sessionId: data.sessionId,
                status: 'connected',
                connectedAt: new Date().toISOString(),
                phone: data.phone
            });
            showNotification('WhatsApp session connected successfully!', 'success');
            loadUserSessions();
            closeQRModal();
        });
        
        socket.on('disconnect', (reason) => {
            console.log('❌ Disconnected from server:', reason);
            updateConnectionStatus(false);
            showNotification('Connection lost: ' + reason, 'warning');
        });
        
        socket.on('connect_error', (error) => {
            console.error('❌ Socket connection error:', error);
            updateConnectionStatus(false);
            showNotification('Connection error: ' + error.message, 'error');
        });
        
        socket.on('reconnect', (attemptNumber) => {
            console.log('🔄 Reconnected after', attemptNumber, 'attempts');
            updateConnectionStatus(true);
            socket.emit('join-user-room', userId);
        });
        
        // Add these sync event listeners INSIDE the socket connection function
        socket.on('syncStarted', (data) => {
            console.log('🔄 Sync started:', data);
            updateSessionStatus(data.sessionId, 'Syncing WhatsApp data...', 'syncing');
            handleSessionStatusUpdate({
                sessionId: data.sessionId,
                status: 'syncing'
            });
        });

        socket.on('syncProgress', (data) => {
            console.log('📊 Sync progress:', data);
            updateSessionStatus(data.sessionId, data.message, 'syncing');
            handleSessionStatusUpdate({
                sessionId: data.sessionId,
                status: 'syncing'
            });
        });

        socket.on('syncCompleted', (data) => {
            console.log('✅ Sync completed:', data);
            updateSessionStatus(data.sessionId, data.message, 'ready');
            handleSessionStatusUpdate({
                sessionId: data.sessionId,
                status: 'connected',
                connectedAt: new Date().toISOString()
            });
        });

        socket.on('backgroundSyncUpdate', (data) => {
            console.log('🔄 Background sync update:', data);
            updateSessionStatus(data.sessionId, data.message, 'syncing');
            handleSessionStatusUpdate({
                sessionId: data.sessionId,
                status: 'syncing'
            });
        });

        socket.on('authFailure', (data) => {
            console.log('❌ Auth failure:', data);
            updateSessionStatus(data.sessionId, 'Authentication failed', 'error');
            handleSessionStatusUpdate({
                sessionId: data.sessionId,
                status: 'error'
            });
            showNotification('WhatsApp authentication failed', 'error');
        });

        socket.on('sessionDisconnected', (data) => {
            console.log('❌ Session disconnected:', data);
            updateSessionStatus(data.sessionId, 'Disconnected', 'disconnected');
            handleSessionStatusUpdate({
                sessionId: data.sessionId,
                status: 'disconnected'
            });
            showNotification('WhatsApp session disconnected: ' + data.reason, 'warning');
        });

        socket.on('sessionSuspended', (data) => {
            console.log('🚫 Session suspended:', data);
            updateSessionStatus(data.sessionId, 'Suspended', 'suspended');
            handleSessionStatusUpdate({
                sessionId: data.sessionId,
                status: 'suspended'
            });
            showNotification('Session suspended: ' + data.reason, 'error');
        });

        socket.on('sessionResumed', (data) => {
            console.log('🟢 Session resumed:', data);
            updateSessionStatus(data.sessionId, 'Resumed', 'connected');
            handleSessionStatusUpdate({
                sessionId: data.sessionId,
                status: 'connected',
                connectedAt: new Date().toISOString()
            });
            showNotification('Session resumed successfully!', 'success');
        });

        // NEW SESSION STATUS EVENT HANDLERS
        socket.on('sessionConnected', (data) => {
            console.log('✅ Session connected:', data);
            handleSessionStatusUpdate({
                sessionId: data.sessionId,
                status: 'connected',
                connectedAt: new Date().toISOString(),
                phone: data.phone
            });
            showNotification(`WhatsApp session connected: ${data.phone || data.sessionId}`, 'success');
        });

        socket.on('sessionStatusUpdate', (data) => {
            console.log('📱 Session status update:', data);
            handleSessionStatusUpdate(data);
        });

        socket.on('sessionConnecting', (data) => {
            console.log('🔄 Session connecting:', data);
            handleSessionStatusUpdate({
                sessionId: data.sessionId,
                status: 'connecting'
            });
        });

        socket.on('sessionWaitingQR', (data) => {
            console.log('⏳ Session waiting for QR:', data);
            handleSessionStatusUpdate({
                sessionId: data.sessionId,
                status: 'waiting_qr'
            });
        });

        socket.on('qrGenerated', (data) => {
            console.log('📱 QR code generated:', data);
            handleSessionStatusUpdate({
                sessionId: data.sessionId,
                status: 'qr_ready'
            });
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
        
        if (response.status === 401) {
            // Token expired - logout automatically
            logout();
            return;
        }
        
        if (response.ok) {
            const data = await response.json();
            userSessions = data.data.sessions || [];
            
            console.log('📡 Loaded sessions:', {
                total: userSessions.length,
                sessions: userSessions.map(s => ({ 
                    id: s.sessionId, 
                    status: s.status,
                    phone: s.phone 
                }))
            });
            
            renderUserSessions();
            updateSessionStats();
        } else {
            throw new Error(`HTTP ${response.status}`);
        }
    } catch (error) {
        console.error('Error loading sessions:', error);
        showNotification('Failed to load sessions', 'error');
        
        // Reset sessions array and update count
        userSessions = [];
        updateSessionCount(0);
        
        // Show empty state
        const grid = document.getElementById('userSessionsGrid');
        if (grid) {
            grid.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-exclamation-triangle" style="font-size: 48px; color: #f56565; margin-bottom: 16px;"></i>
                    <h3>Failed to Load Sessions</h3>
                    <p>Please refresh the page or try logging in again</p>
                    <button onclick="logout()" class="btn-primary">Login Again</button>
                    <button onclick="loadUserSessions()" class="btn-secondary" style="margin-left: 10px;">
                        <i class="fas fa-sync-alt"></i> Retry
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
        // Update count to 0 when no sessions
        updateSessionCount(0);
        return;
    }

    grid.innerHTML = userSessions.map(session => {
        // Determine proper status display
        const statusText = getSessionStatusText(session.status);
        const statusClass = getSessionStatusClass(session.status);
        
        // Format connection time
        const connectionTime = getConnectionTime(session);
        
        return `
            <div class="session-card ${session.status}" data-session-id="${session.sessionId}">
                <div class="session-header">
                    <div class="session-status">
                        <span class="status-indicator ${statusClass}"></span>
                        <span class="status-text">${statusText}</span>
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
                            <span class="stat-label">Status</span>
                            <span class="stat-value ${statusClass}">${statusText}</span>
                        </div>
                        <div class="stat">
                            <span class="stat-label">Connected</span>
                            <span class="stat-value">${connectionTime}</span>
                        </div>
                        <div class="stat">
                            <span class="stat-label">Messages</span>
                            <span class="stat-value">${session.messageCount || 0}</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    // Count all active/connected sessions more reliably
const connectedSessions = userSessions.filter(s => {
    const activeStatuses = ['connected', 'ready', 'syncing', 'connecting'];
    return activeStatuses.includes(s.status);
}).length;
    
    console.log('📊 Session count update:', {
        total: userSessions.length,
        connected: connectedSessions,
        sessions: userSessions.map(s => ({ id: s.sessionId, status: s.status }))
    });
    
    // Update session count with proper color coding
    updateSessionCount(connectedSessions);
}

// Add this new function for updating session counts
function updateSessionCount(count) {
    console.log('📊 Updating session count to:', count);
    
    // Update the badge in the sidebar
    const mySessionCount = document.getElementById('mySessionCount');
    if (mySessionCount) {
        mySessionCount.textContent = count;
        
        // Change badge color based on count
        if (count > 0) {
            mySessionCount.style.backgroundColor = '#48bb78'; // Green for active sessions
            mySessionCount.style.color = 'white';
            mySessionCount.classList.remove('badge-error');
            mySessionCount.classList.add('badge-success');
        } else {
            mySessionCount.style.backgroundColor = '#f56565'; // Red for no sessions
            mySessionCount.style.color = 'white';
            mySessionCount.classList.remove('badge-success');
            mySessionCount.classList.add('badge-error');
        }
    }
    
    // Also update the overview stats
    const activeSessionsCount = document.getElementById('activeSessionsCount');
    if (activeSessionsCount) {
        activeSessionsCount.textContent = count;
    }
    
    // Update any other session count displays
    const totalSessionsElements = document.querySelectorAll('.total-sessions-count');
    totalSessionsElements.forEach(element => {
        element.textContent = userSessions.length;
    });
}



// Add this function to handle real-time session updates
function handleSessionStatusUpdate(data) {
    console.log('📱 Session status update:', data);
    
    // Update the session in the userSessions array
    const sessionIndex = userSessions.findIndex(s => s.sessionId === data.sessionId);
    if (sessionIndex !== -1) {
        // Update existing session
        userSessions[sessionIndex] = {
            ...userSessions[sessionIndex],
            status: data.status,
            connectedAt: data.connectedAt || userSessions[sessionIndex].connectedAt,
            phone: data.phone || userSessions[sessionIndex].phone,
            messageCount: data.messageCount || userSessions[sessionIndex].messageCount
        };
    } else if (data.sessionId) {
        // Add new session if it doesn't exist
        console.log('➕ Adding new session to array:', data.sessionId);
        userSessions.push({
            sessionId: data.sessionId,
            status: data.status,
            connectedAt: data.connectedAt,
            phone: data.phone,
            messageCount: data.messageCount || 0,
            createdAt: new Date().toISOString()
        });
    }
    
    // Re-render sessions to show updated status and count
    renderUserSessions();
    updateSessionStats();
}


// Helper function to get proper status text
function getSessionStatusText(status) {
    const statusMap = {
        'connected': 'Connected',
        'ready': 'Connected',
        'connecting': 'Connecting...',
        'waiting_qr': 'Waiting for QR Scan',
        'qr_ready': 'QR Code Ready',
        'syncing': 'Syncing...',
        'disconnected': 'Disconnected',
        'error': 'Error',
        'suspended': 'Suspended',
        'loading': 'Loading...'
    };
    return statusMap[status] || status.charAt(0).toUpperCase() + status.slice(1);
}

// Helper function to get status CSS class
function getSessionStatusClass(status) {
    const classMap = {
        'connected': 'connected',
        'ready': 'connected',
        'connecting': 'connecting',
        'waiting_qr': 'waiting',
        'qr_ready': 'waiting',
        'syncing': 'syncing',
        'disconnected': 'disconnected',
        'error': 'error',
        'suspended': 'error'
    };
    return classMap[status] || 'disconnected';
}

// Helper function to get connection time
function getConnectionTime(session) {
    if (!session.connectedAt && !session.createdAt) {
        return 'Never';
    }
    
    // Use connectedAt if available, otherwise use createdAt
    const connectionDate = session.connectedAt || session.createdAt;
    
    if (session.status === 'connected' || session.status === 'ready') {
        // Show time since connection
        const now = new Date();
        const connected = new Date(connectionDate);
        const diffMs = now - connected;
        
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);
        
        if (diffDays > 0) {
            return `${diffDays}d ${diffHours % 24}h ago`;
        } else if (diffHours > 0) {
            return `${diffHours}h ${diffMins % 60}m ago`;
        } else if (diffMins > 0) {
            return `${diffMins}m ago`;
        } else {
            return 'Just now';
        }
    } else {
        // Show last connection attempt
        return formatDate(connectionDate);
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
    console.log('🔍 DEBUG: Starting createNewSession');
    
    if (!currentUser) {
        showNotification('Please log in to create a session', 'error');
        return;
    }

    try {
        showLoading(true);
        const userId = currentUser.user.id;
        console.log('🔄 Creating session for user ID:', userId);
        
        // Enhanced socket connection check
        if (!socket || !socket.connected) {
            console.error('❌ Socket not connected! Attempting to reconnect...');
            connectToServer();
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            if (!socket || !socket.connected) {
                showNotification('Connection error. Please refresh the page.', 'error');
                return;
            }
        }
        
        // Clear any existing QR timeouts
        if (window.currentQRTimeout) {
            clearTimeout(window.currentQRTimeout);
            window.currentQRTimeout = null;
        }
        
        // Set up QR received flag
        let qrReceived = false;
        let currentSessionId = null;
        
        // Create unique event handler for this session creation
        const sessionQRHandler = (data) => {
            console.log('🎯 SESSION QR EVENT:', data);
            
            // Only handle QR for the current session being created
            if (currentSessionId && data.sessionId === currentSessionId && data.qr) {
                qrReceived = true;
                
                // Clear timeout when QR is received
                if (window.currentQRTimeout) {
                    clearTimeout(window.currentQRTimeout);
                    window.currentQRTimeout = null;
                    console.log('✅ QR timeout cleared - QR received');
                }
                
                displayQRCode(data.qr, data.sessionId);
                
                // Remove this specific handler after use
                socket.off('qrCode', sessionQRHandler);
                console.log('🧹 Removed session-specific QR handler');
            }
        };
        
        // Ensure user is in socket room
        socket.emit('join-user-room', userId);
        console.log('👤 Joined socket room: user-' + userId);
        
        // Make API call to create session
        const response = await fetch(`${CONFIG.API_BASE}/api/sessions/create`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${currentUser.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
        });
        
        const data = await response.json();
        console.log('📡 API Response:', data);
        
        if (data.success) {
            currentSessionId = data.data.sessionId;
            console.log('✅ Session created via API:', currentSessionId);
            
            // Add session-specific QR handler AFTER getting session ID
            socket.on('qrCode', sessionQRHandler);
            
            // Add the new session to the array immediately
            const newSession = {
                sessionId: currentSessionId,
                status: 'waiting_qr',
                createdAt: new Date().toISOString(),
                messageCount: 0,
                phone: null
            };
            
            userSessions.push(newSession);
            console.log('➕ Added new session to array, total sessions:', userSessions.length);
            
            // Update the display immediately
            renderUserSessions();
            
            showNotification('New session created! Waiting for QR code...', 'success');
            showQRModal();
            
            // Show loading state in modal
            const qrCodeDisplay = document.getElementById('qrCodeDisplay');
            if (qrCodeDisplay) {
                qrCodeDisplay.innerHTML = `
                    <div style="text-align: center; padding: 20px;">
                        <i class="fas fa-qrcode" style="font-size: 48px; color: #667eea; margin-bottom: 10px;"></i>
                        <p>Generating QR Code...</p>
                        <p>Session: ${currentSessionId}</p>
                        <p style="font-size: 12px; color: #666;">Socket ID: ${socket.id}</p>
                        <p style="font-size: 12px; color: #666;">User Room: user-${userId}</p>
                        <div class="loading-spinner"></div>
                    </div>
                `;
            }
            
            // Set up timeout for QR code generation
            window.currentQRTimeout = setTimeout(() => {
                // Only show timeout if QR wasn't received and modal is still open
                const qrModal = document.getElementById('qrModal');
                const qrDisplay = document.getElementById('qrCodeDisplay');
                
                if (!qrReceived && qrModal && qrModal.classList.contains('active') && qrDisplay) {
                    console.warn('⚠️ QR code timeout after 45 seconds');
                    qrDisplay.innerHTML = `
                        <div style="text-align: center; padding: 20px;">
                            <i class="fas fa-clock" style="font-size: 48px; color: #f39c12; margin-bottom: 10px;"></i>
                            <h4>QR Code Timeout</h4>
                            <p>The QR code took too long to generate or has expired.</p>
                            <p style="font-size: 14px; color: #666;">This usually happens when:</p>
                            <ul style="text-align: left; color: #666; font-size: 14px; max-width: 300px; margin: 10px auto;">
                                <li>Server is overloaded</li>
                                <li>WhatsApp service is busy</li>
                                <li>Network connectivity issues</li>
                                <li>QR code expired (they expire every 20 seconds)</li>
                            </ul>
                            <div style="margin-top: 20px;">
                                <button onclick="closeQRModal(); setTimeout(() => createNewSession(), 500);" style="background: #28a745; color: white; border: none; padding: 10px 20px; border-radius: 5px; margin: 5px; cursor: pointer;">
                                    <i class="fas fa-redo"></i> Try Again
                                </button>
                                <button onclick="closeQRModal()" style="background: #6c757d; color: white; border: none; padding: 10px 20px; border-radius: 5px; margin: 5px; cursor: pointer;">
                                    <i class="fas fa-times"></i> Cancel
                                </button>
                            </div>
                            <p style="font-size: 12px; color: #999; margin-top: 15px;">
                                Session: ${currentSessionId}<br>
                                Socket: ${socket?.connected ? 'Connected' : 'Disconnected'}<br>
                                Room: user-${userId}
                            </p>
                        </div>
                    `;
                }
                
                // Clean up handler
                socket.off('qrCode', sessionQRHandler);
                window.currentQRTimeout = null;
            }, 45000); // 45 seconds timeout
            
        } else {
            console.error('❌ Session creation failed:', data.message);
            showNotification(data.message || 'Failed to create session', 'error');
        }
    } catch (error) {
        console.error('❌ Error creating session:', error);
        showNotification('Error creating session: ' + error.message, 'error');
    } finally {
        showLoading(false);
    }
}

// Add server status check function
async function checkServerStatus() {
    try {
        showNotification('Checking server status...', 'info');
        const response = await fetch(`${CONFIG.API_BASE}/api/users/profile`, {
            headers: {
                'Authorization': `Bearer ${currentUser.token}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            showNotification('Server is responding normally', 'success');
        } else {
            showNotification(`Server responded with status: ${response.status}`, 'warning');
        }
    } catch (error) {
        showNotification('Server is not responding: ' + error.message, 'error');
    }
}


// FIXED: QR Code display function for qrcode@1.5.3
async function displayQRCode(qrData, sessionId) {
    console.log('🎯 displayQRCode called with:', { sessionId, qrDataLength: qrData?.length });
    
    const qrCodeDisplay = document.getElementById('qrCodeDisplay');
    if (!qrCodeDisplay) {
        console.error('❌ QR code display element not found');
        showNotification('QR display error - element not found', 'error');
        return;
    }

    // Clear previous content
    qrCodeDisplay.innerHTML = '';
    
    // Create container for QR code
    const qrCodeContainer = document.createElement('div');
    qrCodeContainer.style.textAlign = 'center';
    qrCodeContainer.style.padding = '20px';
    qrCodeDisplay.appendChild(qrCodeContainer);

    console.log('📦 QR container created, checking QRCode library...');

    // Wait for QRCode library (max 3 seconds)
    let attempts = 0;
    while (typeof QRCode === 'undefined' && attempts < 30) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
    }

    try {
        if (typeof QRCode === 'undefined') {
            throw new Error('QRCode library not available after waiting');
        }

        // Create container div for QRCode.js (not canvas)
        const qrContainer = document.createElement('div');
        qrContainer.style.display = 'inline-block';
        qrContainer.style.padding = '10px';
        qrContainer.style.background = 'white';
        qrContainer.style.borderRadius = '8px';
        qrContainer.style.border = '1px solid #ddd';
        qrCodeContainer.appendChild(qrContainer);

        // Generate QR code using QRCode.js (David Shim's library)
        const qr = new QRCode(qrContainer, {
            text: qrData,
            width: 256,
            height: 256,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.H
        });
        
        console.log('✅ QR code generated successfully with QRCode.js');
                
        // Add instructions
        const instructions = document.createElement('div');
        instructions.innerHTML = `
            <div style="margin-top: 15px; padding: 15px; background: #f8f9fa; border-radius: 8px;">
                <h4 style="margin: 0 0 10px 0; color: #333;">📱 How to Connect:</h4>
                <ol style="text-align: left; color: #666; font-size: 14px; margin: 0; padding-left: 20px;">
                    <li>Open WhatsApp on your phone</li>
                    <li>Go to Settings → Linked Devices</li>
                    <li>Tap "Link a Device"</li>
                    <li>Scan this QR code</li>
                </ol>
                <p style="margin: 10px 0 0 0; font-size: 12px; color: #999;">
                    Session: ${sessionId}
                </p>
            </div>
        `;
        qrCodeContainer.appendChild(instructions);
        
    } catch (error) {
        console.error('❌ QR code generation failed:', error);
        
        // Enhanced fallback
        qrCodeContainer.innerHTML = `
            <div style="text-align: center; padding: 20px; background: #f8f9fa; border-radius: 8px; border: 2px dashed #007bff;">
                <i class="fas fa-qrcode" style="font-size: 48px; color: #007bff; margin-bottom: 15px;"></i>
                <h4 style="color: #333; margin-bottom: 10px;">QR Code Ready!</h4>
                <p style="font-size: 14px; color: #666; margin-bottom: 15px;">Copy the text below and generate QR code online:</p>
                
                <div style="background: white; padding: 15px; border-radius: 6px; border: 1px solid #ddd; margin: 15px 0;">
                    <textarea readonly id="qrDataText-${sessionId}" style="width: 100%; height: 80px; font-family: monospace; font-size: 11px; padding: 10px; border: 1px solid #ccc; border-radius: 4px; resize: none;">${qrData}</textarea>
                </div>
                
                <div style="margin: 15px 0;">
                    <button onclick="copyQRData('${sessionId}')" style="background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; font-weight: 500; margin: 5px;">
                        <i class="fas fa-copy"></i> Copy QR Data
                    </button>
                    
                    <button onclick="openQRGenerator('${qrData.replace(/'/g, "\\'")}', '${sessionId}')" style="background: #28a745; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; font-weight: 500; margin: 5px;">
                        <i class="fas fa-external-link-alt"></i> Generate QR Online
                    </button>
                </div>
                
                <p style="font-size: 12px; color: #666; margin-top: 15px;">
                    <strong>Session:</strong> ${sessionId}<br>
                    <strong>Instructions:</strong> Copy the text above, paste it into any online QR generator, then scan with WhatsApp.
                </p>
            </div>
        `;
    }
}

// Helper functions
window.copyQRData = function(sessionId) {
    const textArea = document.getElementById(`qrDataText-${sessionId}`);
    if (textArea) {
        textArea.select();
        navigator.clipboard.writeText(textArea.value).then(() => {
            showNotification('QR data copied to clipboard!', 'success');
        }).catch(() => {
            // Fallback for older browsers
            textArea.select();
            document.execCommand('copy');
            showNotification('QR data copied!', 'success');
        });
    }
};

window.openQRGenerator = function(data, sessionId) {
    const encodedData = encodeURIComponent(data);
    window.open(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodedData}`, '_blank');
};


// Fallback using QR code image service
function showImageFallback(qrData, sessionId, container) {
    console.log('🔄 Using image fallback for QR code');
    
    const encodedData = encodeURIComponent(qrData);
    container.innerHTML = `
        <div class="qr-fallback">
            <i class="fas fa-qrcode"></i>
            <h4>Scan QR Code</h4>
            <p>Click the button below to generate QR code</p>
            <div class="qr-fallback-actions">
                <button class="btn-primary" onclick="openQRImage('${encodedData}')">
                    <i class="fas fa-external-link-alt"></i>
                    Generate QR Code
                </button>
                <button class="btn-secondary" onclick="copyQRData('${encodedData}')">
                    <i class="fas fa-copy"></i>
                    Copy QR Data
                </button>
            </div>
            <p class="small-text">Session: ${sessionId}</p>
        </div>
    `;
}

function openQRImage(encodedData) {
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodedData}`;
    window.open(url, '_blank');
}

function copyQRData(encodedData) {
    const decodedData = decodeURIComponent(encodedData);
    navigator.clipboard.writeText(decodedData).then(() => {
        showNotification('QR data copied to clipboard', 'success');
    }).catch(() => {
        showNotification('Failed to copy QR data', 'error');
    });
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

// function updateSubscriptionDisplay() {
//     if (!userSubscription) return;

//     const elements = {
//         currentPlan: document.getElementById('currentPlan'),
//         paymentStatus: document.getElementById('paymentStatus'),
//         expiryDate: document.getElementById('expiryDate'),
//         maxSessions: document.getElementById('maxSessions'),
//         planDaysLeft: document.getElementById('planDaysLeft'),
//         planStatus: document.getElementById('planStatus'),
//         sessionLimit: document.getElementById('sessionLimit')
//     };

//     if (elements.currentPlan) elements.currentPlan.textContent = userSubscription.subscription || 'Free';
//     if (elements.paymentStatus) elements.paymentStatus.textContent = userSubscription.paymentStatus || 'Active';
//     if (elements.expiryDate) elements.expiryDate.textContent = userSubscription.daysRemaining ? `${userSubscription.daysRemaining} days` : 'Never';
//     if (elements.maxSessions) elements.maxSessions.textContent = userSubscription.limits?.maxSessions || 1;
//     if (elements.planDaysLeft) elements.planDaysLeft.textContent = userSubscription.daysRemaining || 0;
//     if (elements.planStatus) elements.planStatus.textContent = userSubscription.subscription || 'Free';
//     if (elements.sessionLimit) elements.sessionLimit.textContent = `Limit: ${userSubscription.limits?.maxSessions || 1}`;
// }

// function updateSubscriptionDisplay() {
//     if (!userSubscription) return;

//     const daysLeft = userSubscription.daysRemaining || 0;
//     const isTrial = userSubscription.paymentStatus === 'trial';
    
//     if (elements.currentPlan) elements.currentPlan.textContent = userSubscription.subscription || 'Free';
//     if (elements.paymentStatus) {
//         if (isTrial) {
//             elements.paymentStatus.textContent = `Trial (${daysLeft} days left)`;
//             elements.paymentStatus.style.color = daysLeft <= 2 ? '#f44336' : '#ff9800';
//         } else {
//             elements.paymentStatus.textContent = userSubscription.paymentStatus || 'Active';
//         }
//     }
//     if (elements.expiryDate) {
//         elements.expiryDate.textContent = daysLeft > 0 ? `${daysLeft} days` : 'Expired';
//         if (daysLeft <= 2 && isTrial) {
//             elements.expiryDate.style.color = '#f44336';
//             elements.expiryDate.style.fontWeight = 'bold';
//         }
//     }
//     if (elements.maxSessions) elements.maxSessions.textContent = userSubscription.limits?.maxSessions || 1;
//     if (elements.planDaysLeft) {
//         elements.planDaysLeft.textContent = daysLeft;
//         if (daysLeft <= 2 && isTrial) {
//             elements.planDaysLeft.style.color = '#f44336';
//             elements.planDaysLeft.style.fontWeight = 'bold';
//         }
//     }
//     if (elements.planStatus) {
//         elements.planStatus.textContent = isTrial ? `Trial - ${daysLeft} days left` : userSubscription.subscription || 'Free';
//         if (daysLeft <= 2 && isTrial) {
//             elements.planStatus.classList.add('urgent');
//         }
//     }
//     if (elements.sessionLimit) elements.sessionLimit.textContent = `Limit: ${userSubscription.limits?.maxSessions || 1}`;
    
//     // Show upgrade banner if trial is expiring soon
//     if (isTrial && daysLeft <= 2) {
//         showTrialExpiringBanner(daysLeft);
//     }
// }

function updateSubscriptionDisplay() {
    if (!userSubscription) return;

    const daysLeft = userSubscription.daysRemaining || 0;
    const isTrial = userSubscription.paymentStatus === 'trial';
    
    // Get DOM elements (with null checks)
    const currentPlanEl = document.getElementById('currentPlan');
    const paymentStatusEl = document.getElementById('paymentStatus');
    const expiryDateEl = document.getElementById('expiryDate');
    const maxSessionsEl = document.getElementById('maxSessions');
    const planDaysLeftEl = document.getElementById('planDaysLeft');
    const planStatusEl = document.getElementById('planStatus');
    const sessionLimitEl = document.getElementById('sessionLimit');
    
    // Update current plan
    if (currentPlanEl) {
        currentPlanEl.textContent = userSubscription.subscription || 'Free';
    }
    
    // Update payment status with trial info
    if (paymentStatusEl) {
        if (isTrial) {
            paymentStatusEl.textContent = `Trial (${daysLeft} days left)`;
            paymentStatusEl.style.color = daysLeft <= 2 ? '#f44336' : daysLeft <= 5 ? '#ff9800' : '#4CAF50';
        } else if (userSubscription.paymentStatus === 'expired') {
            paymentStatusEl.textContent = 'Expired';
            paymentStatusEl.style.color = '#f44336';
        } else {
            paymentStatusEl.textContent = userSubscription.paymentStatus || 'Active';
            paymentStatusEl.style.color = '#4CAF50';
        }
    }
    
    // Update expiry date
    if (expiryDateEl) {
        if (daysLeft > 0) {
            expiryDateEl.textContent = `${daysLeft} day${daysLeft !== 1 ? 's' : ''}`;
            if (daysLeft <= 2 && isTrial) {
                expiryDateEl.style.color = '#f44336';
                expiryDateEl.style.fontWeight = 'bold';
            }
        } else {
            expiryDateEl.textContent = 'Expired';
            expiryDateEl.style.color = '#f44336';
            expiryDateEl.style.fontWeight = 'bold';
        }
    }
    
    // Update max sessions
    if (maxSessionsEl) {
        maxSessionsEl.textContent = userSubscription.limits?.maxSessions || 1;
    }
    
    // Update plan days left
    if (planDaysLeftEl) {
        planDaysLeftEl.textContent = daysLeft;
        if (daysLeft <= 2 && isTrial) {
            planDaysLeftEl.style.color = '#f44336';
            planDaysLeftEl.style.fontWeight = 'bold';
        }
    }
    
    // Update plan status
    if (planStatusEl) {
        if (isTrial) {
            planStatusEl.textContent = `Trial - ${daysLeft} days left`;
        } else if (userSubscription.paymentStatus === 'expired') {
            planStatusEl.textContent = 'Expired';
        } else {
            planStatusEl.textContent = userSubscription.subscription || 'Free';
        }
        
        if (daysLeft <= 2 && isTrial) {
            planStatusEl.classList.add('urgent');
        }
    }
    
    // Update session limit
    if (sessionLimitEl) {
        sessionLimitEl.textContent = `Limit: ${userSubscription.limits?.maxSessions || 1}`;
    }
    
    // Show upgrade banner if trial is expiring soon or expired
    if (isTrial && daysLeft <= 2) {
        showTrialExpiringBanner(daysLeft);
    } else if (userSubscription.paymentStatus === 'expired') {
        showTrialExpiredBanner();
    }
}

// Add this new function for expiring trial
function showTrialExpiringBanner(daysLeft) {
    const existingBanner = document.querySelector('.trial-expiring-banner');
    if (existingBanner) return; // Don't show multiple banners
    
    const banner = document.createElement('div');
    banner.className = 'trial-expiring-banner';
    banner.innerHTML = `
        <div class="banner-content">
            <i class="fas fa-exclamation-triangle"></i>
            <span><strong>Warning!</strong> Your trial expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}! Upgrade now to keep using AutoPay.</span>
            <button onclick="window.location.href='pricing.html'" class="btn-upgrade">
                <i class="fas fa-crown"></i> Upgrade Now
            </button>
            <button onclick="this.parentElement.parentElement.remove()" class="btn-close">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `;
    
    addBannerStyles();
    document.body.appendChild(banner);
}

// Add this new function for expired trial
function showTrialExpiredBanner() {
    const existingBanner = document.querySelector('.trial-expired-banner');
    if (existingBanner) return;
    
    const banner = document.createElement('div');
    banner.className = 'trial-expired-banner';
    banner.innerHTML = `
        <div class="banner-content">
            <i class="fas fa-times-circle"></i>
            <span><strong>Trial Expired!</strong> Your free trial has ended. Subscribe now to continue using AutoPay.</span>
            <button onclick="window.location.href='pricing.html'" class="btn-subscribe">
                <i class="fas fa-rocket"></i> Subscribe Now
            </button>
        </div>
    `;
    
    addBannerStyles();
    document.body.appendChild(banner);
}

// Add styles for banners
function addBannerStyles() {
    if (document.querySelector('#banner-styles')) return; // Already added
    
    const style = document.createElement('style');
    style.id = 'banner-styles';
    style.textContent = `
        .trial-expiring-banner, .trial-expired-banner {
            position: fixed;
            top: 70px;
            left: 50%;
            transform: translateX(-50%);
            color: white;
            padding: 15px 25px;
            border-radius: 10px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
            z-index: 9999;
            animation: slideDown 0.5s ease;
            max-width: 600px;
            width: 90%;
        }
        .trial-expiring-banner {
            background: linear-gradient(135deg, #ff9800 0%, #ff5722 100%);
        }
        .trial-expired-banner {
            background: linear-gradient(135deg, #f44336 0%, #d32f2f 100%);
        }
        .banner-content {
            display: flex;
            align-items: center;
            gap: 15px;
            flex-wrap: wrap;
        }
        .banner-content i.fa-exclamation-triangle,
        .banner-content i.fa-times-circle {
            font-size: 24px;
            animation: pulse 2s infinite;
        }
        .banner-content span {
            flex: 1;
            min-width: 200px;
        }
        .btn-upgrade, .btn-subscribe {
            background: white;
            color: #ff5722;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            font-weight: bold;
            transition: transform 0.2s;
            white-space: nowrap;
        }
        .btn-upgrade:hover, .btn-subscribe:hover {
            transform: scale(1.05);
        }
        .btn-close {
            background: transparent;
            border: none;
            color: white;
            cursor: pointer;
            font-size: 18px;
            padding: 5px;
        }
        @keyframes slideDown {
            from { top: -100px; opacity: 0; }
            to { top: 70px; opacity: 1; }
        }
        @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.1); }
        }
        @media (max-width: 768px) {
            .trial-expiring-banner, .trial-expired-banner {
                top: 60px;
                padding: 12px 15px;
            }
            .banner-content {
                gap: 10px;
            }
            .banner-content i {
                font-size: 20px;
            }
        }
    `;
    document.head.appendChild(style);
}


// Add this new function
function showTrialExpiringBanner(daysLeft) {
    const existingBanner = document.querySelector('.trial-expiring-banner');
    if (existingBanner) return; // Don't show multiple banners
    
    const banner = document.createElement('div');
    banner.className = 'trial-expiring-banner';
    banner.innerHTML = `
        <div class="banner-content">
            <i class="fas fa-exclamation-triangle"></i>
            <span>Your trial expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}! Upgrade now to keep using AutoPay.</span>
            <button onclick="window.location.href='pricing.html'" class="btn-upgrade">
                <i class="fas fa-crown"></i> Upgrade Now
            </button>
            <button onclick="this.parentElement.parentElement.remove()" class="btn-close">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `;
    
    // Add styles
    const style = document.createElement('style');
    style.textContent = `
        .trial-expiring-banner {
            position: fixed;
            top: 70px;
            left: 50%;
            transform: translateX(-50%);
            background: linear-gradient(135deg, #ff6b6b 0%, #ee5a6f 100%);
            color: white;
            padding: 15px 25px;
            border-radius: 10px;
            box-shadow: 0 4px 20px rgba(255, 107, 107, 0.4);
            z-index: 9999;
            animation: slideDown 0.5s ease;
        }
        .banner-content {
            display: flex;
            align-items: center;
            gap: 15px;
        }
        .banner-content i.fa-exclamation-triangle {
            font-size: 24px;
            animation: pulse 2s infinite;
        }
        .btn-upgrade {
            background: white;
            color: #ff6b6b;
            border: none;
            padding: 8px 20px;
            border-radius: 5px;
            cursor: pointer;
            font-weight: bold;
            transition: transform 0.2s;
        }
        .btn-upgrade:hover {
            transform: scale(1.05);
        }
        .btn-close {
            background: transparent;
            border: none;
            color: white;
            cursor: pointer;
            font-size: 18px;
        }
        @keyframes slideDown {
            from { top: -100px; opacity: 0; }
            to { top: 70px; opacity: 1; }
        }
        @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.1); }
        }
    `;
    document.head.appendChild(style);
    document.body.appendChild(banner);
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
        qrModal.classList.add('active');  // ✅ Add the active class
        document.body.style.overflow = 'hidden';
        console.log('✅ QR modal opened');
    } else {
        console.error('❌ QR modal element not found');
    }
}

function closeQRModal() {
    const qrModal = document.getElementById('qrModal');
    if (qrModal) {
        qrModal.classList.remove('active');
        
        // Clean up any pending QR timeouts
        if (window.currentQRTimeout) {
            clearTimeout(window.currentQRTimeout);
            window.currentQRTimeout = null;
            console.log('🧹 Cleaned up QR timeout on modal close');
        }
        
        // Force restore scrolling
        document.body.style.overflow = '';
        document.body.style.overflowY = '';
        document.documentElement.style.overflow = '';
        
        // Reset QR code display
        const qrCodeDisplay = document.getElementById('qrCodeDisplay');
        if (qrCodeDisplay) {
            qrCodeDisplay.innerHTML = `
                <i class="fas fa-qrcode"></i>
                <p>Generating QR Code...</p>
            `;
            qrCodeDisplay.className = 'qr-code-display';
        }
        
        console.log('✅ QR modal closed and cleaned up');
    }
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
            id: 'free',
            name: 'Free Plan',
            amount: 0,
            allowedCommands: ['ping', 'status', 'tag', 'list', 'help'],
            features: [
                'Basic tagging (!tagall limited use)',
                'Access to !list',
                'Basic bot status',
                'Help menu',
                '1 active session'
            ]
        },
        {
            id: 'starter',
            name: 'Starter Plan',
            amount: 2900,
            allowedCommands: [
                'ping', 'status', 'tag', 'list', 'help',
                'tagall', 'tagallexcept'
            ],
            features: [
                'All Free features',
                'Tag all members',
                'Tag all except selected users',
                '5 active sessions',
                'Standard support'
            ]
        },
        {
            id: 'professional',
            name: 'Professional Plan',
            amount: 7900,
            allowedCommands: [
                'ping', 'status', 'tag', 'list', 'help',
                'tagall', 'tagallexcept',
                'scheduler', 'events', 'reminders'
            ],
            features: [
                'All Starter features',
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
            allowedCommands: [
                'ping', 'status', 'tag', 'list', 'help',
                'tagall', 'tagallexcept',
                'scheduler', 'events', 'reminders',
                'sudo', 'broadcast'
            ],
            features: [
                'All Professional features',
                'Advanced admin controls',
                'Sudo commands',
                'System monitoring',
                'Broadcast messaging',
                '100 active sessions'
            ]
        },
        {
            id: 'enterprise',
            name: 'Enterprise Plan',
            amount: 27900,
            allowedCommands: ['*'], // all commands unlocked
            features: [
                'All Business features',
                'Unlimited sessions',
                'Advanced automation',
                'Custom bot commands',
                'API access',
                'White-label solution',
                'Dedicated support'
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

    // Auto remove after 10 seconds
    setTimeout(() => {
        if (notification.parentElement) {
            notification.remove();
        }
    }, 10000);

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
    const activeSessions = userSessions.filter(s => 
        s.status === 'connected' || s.status === 'ready'
    ).length;
    const totalMessages = userSessions.reduce((sum, session) => sum + (session.messageCount || 0), 0);

    console.log('📊 Session stats updated:', { 
        totalSessions, 
        activeSessions, 
        totalMessages,
        sessionStatuses: userSessions.map(s => s.status)
    });

    // Update all relevant elements
    const elements = {
        mySessionCount: document.getElementById('mySessionCount'),
        activeSessionsCount: document.getElementById('activeSessionsCount'),
        totalMessagesCount: document.getElementById('totalMessagesCount'),
        messagesToday: document.getElementById('messagesToday'),
        groupsManaged: document.getElementById('groupsManaged')
    };

    // Update session count with color coding
    if (elements.mySessionCount) {
        elements.mySessionCount.textContent = activeSessions;
        
        // Update badge color
        if (activeSessions > 0) {
            elements.mySessionCount.style.backgroundColor = '#48bb78'; // Green
            elements.mySessionCount.style.color = 'white';
            elements.mySessionCount.classList.remove('badge-error');
            elements.mySessionCount.classList.add('badge-success');
        } else {
            elements.mySessionCount.style.backgroundColor = '#f56565'; // Red
            elements.mySessionCount.style.color = 'white';
            elements.mySessionCount.classList.remove('badge-success');
            elements.mySessionCount.classList.add('badge-error');
        }
    }
    
    // Update other stats
    if (elements.activeSessionsCount) elements.activeSessionsCount.textContent = activeSessions;
    if (elements.totalMessagesCount) elements.totalMessagesCount.textContent = totalMessages.toLocaleString();
    if (elements.messagesToday) elements.messagesToday.textContent = Math.floor(totalMessages * 0.1);
    if (elements.groupsManaged) elements.groupsManaged.textContent = totalSessions;
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



// SAFE Socket debugging
function setupSocketDebugging() {
    if (!socket) {
        console.warn('⚠️ Cannot setup socket debugging: socket is null');
        return;
    }
    
    console.log('🔍 Setting up socket debugging...');
    
    try {
        // Log all received events
        socket.onAny((eventName, ...args) => {
            console.log('📥 SOCKET RECEIVE:', eventName, args);
        });
        
        // Specific debug for QR events - WITH NULL CHECK
        socket.on('qrCode', (data) => {
            if (!socket || !socket.connected) {
                console.warn('⚠️ Socket not connected, ignoring QR event');
                return;
            }
            
            console.log('🎯 QR CODE EVENT DETAILS:', {
                sessionId: data.sessionId,
                hasQRData: !!data.qr,
                qrDataLength: data.qr?.length,
                timestamp: new Date().toLocaleTimeString()
            });
            
            if (data.qr) {
                console.log('🔄 Calling displayQRCode...');
                displayQRCode(data.qr, data.sessionId);
            } else {
                console.error('❌ No QR data in event');
                showNotification('No QR code data received from server', 'error');
            }
        });
        
        console.log('✅ Socket debugging enabled');
    } catch (error) {
        console.error('❌ Error setting up socket debugging:', error);
    }
}




function updateSessionStatus(sessionId, message, status) {
    console.log(`📱 Updating session ${sessionId}: ${message} (${status})`);
    
    // Find the session element in the UI
    const sessionElement = document.querySelector(`[data-session-id="${sessionId}"]`);
    if (sessionElement) {
        const statusElement = sessionElement.querySelector('.session-status');
        const messageElement = sessionElement.querySelector('.session-message');
        
        if (statusElement) {
            statusElement.textContent = status;
            statusElement.className = `session-status status-${status}`;
        }
        
        if (messageElement) {
            messageElement.textContent = message;
        }
    }
    
    // Also update any QR modal if it's showing for this session
    const qrModal = document.getElementById('qrModal');
    if (qrModal && qrModal.style.display !== 'none') {
        const modalSessionId = qrModal.getAttribute('data-session-id');
        if (modalSessionId === sessionId) {
            const statusText = qrModal.querySelector('.sync-status');
            if (statusText) {
                statusText.textContent = message;
            }
        }
    }
}
