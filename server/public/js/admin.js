// ==================== INITIALIZATION ====================

// Global variables
let currentSection = 'dashboard';
let sessions = [];
let users = [];
let currentSessionId = null;
let isCreatingSession = false;
let socket; // Declare socket variable


// Get current admin ID
function getCurrentAdminId() {
    // Try multiple sources for admin ID
    const adminSession = JSON.parse(localStorage.getItem('adminSession') || '{}');
    const userSession = JSON.parse(localStorage.getItem('userSession') || '{}');
    
    // Return the actual admin user ID, not a hardcoded string
    return adminSession.user?.id || 
           adminSession.userId || 
           userSession.user?.id || 
           userSession.id || 
           userSession.userId || 
           null;
}

// Admin Dashboard Configuration
const CONFIG = {
    API_BASE: window.location.origin,
    SOCKET_URL: window.location.origin
};

// Initialize admin dashboard
document.addEventListener('DOMContentLoaded', function() {
    console.log('Admin dashboard initializing...');
    initializeAdmin();
    setupSocketConnection();
    loadDashboardData();
    setupEventListeners();
    startRealTimeUpdates();

    // Set initial active section
    switchSection('dashboard');

    // Load exemption data if on exemptions section
    if (currentSection === 'exemptions') {
        loadOwnerInfo();
        loadUsersExemptionStatus();
    }
});

// Initialize admin functionality
function initializeAdmin() {
    console.log('Admin dashboard initialized');

    // Initialize sample data
    initializeSampleData();

    // Set initial sidebar state
    const sidebar = document.querySelector('.admin-sidebar');
    if (sidebar && window.innerWidth <= 768) {
        sidebar.classList.add('collapsed');
    }
}

// Setup Socket.IO connection for real-time updates
function setupSocketConnection() {
    console.log('🔌 Setting up Socket.IO connection...');

    try {
        // Initialize socket connection
        socket = io(CONFIG.SOCKET_URL, {
            transports: ['websocket', 'polling'],
            timeout: 10000,
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionAttempts: 5
        });

        // Socket event listeners
    //   socket.on('connect', () => {
    // console.log('✅ Connected to server');
    // const adminId = getCurrentAdminId();
    // socket.emit('join-admin-room', adminId); // 🔑 Use admin room
    // updateConnectionStatus(true);

    socket.on('connect', () => {
    console.log('✅ Connected to server');
    const adminId = getCurrentAdminId();
    
    if (!adminId) {
        console.error('❌ No admin ID found! Cannot join socket room.');
        showNotification('Session error. Please log in again.', 'error');
        return;
    }
    
    console.log('👤 Admin ID:', adminId);
    
    // Join the admin room with the actual user ID
    socket.emit('join-admin-room', adminId);
    console.log(`📡 Joined room: admin-${adminId}`);
    
    updateConnectionStatus(true);
});


               // 🔑 UPDATED: Admin-specific socket events
socket.on('qrCode', (data) => {
    console.log('📱 ADMIN: QR Code received:', data);
    
    // Handle QR codes for admin sessions or if this is an admin user
    if (data.isAdmin || data.userType === 'admin' || data.userId === getCurrentAdminId()) {
        displayQRCode(data.qr, data.sessionId); // Use your existing function
    }
});

socket.on('sessionReady', (data) => {
    console.log('✅ ADMIN: Bot session ready:', data);
    handleSessionReady(data); // Use your existing function
});

socket.on('adminSessionReady', (data) => {
    console.log('✅ ADMIN: Admin bot session ready:', data);
    handleSessionReady(data); // Use your existing function
});

socket.on('sessionDisconnected', (data) => {
    console.log('❌ ADMIN: Session disconnected:', data);
    handleSessionDisconnected(data); // Use your existing function
});

socket.on('adminSessionDisconnected', (data) => {
    console.log('❌ ADMIN: Admin session disconnected:', data);
    handleSessionDisconnected(data); // Use your existing function
});

socket.on('authFailure', (data) => {
    console.log('🚫 ADMIN: Authentication failed:', data);
    handleAuthFailure(data); // Use your existing function
});

socket.on('adminAuthFailure', (data) => {
    console.log('🚫 ADMIN: Admin authentication failed:', data);
    handleAuthFailure(data); // Use your existing function
});

        // Add QR display functions
        function displayAdminQRCode(qrData, sessionId) {
            const qrContainer = document.getElementById('adminQRContainer');
            if (qrContainer) {
                qrContainer.innerHTML = `
                    <div class="qr-code-display">
                        <h3>Scan QR Code with WhatsApp</h3>
                        <div id="adminQrCode"></div>
                        <p>Session: ${sessionId}</p>
                    </div>
                `;
                
                // Generate QR code using QRCode library
                QRCode.toCanvas(document.getElementById('adminQrCode'), qrData, {
                    width: 256,
                    margin: 2
                });
            }
        }

        // Add bot session creation
        async function createAdminBotSession() {
            try {
                const response = await fetch('/api/admin/bot/create-session', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${getAuthToken()}`
                    }
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showNotification('Bot session created. Scan QR code to connect.', 'success');
                } else {
                    showNotification(result.message, 'error');
                }
                
            } catch (error) {
                console.error('Error creating admin bot session:', error);
                showNotification('Failed to create bot session', 'error');
            }
        }

        socket.on('disconnect', () => {
            console.log('❌ Disconnected from server');
            updateConnectionStatus(false);
        });

        socket.on('connect_error', (error) => {
            console.log('🔌 Connection error:', error.message);
            updateConnectionStatus(false);
        });

        socket.on('qrCode', (data) => {
            console.log('📱 QR Code received:', data);
            displayQRCode(data.qr, data.sessionId);
        });

        socket.on('sessionReady', (data) => {
            console.log('✅ Session ready:', data);
            handleSessionReady(data);
        });

        socket.on('sessionDisconnected', (data) => {
            console.log('❌ Session disconnected:', data);
            handleSessionDisconnected(data);
        });

        socket.on('authFailure', (data) => {
            console.log('🚫 Authentication failed:', data);
            handleAuthFailure(data);
        });

        socket.on('admin-status', (data) => {
            updateDashboardStats(data);
        });

    } catch (error) {
        console.error('Socket setup error:', error);
        updateConnectionStatus(false);
    }
}

// Load admin dashboard data
async function loadDashboardData() {
    try {
        console.log('📊 Loading admin dashboard data...');
        
        // Fetch real sessions from API
        await fetchAllSessions();
        
        // Load other data
        loadRecentActivity();
        
        console.log('✅ Dashboard data loaded');
        
    } catch (error) {
        console.error('❌ Failed to load dashboard data:', error);
        showNotification('Failed to load dashboard data', 'error');
    }
}

// Update dashboard statistics
function updateDashboardStats(stats) {
    const activeSessions = document.getElementById('activeSessions');
    const totalUsers = document.getElementById('totalUsers');
    const messagesProcessed = document.getElementById('messagesProcessed');

    if (activeSessions) activeSessions.textContent = stats.sessions?.active || 0;
    if (totalUsers) totalUsers.textContent = stats.users?.total || 0;
    if (messagesProcessed) messagesProcessed.textContent = stats.usage?.totalMessages || 0;
    
    updateUptime();
}

function initializeSampleData() {
    // Sample sessions data
    sessions = [
        { id: 'session-001', status: 'active', user: 'Admin Bot', phone: '+1234567890', uptime: '2h 30m', messages: 145 },
        { id: 'session-002', status: 'active', user: 'Support Bot', phone: '+1234567891', uptime: '1h 15m', messages: 67 },
        { id: 'session-003', status: 'inactive', user: 'Marketing Bot', phone: '+1234567892', uptime: '0m', messages: 0 }
    ];

    // Sample users data
    users = [
        { id: 1, name: 'John Doe', phone: '+1234567890', type: 'Admin', status: 'active', lastActive: '2 minutes ago' },
        { id: 2, name: 'Jane Smith', phone: '+1234567891', type: 'User', status: 'active', lastActive: '5 minutes ago' }
    ];
}

// ==================== SESSION MANAGEMENT ====================

// Enhanced createNewSession function that connects to your bot
async function createNewSession() {
    if (isCreatingSession) {
        showNotification('Session creation already in progress...', 'warning');
        return;
    }

    try {
        isCreatingSession = true;
        console.log('🔄 Creating new ADMIN WhatsApp session...');
        
        // Show loading state
        showNotification('Creating new admin session...', 'info');
        
        // Show QR modal immediately
        showQRModal();
        
        // Set loading state in QR modal
        const qrContainer = document.getElementById('qrCode');
        if (qrContainer) {
            qrContainer.innerHTML = `
                <div class="qr-loading">
                    <i class="fas fa-spinner fa-spin" style="font-size: 48px; color: #667eea;"></i>
                    <p style="margin-top: 15px;">Initializing ADMIN WhatsApp session...</p>
                    <p style="font-size: 12px; color: #666;">This may take a few moments</p>
                </div>
            `;
        }

        // 🔑 NEW: Call the ADMIN session creation endpoint
const response = await fetch('https://whatsappbot-u5yq.onrender.com/api/admin/sessions/create', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getAuthToken()}`
    }
});


        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const result = await response.json();
        
        if (result.success) {
            currentSessionId = result.data.sessionId;
            console.log('✅ ADMIN Session created successfully:', currentSessionId);
            showNotification('Admin session created! Waiting for QR code...', 'success');
            
            // Update QR container to show waiting state
            if (qrContainer) {
                qrContainer.innerHTML = `
                    <div class="qr-waiting">
                        <i class="fas fa-qrcode" style="font-size: 48px; color: #667eea;"></i>
                        <p style="margin-top: 15px;">Generating Admin QR Code...</p>
                        <p style="font-size: 12px; color: #666;">Session ID: ${currentSessionId}</p>
                        <p style="font-size: 12px; color: #ff6b6b;">⚠️ This will create an ADMIN bot session</p>
                    </div>
                `;
            }
        } else {
            throw new Error(result.message || 'Failed to create admin session');
        }

    } catch (error) {
        console.error('❌ Error creating admin session:', error);
        showNotification(`Error: ${error.message}`, 'error');
        closeQRModal();
    } finally {
        isCreatingSession = false;
    }
}

// 🔑 NEW: Add auth token helper function
function getAuthToken() {
    // Get the auth token from localStorage or wherever you store it
    return localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
}

// Display QR code in the modal
function displayQRCode(qrData, sessionId) {
    console.log('📱 Displaying QR code for session:', sessionId);

    const qrContainer = document.getElementById('qrCode');
    if (!qrContainer) return;

    // Clear any existing content
    qrContainer.innerHTML = '';

    // Create QR code container
    const qrCodeDiv = document.createElement('div');
    qrCodeDiv.className = 'qr-code-container';
    qrCodeDiv.style.textAlign = 'center';

    // Use online QR code service for simplicity
    const qrImg = document.createElement('img');
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(qrData)}`;
    qrImg.style.border = '1px solid #ddd';
    qrImg.style.borderRadius = '8px';
    qrImg.alt = 'WhatsApp QR Code';
    qrImg.onload = () => {
        console.log('✅ QR code image loaded successfully');
    };
    qrImg.onerror = () => {
        console.error('❌ Failed to load QR code image');
        qrImg.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjU2IiBoZWlnaHQ9IjI1NiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjU2IiBoZWlnaHQ9IjI1NiIgZmlsbD0iI2Y5ZjlmOSIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBkb21pbmFudC1iYXNlbGluZT0ibWlkZGxlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LWZhbWlseT0iQXJpYWwiIGZvbnQtc2l6ZT0iMTQiIGZpbGw9IiM2NjYiPlFSIENvZGU8L3RleHQ+PC9zdmc+';
    };

    qrCodeDiv.appendChild(qrImg);

    // Add session info
    const sessionInfo = document.createElement('div');
    sessionInfo.style.marginTop = '15px';
    sessionInfo.innerHTML = `
        <p style="font-weight: bold; color: #333;">Ready to scan!</p>
        <p style="font-size: 12px; color: #666;">Session: ${sessionId}</p>
        <p style="font-size: 12px; color: #666;">Scan with WhatsApp to connect</p>
    `;

    qrCodeDiv.appendChild(sessionInfo);
    qrContainer.appendChild(qrCodeDiv);

    showNotification('QR Code generated! Scan with WhatsApp to connect.', 'success');
}

// Handle session ready event
function handleSessionReady(data) {
    console.log('🎉 Session is ready:', data);

    const qrContainer = document.getElementById('qrCode');
    if (qrContainer) {
        // 🔑 Check if this is an admin session
        const isAdminSession = data.isAdmin || data.userType === 'admin';
        
        qrContainer.innerHTML = `
            <div style="text-align: center; padding: 20px;">
                <i class="fas fa-check-circle" style="font-size: 64px; color: #48bb78;"></i>
                <h3 style="color: #48bb78; margin: 15px 0;">${isAdminSession ? '👑 Admin Bot Connected!' : 'Bot Connected!'}</h3>
                <p><strong>Phone:</strong> ${data.phone || 'Connected'}</p>
                <p><strong>Session ID:</strong> ${data.uniqueId || data.sessionId}</p>
                ${isAdminSession ? '<p><strong>Role:</strong> System Administrator</p>' : ''}
                <div style="margin-top: 20px; padding: 15px; background: ${isAdminSession ? '#fff3cd' : '#f0f9ff'}; border-radius: 8px; border-left: 4px solid ${isAdminSession ? '#ffc107' : '#667eea'};">
                    <strong>${isAdminSession ? '🛡️ Admin Commands Available:' : '🎯 Test your bot:'}</strong><br>
                    Open WhatsApp and send yourself:<br>
                    <code style="background: #e5e7eb; padding: 2px 6px; border-radius: 4px;">${isAdminSession ? '!help' : '!ping'}</code>
                    ${isAdminSession ? ' or <code style="background: #e5e7eb; padding: 2px 6px; border-radius: 4px;">!stats</code>' : ''}
                </div>
                <button onclick="closeQRModal()" class="btn-primary" style="margin-top: 15px;">
                    <i class="fas fa-check"></i> Continue
                </button>
            </div>
        `;
    }

    showNotification(`${data.isAdmin ? 'Admin bot' : 'Bot'} connected successfully! Phone: ${data.phone || 'Connected'}`, 'success');
    updateStats();
    loadSessions();
}

// Handle session disconnected event
function handleSessionDisconnected(data) {
    console.log('💔 Session disconnected:', data);
    showNotification(`Session disconnected: ${data.reason}`, 'warning');
    updateStats();
    loadSessions();
}

// Handle authentication failure
function handleAuthFailure(data) {
    console.log('🚫 Authentication failed:', data);

    const qrContainer = document.getElementById('qrCode');
    if (qrContainer) {
        qrContainer.innerHTML = `
            <div style="text-align: center; padding: 20px;">
                <i class="fas fa-exclamation-triangle" style="font-size: 64px; color: #f56565;"></i>
                <h3 style="color: #f56565; margin: 15px 0;">Authentication Failed</h3>
                <p>WhatsApp authentication failed. Please try again.</p>
                <button onclick="createNewSession()" class="btn-primary" style="margin-top: 15px;">
                    <i class="fas fa-redo"></i> Try Again
                </button>
            </div>
        `;
    }

    showNotification('WhatsApp authentication failed. Please try again.', 'error');
}

// ==================== NAVIGATION & UI FUNCTIONS ====================

function setupEventListeners() {
    console.log('Setting up event listeners...');

    // Sidebar navigation
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const section = this.getAttribute('data-section');
            switchSection(section);
            
            if (window.innerWidth <= 768) {
                const sidebar = document.querySelector('.admin-sidebar');
                if (sidebar) {
                    sidebar.classList.remove('mobile-open');
                }
            }
        });
    });

    // Mobile menu toggle
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', toggleMobileMenu);
    }

    // Sidebar toggle
    const sidebarToggle = document.getElementById('sidebarToggle');
    if (sidebarToggle) {
        sidebarToggle.addEventListener('click', toggleSidebar);
    }

    // Modal close buttons
    document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', function() {
            const modal = this.closest('.modal');
            if (modal) {
                modal.classList.remove('active');
            }
        });
    });

    // Close modals when clicking outside
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', function(e) {
            if (e.target === this) {
                this.classList.remove('active');
            }
        });
    });

    // Schedule message checkbox
    const scheduleMessage = document.getElementById('scheduleMessage');
    const scheduleGroup = document.getElementById('scheduleGroup');
    if (scheduleMessage && scheduleGroup) {
        scheduleMessage.addEventListener('change', function() {
            scheduleGroup.style.display = this.checked ? 'block' : 'none';
        });
    }
}

 // Settings tabs 
    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            const tabName = this.getAttribute('data-tab');
            
            // Remove active class from all tab buttons
            tabBtns.forEach(b => b.classList.remove('active'));
            
            // Add active class to clicked button
            this.classList.add('active');
            
            // Hide all settings tabs
            document.querySelectorAll('.settings-tab').forEach(tab => {
                tab.classList.remove('active');
            });
            
            // Show selected settings tab
            const selectedTab = document.getElementById(`${tabName}-settings`);
            if (selectedTab) {
                selectedTab.classList.add('active');
            }
        });
    });
}

function switchSection(sectionName) {
    currentSection = sectionName;

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
    }

    // Update page title
    const titles = {
        dashboard: 'Dashboard',
        sessions: 'Bot Sessions',
        users: 'Users & Groups',
        contacts: 'Contacts',
        messages: 'Messages',
        reminders: 'Reminders',
        analytics: 'Analytics',
        settings: 'Settings',
        exemptions: 'Payment Exemptions'
    };

    const pageTitle = document.getElementById('pageTitle');
    if (pageTitle && titles[sectionName]) {
        pageTitle.textContent = titles[sectionName];
    }

    // Load section-specific data
    loadSectionData(sectionName);
}

function loadSectionData(section) {
    switch(section) {
        case 'dashboard':
            loadDashboardData();
            break;
        case 'sessions':
            loadSessions();
            break;
        case 'users':
            loadUsers();
            break;
        case 'exemptions':
            loadOwnerInfo();
            loadUsersExemptionStatus();
            break;
        // Add other cases as needed
    }
}

// ==================== DASHBOARD FUNCTIONS ====================

function updateStats() {
    const activeSessions = document.getElementById('activeSessions');
    const totalUsers = document.getElementById('totalUsers');
    const messagesProcessed = document.getElementById('messagesProcessed');

    if (activeSessions) activeSessions.textContent = sessions.filter(s => s.status === 'active').length;
    if (totalUsers) totalUsers.textContent = users.length.toString();
    if (messagesProcessed) messagesProcessed.textContent = '3,456';

    updateUptime();
}

function updateUptime() {
    const uptimeElement = document.getElementById('uptime');
    if (!uptimeElement) return;

    const startTime = new Date('2024-01-01T00:00:00');
    const now = new Date();
    const uptime = now - startTime;

    const days = Math.floor(uptime / (1000 * 60 * 60 * 24));
    const hours = Math.floor((uptime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));

    uptimeElement.textContent = `${days}d ${hours}h ${minutes}m`;
}

function loadRecentActivity() {
    const activityList = document.getElementById('activityList');
    if (!activityList) return;

    const activities = [
        { icon: 'fas fa-user-plus', text: 'New user registered: +234567890', time: '2 minutes ago', type: 'success' },
        { icon: 'fas fa-comments', text: 'Broadcast sent to 45 groups', time: '5 minutes ago', type: 'info' },
        { icon: 'fas fa-plug', text: 'New session created successfully', time: '15 minutes ago', type: 'success' }
    ];

    activityList.innerHTML = activities.map(activity => `
        <div class="activity-item ${activity.type}">
            <div class="activity-icon">
                <i class="${activity.icon}"></i>
            </div>
            <div class="activity-content">
                <p>${activity.text}</p>
                <span class="activity-time">${activity.time}</span>
            </div>
        </div>
    `).join('');
}

// ==================== SESSION MANAGEMENT UI ====================
function loadSessions() {
    const sessionsGrid = document.getElementById('sessionsGrid');
    if (!sessionsGrid) return;

    if (sessions.length === 0) {
        sessionsGrid.innerHTML = `
            <div class="empty-state" style="text-align: center; padding: 60px 20px;">
                <i class="fas fa-robot" style="font-size: 64px; color: #667eea; margin-bottom: 20px;"></i>
                <h3 style="margin-bottom: 10px; color: #333;">No Bot Sessions Found</h3>
                <p style="color: #666; margin-bottom: 20px;">No users have created WhatsApp bot sessions yet.</p>
                <button onclick="fetchAllSessions()" class="btn-secondary">
                    <i class="fas fa-sync-alt"></i> Refresh
                </button>
            </div>
        `;
        return;
    }

    sessionsGrid.innerHTML = sessions.map(session => {
        const statusClass = session.status === 'active' ? 'active' : 
                          session.status === 'waiting_qr' ? 'waiting' : 'inactive';
        
        return `
            <div class="session-card ${statusClass}">
                <div class="session-header">
                    <div class="session-status">
                        <span class="status-indicator ${statusClass}"></span>
                        <span class="status-text">${session.status.replace('_', ' ').toUpperCase()}</span>
                    </div>
                    <div class="session-actions">
                        <button class="action-btn" onclick="viewSession('${session.id}')" title="View Details">
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
                    <h4>${session.user}</h4>
                    <p class="session-email" style="font-size: 12px; color: #666;">${session.email || ''}</p>
                    <p class="session-phone" style="margin: 8px 0;">
                        <i class="fas fa-phone" style="margin-right: 5px;"></i>${session.phone}
                    </p>
                    <div class="session-stats">
                        <div class="stat">
                            <span class="stat-label">Uptime</span>
                            <span class="stat-value">${session.uptime}</span>
                        </div>
                        <div class="stat">
                            <span class="stat-label">Messages</span>
                            <span class="stat-value">${session.messages}</span>
                        </div>
                        <div class="stat">
                            <span class="stat-label">Plan</span>
                            <span class="stat-value" style="text-transform: capitalize;">${session.subscription}</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    // Update session count badge
    const sessionCount = document.getElementById('sessionCount');
    if (sessionCount) {
        const activeSessions = sessions.filter(s => s.status === 'active').length;
        sessionCount.textContent = activeSessions;
        sessionCount.style.display = activeSessions > 0 ? 'flex' : 'none';
    }
}

// ==================== FETCH REAL SESSIONS FROM API ====================

async function fetchAllSessions() {
    try {
        console.log('📡 Fetching all sessions from API...');
        
        const response = await fetch(`${CONFIG.API_BASE}/api/admin/sessions`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${getAuthToken()}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: Failed to fetch sessions`);
        }
        
        const result = await response.json();
        
        if (result.success) {
            // Transform API data to match UI format
            sessions = result.data.sessions.map(session => ({
                id: session._id,
                sessionId: session.sessionId,
                user: session.userId?.fullName || session.userId?.email || 'Unknown User',
                userId: session.userId?._id,
                email: session.userId?.email,
                phone: session.phone || 'Not connected',
                status: session.status || 'inactive',
                uptime: calculateUptime(session.createdAt),
                messages: session.messageCount || 0,
                createdAt: session.createdAt,
                subscription: session.userId?.subscription || 'free'
            }));
            
            console.log('✅ Loaded', sessions.length, 'sessions from API');
            
            // Render the sessions
            loadSessions();
            
            // Update stats
            updateStats();
        } else {
            throw new Error(result.message || 'Failed to load sessions');
        }
        
    } catch (error) {
        console.error('❌ Error fetching sessions:', error);
        showNotification(`Error loading sessions: ${error.message}`, 'error');
        
        // Fall back to empty array
        sessions = [];
        loadSessions();
    }
}

// Helper function to calculate uptime
function calculateUptime(createdAt) {
    if (!createdAt) return 'N/A';
    
    const now = new Date();
    const created = new Date(createdAt);
    const diffMs = now - created;
    
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

// ==================== SESSION ACTIONS ====================

// ==================== SESSION ACTIONS ====================

// Delete a session
async function deleteSession(sessionId) {
    if (!confirm('⚠️ Delete this session?\n\nThis will disconnect the WhatsApp bot and remove all session data.')) {
        return;
    }
    
    try {
        showNotification('Deleting session...', 'info');
        
        const response = await fetch(`${CONFIG.API_BASE}/api/admin/sessions/${sessionId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${getAuthToken()}`,
                'Content-Type': 'application/json'
            }
        });
        
        const result = await response.json();
        
        if (result.success) {
            showNotification('✅ Session deleted successfully', 'success');
            await fetchAllSessions();
        } else {
            throw new Error(result.message || 'Failed to delete session');
        }
        
    } catch (error) {
        console.error('❌ Error deleting session:', error);
        showNotification(`Error: ${error.message}`, 'error');
    }
}

// Restart a session
async function restartSession(sessionId) {
    if (!confirm('Restart this session? The user will need to scan the QR code again.')) {
        return;
    }
    
    try {
        showNotification('Restarting session...', 'info');
        
        const response = await fetch(`${CONFIG.API_BASE}/api/admin/sessions/${sessionId}/restart`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${getAuthToken()}`,
                'Content-Type': 'application/json'
            }
        });
        
        const result = await response.json();
        
        if (result.success) {
            showNotification('✅ Session restarted', 'success');
            await fetchAllSessions();
        } else {
            throw new Error(result.message || 'Failed to restart session');
        }
        
    } catch (error) {
        console.error('❌ Error restarting session:', error);
        showNotification(`Error: ${error.message}`, 'error');
    }
}

// View session details
function viewSession(sessionId) {
    const session = sessions.find(s => s.id === sessionId || s.sessionId === sessionId);
    
    if (!session) {
        showNotification('Session not found', 'error');
        return;
    }
    
    showNotification(`Viewing session: ${session.user}`, 'info');
    console.log('Session details:', session);
}

// ==================== USER MANAGEMENT ====================


// Search and filter users
function searchUsers() {
    const searchInput = document.getElementById('userSearch');
    const statusFilter = document.getElementById('statusFilter');
    const subscriptionFilter = document.getElementById('subscriptionFilter');
    
    const search = searchInput?.value || '';
    const status = statusFilter?.value || '';
    const subscription = subscriptionFilter?.value || '';
    
    loadUsersWithFilters(1, search, status, subscription);
}

async function loadUsersWithFilters(page = 1, search = '', status = '', subscription = '') {
    const usersTableBody = document.getElementById('usersTableBody');
    if (!usersTableBody) return;

    try {
        const token = localStorage.getItem('adminToken');
        const limit = 20;
        
        let url = `/api/admin/users?page=${page}&limit=${limit}`;
        if (search) url += `&search=${encodeURIComponent(search)}`;
        if (status) url += `&status=${status}`;
        if (subscription) url += `&subscription=${subscription}`;
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        const data = await response.json();
        
        // ... rest of the loadUsers logic ...
        // (same as the loadUsers function above)
        
    } catch (error) {
        console.error('Error loading users:', error);
    }
}

let currentPage = 1;
let totalPages = 1;

async function loadUsers(page = 1) {
    const usersTableBody = document.getElementById('usersTableBody');
    if (!usersTableBody) return;

    try {
        const token = localStorage.getItem('adminToken');
        const limit = 20; // Users per page
        
        const response = await fetch(`/api/admin/users?page=${page}&limit=${limit}`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        const data = await response.json();

        if (!data.success) {
            usersTableBody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 20px; color: #666;">
                        <i class="fas fa-exclamation-circle" style="margin-right: 8px;"></i>
                        Failed to load users
                    </td>
                </tr>
            `;
            return;
        }

        const users = data.users;
        currentPage = data.pagination.currentPage;
        totalPages = data.pagination.totalPages;

        if (users.length === 0) {
            usersTableBody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 20px; color: #666;">
                        <i class="fas fa-info-circle" style="margin-right: 8px;"></i>
                        No users found
                    </td>
                </tr>
            `;
            updatePagination(data.pagination);
            return;
        }

        usersTableBody.innerHTML = users.map(user => {
            const initials = user.name.split(' ').map(n => n[0]).join('').toUpperCase();
            const statusColor = user.status === 'active' ? '#48bb78' : '#9ca3af';
            const subscriptionBadgeColor = {
                'starter': '#3b82f6',
                'professional': '#8b5cf6',
                'business': '#f59e0b',
                'enterprise': '#ef4444'
            }[user.subscription] || '#6b7280';

            return `
                <tr>
                    <td>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <div style="width: 32px; height: 32px; background: #667eea; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-size: 12px; font-weight: 600;">
                                ${initials}
                            </div>
                            <div>
                                <div style="font-weight: 600;">${user.name}</div>
                                <div style="font-size: 12px; color: #6b7280;">${user.email}</div>
                            </div>
                        </div>
                    </td>
                    <td>${user.phone}</td>
                    <td>
                        <span style="padding: 4px 8px; background: ${subscriptionBadgeColor}; color: white; border-radius: 4px; font-size: 12px; text-transform: capitalize;">
                            ${user.subscription}
                        </span>
                    </td>
                    <td>
                        <span style="color: ${statusColor}; font-weight: 600;">
                            <i class="fas fa-circle" style="font-size: 8px; margin-right: 4px;"></i>
                            ${user.status === 'active' ? 'Active' : 'Inactive'}
                        </span>
                        ${user.status === 'inactive' && user.subscriptionExpiry ? 
                            `<div style="font-size: 11px; color: #ef4444;">Expired: ${new Date(user.subscriptionExpiry).toLocaleDateString()}</div>` 
                            : ''}
                    </td>
                    <td>${new Date(user.lastActive).toLocaleString()}</td>
                    <td>
                        <button class="action-btn" style="border: none; background: none; padding: 4px; cursor: pointer;" onclick="editUser('${user.id}')" title="Edit User">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="action-btn" style="border: none; background: none; padding: 4px; cursor: pointer;" onclick="manageUserCommands('${user.id}')" title="Manage Commands">
                            <i class="fas fa-terminal"></i>
                        </button>
                        <button class="action-btn danger" style="border: none; background: none; padding: 4px; cursor: pointer; color: #ef4444;" onclick="deleteUser('${user.id}')" title="Delete User">
                            <i class="fas fa-trash"></i>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

        // Update pagination controls
        updatePagination(data.pagination);

    } catch (error) {
        console.error('Error loading users:', error);
        usersTableBody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align: center; padding: 20px; color: #ef4444;">
                    <i class="fas fa-exclamation-triangle" style="margin-right: 8px;"></i>
                    Error loading users
                </td>
            </tr>
        `;
    }
}

// Update pagination controls
function updatePagination(pagination) {
    let paginationContainer = document.getElementById('usersPagination');
    
    // Create pagination container if it doesn't exist
    if (!paginationContainer) {
        const tableContainer = document.querySelector('.users-table-container');
        if (tableContainer) {
            paginationContainer = document.createElement('div');
            paginationContainer.id = 'usersPagination';
            paginationContainer.style.cssText = 'display: flex; justify-content: center; align-items: center; gap: 10px; margin-top: 20px; padding: 15px;';
            tableContainer.appendChild(paginationContainer);
        } else {
            return;
        }
    }

    const { currentPage, totalPages, totalUsers, hasPrevPage, hasNextPage } = pagination;

    paginationContainer.innerHTML = `
        <button 
            onclick="loadUsers(1)" 
            ${currentPage === 1 ? 'disabled' : ''}
            style="padding: 8px 12px; border: 1px solid #e5e7eb; background: white; border-radius: 4px; cursor: ${currentPage === 1 ? 'not-allowed' : 'pointer'}; opacity: ${currentPage === 1 ? '0.5' : '1'};"
            title="First Page">
            <i class="fas fa-angle-double-left"></i>
        </button>
        
        <button 
            onclick="loadUsers(${currentPage - 1})" 
            ${!hasPrevPage ? 'disabled' : ''}
            style="padding: 8px 12px; border: 1px solid #e5e7eb; background: white; border-radius: 4px; cursor: ${!hasPrevPage ? 'not-allowed' : 'pointer'}; opacity: ${!hasPrevPage ? '0.5' : '1'};"
            title="Previous Page">
            <i class="fas fa-angle-left"></i>
        </button>
        
        <span style="padding: 8px 16px; color: #374151; font-weight: 500;">
            Page ${currentPage} of ${totalPages} (${totalUsers} total users)
        </span>
        
        <button 
            onclick="loadUsers(${currentPage + 1})" 
            ${!hasNextPage ? 'disabled' : ''}
            style="padding: 8px 12px; border: 1px solid #e5e7eb; background: white; border-radius: 4px; cursor: ${!hasNextPage ? 'not-allowed' : 'pointer'}; opacity: ${!hasNextPage ? '0.5' : '1'};"
            title="Next Page">
            <i class="fas fa-angle-right"></i>
        </button>
        
        <button 
            onclick="loadUsers(${totalPages})" 
            ${currentPage === totalPages ? 'disabled' : ''}
            style="padding: 8px 12px; border: 1px solid #e5e7eb; background: white; border-radius: 4px; cursor: ${currentPage === totalPages ? 'not-allowed' : 'pointer'}; opacity: ${currentPage === totalPages ? '0.5' : '1'};"
            title="Last Page">
            <i class="fas fa-angle-double-right"></i>
        </button>
    `;
}

// Edit user basic info
async function editUser(userId) {
    try {
        const token = localStorage.getItem('adminToken');
        const response = await fetch('/api/admin/users', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        const user = data.users.find(u => u.id === userId);

        if (!user) {
            showNotification('User not found', 'error');
            return;
        }

        // Create modal
        const modal = document.createElement('div');
        modal.className = 'modal active';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Edit User: ${user.name}</h3>
                    <button class="modal-close" onclick="this.closest('.modal').remove()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="modal-body">
                    <div class="form-group">
                        <label>Name</label>
                        <input type="text" id="editUserName" value="${user.name}" readonly style="background: #f3f4f6;">
                    </div>
                    <div class="form-group">
                        <label>Email</label>
                        <input type="email" id="editUserEmail" value="${user.email}" readonly style="background: #f3f4f6;">
                    </div>
                    <div class="form-group">
                        <label>Phone</label>
                        <input type="text" id="editUserPhone" value="${user.phone}" readonly style="background: #f3f4f6;">
                    </div>
                    <div class="form-group">
                        <label>Status</label>
                        <select id="editUserStatus">
                            <option value="active" ${user.status === 'active' ? 'selected' : ''}>Active</option>
                            <option value="inactive" ${user.status === 'inactive' ? 'selected' : ''}>Inactive</option>
                            <option value="suspended" ${user.status === 'suspended' ? 'selected' : ''}>Suspended</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Subscription</label>
                        <input type="text" value="${user.subscription}" readonly style="background: #f3f4f6; text-transform: capitalize;">
                    </div>
                    <div class="form-group">
                        <label>Payment Status</label>
                        <input type="text" value="${user.paymentStatus}" readonly style="background: #f3f4f6; text-transform: capitalize;">
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn-secondary" onclick="this.closest('.modal').remove()">Cancel</button>
                    <button class="btn-primary" onclick="saveUserEdit('${userId}')">Save Changes</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    } catch (error) {
        console.error('Error editing user:', error);
        showNotification('Error loading user data', 'error');
    }
}

async function saveUserEdit(userId) {
    try {
        const status = document.getElementById('editUserStatus').value;
        const token = localStorage.getItem('adminToken');

        const response = await fetch(`/api/admin/users/${userId}/status`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ status })
        });

        const data = await response.json();

        if (data.success) {
            showNotification('User updated successfully', 'success');
            document.querySelector('.modal').remove();
            loadUsers(); // Reload the users table
        } else {
            showNotification(data.message || 'Failed to update user', 'error');
        }
    } catch (error) {
        console.error('Error saving user:', error);
        showNotification('Error updating user', 'error');
    }
}

// Manage custom commands for a user
async function manageUserCommands(userId) {
    try {
        const token = localStorage.getItem('adminToken');
        const response = await fetch('/api/admin/users', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        const user = data.users.find(u => u.id === userId);

        if (!user) {
            showNotification('User not found', 'error');
            return;
        }

        // All available commands
        const allCommands = [
            'ping', 'help', 'status', 'list', 'tag', 'tagexcept', 
            'broadcast', 'auto_reply', 'analytics', 'scheduler', 
            'custom_commands', 'export', 'dmall', 'tagfew', 'forward'
        ];

        const modal = document.createElement('div');
        modal.className = 'modal active';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 600px;">
                <div class="modal-header">
                    <h3>Manage Commands: ${user.name}</h3>
                    <button class="modal-close" onclick="this.closest('.modal').remove()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="modal-body">
                    <p style="margin-bottom: 16px; color: #6b7280;">
                        <strong>Current Subscription:</strong> <span style="text-transform: capitalize;">${user.subscription}</span>
                    </p>
                    <p style="margin-bottom: 16px; color: #6b7280; font-size: 14px;">
                        Grant additional commands to this user beyond their subscription level.
                    </p>
                    <div style="max-height: 400px; overflow-y: auto;">
                        ${allCommands.map(cmd => `
                            <label style="display: flex; align-items: center; padding: 8px; border-bottom: 1px solid #e5e7eb; cursor: pointer;">
                                <input type="checkbox" 
                                    value="${cmd}" 
                                    ${user.customCommands.includes(cmd) ? 'checked' : ''}
                                    style="margin-right: 12px; width: 18px; height: 18px; cursor: pointer;">
                                <span style="font-family: monospace; font-weight: 600;">!${cmd}</span>
                            </label>
                        `).join('')}
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn-secondary" onclick="this.closest('.modal').remove()">Cancel</button>
                    <button class="btn-primary" onclick="saveUserCommands('${userId}')">Save Commands</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    } catch (error) {
        console.error('Error managing commands:', error);
        showNotification('Error loading user commands', 'error');
    }
}

async function saveUserCommands(userId) {
    try {
        const modal = document.querySelector('.modal');
        const checkboxes = modal.querySelectorAll('input[type="checkbox"]:checked');
        const customCommands = Array.from(checkboxes).map(cb => cb.value);

        const token = localStorage.getItem('adminToken');
        const response = await fetch(`/api/admin/users/${userId}/commands`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ customCommands })
        });

        const data = await response.json();

        if (data.success) {
            showNotification('Custom commands updated successfully', 'success');
            modal.remove();
            loadUsers();
        } else {
            showNotification(data.message || 'Failed to update commands', 'error');
        }
    } catch (error) {
        console.error('Error saving commands:', error);
        showNotification('Error updating commands', 'error');
    }
}

// ==================== EXEMPTION MANAGEMENT ====================

async function loadOwnerInfo() {
    try {
        // For now, show placeholder data since the API endpoint doesn't exist yet
        const ownerNumberElement = document.getElementById('ownerNumber');
        const ownerStatusElement = document.getElementById('ownerStatus');
        
        if (ownerNumberElement) ownerNumberElement.textContent = 'Not configured yet';
        if (ownerStatusElement) ownerStatusElement.textContent = '⚠️ Configure in config.json';
        
        console.log('Owner info loaded (placeholder)');
    } catch (error) {
        console.error('Error loading owner info:', error);
    }
}

async function loadUsersExemptionStatus() {
    try {
        // For now, show placeholder data
        const tbody = document.getElementById('usersExemptionTableBody');
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 20px; color: #666;">
                        <i class="fas fa-info-circle" style="margin-right: 8px;"></i>
                        Exemption management will be available once authentication is configured
                    </td>
                </tr>
            `;
        }
        
        console.log('Users exemption status loaded (placeholder)');
    } catch (error) {
        console.error('Error loading users exemption status:', error);
    }
}

// Exemption functions (placeholder for now)
function exemptUser(grant) {
    const userId = document.getElementById('exemptUserId')?.value;
    const reason = document.getElementById('exemptReason')?.value;
    
    if (!userId) {
        showNotification('Please enter a User ID', 'error');
        return;
    }
    
    if (grant && !reason) {
        showNotification('Please enter a reason for exemption', 'error');
        return;
    }
    
    const action = grant ? 'granted' : 'removed';
    showNotification(`Exemption ${action} for user ${userId}`, 'success');
    
    // Clear form
    if (document.getElementById('exemptUserId')) document.getElementById('exemptUserId').value = '';
    if (document.getElementById('exemptReason')) document.getElementById('exemptReason').value = '';
    
    // Reload exemption data
    loadUsersExemptionStatus();
}

function refreshExemptions() {
    showNotification('Refreshing exemption data...', 'info');
    loadOwnerInfo();
    loadUsersExemptionStatus();
}

// ==================== MODAL FUNCTIONS ====================

function showQRModal() {
    const modal = document.getElementById('qrModal');
    if (modal) {
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
}

function closeQRModal() {
    const modal = document.getElementById('qrModal');
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
        
        // Reset modal content
        const qrContainer = document.getElementById('qrCode');
        if (qrContainer) {
            qrContainer.innerHTML = `
                <i class="fas fa-qrcode"></i>
                <p>Click "New Session" to generate QR code</p>
            `;
        }
    }
    
    // Reset session creation state
    isCreatingSession = false;
    currentSessionId = null;
}

function showBroadcastModal() {
    const modal = document.getElementById('broadcastModal');
    if (modal) {
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
}

function closeBroadcastModal() {
    const modal = document.getElementById('broadcastModal');
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
        
        // Reset form
        const broadcastMessage = document.getElementById('broadcastMessage');
        const scheduleMessage = document.getElementById('scheduleMessage');
        const scheduleGroup = document.getElementById('scheduleGroup');
        
        if (broadcastMessage) broadcastMessage.value = '';
        if (scheduleMessage) scheduleMessage.checked = false;
        if (scheduleGroup) scheduleGroup.style.display = 'none';
    }
}

// ==================== UTILITY FUNCTIONS ====================

function showNotification(message, type = 'info') {
    // Remove existing notifications
    document.querySelectorAll('.notification').forEach(notification => {
        notification.remove();
    });

    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.innerHTML = `
        <i class="fas fa-${type === 'success' ? 'check' : type === 'error' ? 'exclamation-triangle' : type === 'warning' ? 'exclamation-triangle' : 'info-circle'}"></i>
        <span>${message}</span>
        <button onclick="this.parentElement.remove()"><i class="fas fa-times"></i></button>
    `;
    
    // Add notification styles
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'success' ? '#48bb78' : type === 'error' ? '#f56565' : type === 'warning' ? '#ed8936' : '#667eea'};
        color: white;
        padding: 12px 16px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        display: flex;
        align-items: center;
        gap: 8px;
        z-index: 10000;
        max-width: 400px;
        opacity: 0;
        transform: translateX(100%);
        transition: all 0.3s ease;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;
    
    // Style the close button
    const closeBtn = notification.querySelector('button');
    if (closeBtn) {
        closeBtn.style.cssText = `
            background: none;
            border: none;
            color: white;
            cursor: pointer;
            padding: 0;
            margin-left: auto;
            opacity: 0.8;
        `;
        closeBtn.addEventListener('mouseenter', () => closeBtn.style.opacity = '1');
        closeBtn.addEventListener('mouseleave', () => closeBtn.style.opacity = '0.8');
    }
    
    document.body.appendChild(notification);
    
    // Animate in
    setTimeout(() => {
        notification.style.opacity = '1';
        notification.style.transform = 'translateX(0)';
    }, 100);
    
    // Auto remove after 5 seconds
    setTimeout(() => {
        if (notification.parentElement) {
            notification.style.opacity = '0';
            notification.style.transform = 'translateX(100%)';
            setTimeout(() => notification.remove(), 300);
        }
    }, 5000);
}

function updateConnectionStatus(isConnected) {
    const status = document.getElementById('connectionStatus');
    if (!status) return;

    if (isConnected) {
        status.innerHTML = '<div class="status-indicator online"></div><span>Connected</span>';
    } else {
        status.innerHTML = '<div class="status-indicator offline"></div><span>Disconnected</span>';
    }
}

function toggleMobileMenu() {
    const sidebar = document.querySelector('.admin-sidebar');
    if (sidebar) {
        sidebar.classList.toggle('mobile-open');
    }
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
    showNotification('Refreshing data...', 'info');
    loadDashboardData();
    loadSectionData(currentSection);
}

function startRealTimeUpdates() {
    // Update data every 30 seconds
    setInterval(() => {
        if (currentSection === 'dashboard') {
            updateStats();
            updateConnectionStatus(socket && socket.connected);
        }
    }, 30000);

    // Update uptime every minute
    setInterval(updateUptime, 60000);
}


function logout() {
    if (socket) {
        socket.disconnect();
    }
    
    localStorage.removeItem('userSession');
    window.location.href = '/index.html';
}

// ==================== QUICK ACTION FUNCTIONS ====================

function broadcastMessage() {
    showBroadcastModal();
}

function exportData() {
    showNotification('Preparing data export...', 'info');
    
    // Simulate export process
    setTimeout(() => {
        showNotification('Data export completed! Check your downloads.', 'success');
        
        // Create a simple CSV export for demo
        const csvData = [
            ['Type', 'ID', 'Name', 'Status', 'Created'],
            ...sessions.map(s => ['Session', s.id, s.user, s.status, new Date().toISOString()]),
            ...users.map(u => ['User', u.id, u.name, u.status, new Date().toISOString()])
        ];
        
        const csvContent = csvData.map(row => row.join(',')).join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `admin-export-${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    }, 2000);
}

function systemRestart() {
    if (confirm('Are you sure you want to restart the bot system? This will disconnect all active sessions.')) {
        showNotification('System restart initiated...', 'warning');
        
        // Simulate restart process
        let countdown = 5;
        const countdownInterval = setInterval(() => {
            showNotification(`System restarting in ${countdown} seconds...`, 'warning');
            countdown--;
            
            if (countdown < 0) {
                clearInterval(countdownInterval);
                showNotification('System restart completed successfully', 'success');
                
                // Update all sessions to show restart effect
                sessions.forEach(session => {
                    session.uptime = '0m';
                    session.messages = 0;
                });
                
                refreshData();
            }
        }, 1000);
    }
}


async function sendBroadcast() {
    const message = document.getElementById('broadcastMessage')?.value;
    const target = document.getElementById('broadcastTarget')?.value;
    const scheduleMessage = document.getElementById('scheduleMessage')?.checked;
    const scheduleTime = document.getElementById('scheduleTime')?.value;
    
    if (!message || !message.trim()) {
        showNotification('Please enter a message', 'error');
        return;
    }

    if (scheduleMessage && !scheduleTime) {
        showNotification('Please select a schedule time', 'error');
        return;
    }

    // Show loading state
    showNotification('Sending broadcast...', 'info');
    
    try {
        const token = localStorage.getItem('adminToken');
        const response = await fetch('/api/admin/broadcast', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                message: message.trim(),
                target,
                scheduleTime: scheduleMessage ? scheduleTime : null
            })
        });

        const data = await response.json();

        if (data.success) {
            const targetText = target === 'all' ? 'all users' : 
                              target === 'groups' ? 'all groups' : 
                              target === 'individuals' ? 'all individuals' :
                              target === 'active' ? 'active users' : 'selected users';
            
            if (scheduleMessage) {
                showNotification(`Broadcast scheduled successfully for ${new Date(scheduleTime).toLocaleString()}!`, 'success');
            } else {
                showNotification(`Broadcast sent to ${data.data.sent}/${data.data.totalTargets} users successfully!`, 'success');
            }
            
            closeBroadcastModal();
            
            // Add to recent activity
            const activityList = document.getElementById('activityList');
            if (activityList && activityList.children.length > 0) {
                const newActivity = document.createElement('div');
                newActivity.className = 'activity-item success';
                newActivity.innerHTML = `
                    <div class="activity-icon">
                        <i class="fas fa-bullhorn"></i>
                    </div>
                    <div class="activity-content">
                        <p>Broadcast sent to ${targetText} (${data.data.sent} successful, ${data.data.failed} failed)</p>
                        <span class="activity-time">Just now</span>
                    </div>
                `;
                activityList.insertBefore(newActivity, activityList.firstChild);
            }
        } else {
            showNotification(data.message || 'Failed to send broadcast', 'error');
        }
    } catch (error) {
        console.error('Broadcast error:', error);
        showNotification('Error sending broadcast. Please try again.', 'error');
    }
}

// ==================== SESSION ACTION FUNCTIONS ====================

function createSession() {
    createNewSession();
}

function viewSession(id) {
    const session = sessions.find(s => s.id === id);
    if (!session) {
        showNotification('Session not found', 'error');
        return;
    }
    
    showNotification(`Viewing session: ${session.user} (${session.phone})`, 'info');
    
    // Create a simple session details modal
    const existingModal = document.getElementById('sessionDetailsModal');
    if (existingModal) {
        existingModal.remove();
    }
    
    const modal = document.createElement('div');
    modal.id = 'sessionDetailsModal';
    modal.className = 'modal active';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>Session Details</h3>
                <button class="modal-close" onclick="document.getElementById('sessionDetailsModal').remove()">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                    <div>
                        <h4>Basic Information</h4>
                        <p><strong>Session ID:</strong> ${session.id}</p>
                        <p><strong>User:</strong> ${session.user}</p>
                        <p><strong>Phone:</strong> ${session.phone}</p>
                        <p><strong>Status:</strong> <span style="color: ${session.status === 'active' ? '#48bb78' : '#f56565'}">${session.status}</span></p>
                    </div>
                    <div>
                        <h4>Statistics</h4>
                        <p><strong>Uptime:</strong> ${session.uptime}</p>
                        <p><strong>Messages Processed:</strong> ${session.messages}</p>
                        <p><strong>Last Activity:</strong> 2 minutes ago</p>
                        <p><strong>Groups Connected:</strong> 12</p>
                    </div>
                </div>
                <div style="margin-top: 20px;">
                    <h4>Recent Commands</h4>
                    <div style="background: #f8f9fa; padding: 10px; border-radius: 4px; font-family: monospace; font-size: 12px;">
                        !ping - 2 minutes ago<br>
                        !tagall - 5 minutes ago<br>
                        !help - 10 minutes ago
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="document.getElementById('sessionDetailsModal').remove()">Close</button>
                <button class="btn-primary" onclick="restartSession('${session.id}'); document.getElementById('sessionDetailsModal').remove();">
                    <i class="fas fa-redo"></i> Restart Session
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    document.body.style.overflow = 'hidden';
    
    // Close modal when clicking outside
    modal.addEventListener('click', function(e) {
        if (e.target === this) {
            this.remove();
            document.body.style.overflow = '';
        }
    });
}

function restartSession(id) {
    const session = sessions.find(s => s.id === id);
    if (!session) {
        showNotification('Session not found', 'error');
        return;
    }
    
    if (confirm(`Are you sure you want to restart session ${session.user}?`)) {
        showNotification(`Restarting session: ${session.user}`, 'warning');
        
        // Simulate restart process
        session.status = 'inactive';
        loadSessions();
        
        setTimeout(() => {
            session.status = 'active';
            session.uptime = '0m';
            session.messages = 0;
            loadSessions();
            showNotification(`Session ${session.user} restarted successfully`, 'success');
        }, 2000);
    }
}

function deleteSession(id) {
    const session = sessions.find(s => s.id === id);
    if (!session) {
        showNotification('Session not found', 'error');
        return;
    }
    
    if (confirm(`Are you sure you want to delete session ${session.user}? This action cannot be undone.`)) {
        showNotification(`Deleting session: ${session.user}`, 'error');
        
        setTimeout(() => {
            sessions = sessions.filter(session => session.id !== id);
            showNotification(`Session ${session.user} deleted successfully`, 'success');
            loadSessions();
            updateStats();
        }, 1500);
    }
}

// ==================== PLACEHOLDER FUNCTIONS ====================

function addUser() {
    showNotification('Add user functionality coming soon!', 'info');
    
    // Simulate adding a user
    setTimeout(() => {
        const newUser = {
            id: users.length + 1,
            name: `User ${users.length + 1}`,
            phone: `+123456789${users.length}`,
            type: 'User',
            status: 'active',
            lastActive: 'Just now'
        };
        
        users.push(newUser);
        loadUsers();
        showNotification(`User ${newUser.name} added successfully!`, 'success');
    }, 1000);
}

function editUser(userId) {
    const user = users.find(u => u.id === userId);
    if (!user) {
        showNotification('User not found', 'error');
        return;
    }
    
    showNotification(`Edit user ${user.name} functionality coming soon!`, 'info');
}

function deleteUser(userId) {
    const user = users.find(u => u.id === userId);
    if (!user) {
        showNotification('User not found', 'error');
        return;
    }
    
    if (confirm(`Are you sure you want to delete user ${user.name}?`)) {
        users = users.filter(u => u.id !== userId);
        loadUsers();
        updateStats();
        showNotification(`User ${user.name} deleted successfully!`, 'success');
    }
}

function exportUsers() {
    showNotification('Exporting users data...', 'info');
    
    setTimeout(() => {
        const csvData = [
            ['ID', 'Name', 'Phone', 'Type', 'Status', 'Last Active'],
            ...users.map(u => [u.id, u.name, u.phone, u.type, u.status, u.lastActive])
        ];
        
        const csvContent = csvData.map(row => row.join(',')).join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `users-export-${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        
        showNotification('Users data exported successfully!', 'success');
    }, 1500);
}

function addContact() {
    showNotification('Add contact functionality coming soon!', 'info');
}

function importContacts() {
    showNotification('Import contacts functionality coming soon!', 'info');
}

function createReminder() {
    showNotification('Create reminder functionality coming soon!', 'info');
}

function saveSettings() {
    showNotification('Settings saved successfully!', 'success');
}

function addAdmin() {
    showNotification('Add admin functionality coming soon!', 'info');
}

// ==================== GLOBAL FUNCTION EXPORTS ====================

// Make functions available globally for onclick handlers
window.createNewSession = createNewSession;
window.broadcastMessage = broadcastMessage;
window.exportData = exportData;
window.systemRestart = systemRestart;
window.showBroadcastModal = showBroadcastModal;
window.closeBroadcastModal = closeBroadcastModal;
window.showQRModal = showQRModal;
window.closeQRModal = closeQRModal;
window.sendBroadcast = sendBroadcast;
window.refreshData = refreshData;
window.toggleMobileMenu = toggleMobileMenu;
window.toggleSidebar = toggleSidebar;
window.logout = logout;
window.createSession = createSession;
window.viewSession = viewSession;
window.restartSession = restartSession;
window.deleteSession = deleteSession;
window.addUser = addUser;
window.editUser = editUser;
window.deleteUser = deleteUser;
window.exportUsers = exportUsers;
window.addContact = addContact;
window.importContacts = importContacts;
window.createReminder = createReminder;
window.saveSettings = saveSettings;
window.addAdmin = addAdmin;
window.exemptUser = exemptUser;
window.refreshExemptions = refreshExemptions;

// ==================== INITIALIZATION COMPLETE ====================

console.log('✅ Admin dashboard JavaScript loaded successfully');