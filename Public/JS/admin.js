// Global variables
let currentSection = 'dashboard';
let sessions = [];
let users = [];
let socket = null;
let currentSessionId = null;
let isCreatingSession = false;

// ==================== INITIALIZATION ====================

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
        socket = io({
            transports: ['websocket', 'polling'],
            timeout: 10000,
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionAttempts: 5
        });

        // Socket event listeners
        socket.on('connect', () => {
            console.log('✅ Connected to server');
            const adminId = 'admin-user';
            socket.emit('join-user-room', adminId);
            updateConnectionStatus(true);
        });

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

    } catch (error) {
        console.error('Socket setup error:', error);
        updateConnectionStatus(false);
    }
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
        console.log('🔄 Creating new WhatsApp session...');
        
        // Show loading state
        showNotification('Creating new session...', 'info');
        
        // Show QR modal immediately
        showQRModal();
        
        // Set loading state in QR modal
        const qrContainer = document.getElementById('qrCode');
        if (qrContainer) {
            qrContainer.innerHTML = `
                <div class="qr-loading">
                    <i class="fas fa-spinner fa-spin" style="font-size: 48px; color: #667eea;"></i>
                    <p style="margin-top: 15px;">Initializing WhatsApp session...</p>
                    <p style="font-size: 12px; color: #666;">This may take a few moments</p>
                </div>
            `;
        }

        // Call your backend API to create session (without auth for now)
        const response = await fetch('/api/sessions/create', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                adminSession: true
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const result = await response.json();
        
        if (result.success) {
            currentSessionId = result.data.sessionId;
            console.log('✅ Session created successfully:', currentSessionId);
            showNotification('Session created! Waiting for QR code...', 'success');
            
            // Update QR container to show waiting state
            if (qrContainer) {
                qrContainer.innerHTML = `
                    <div class="qr-waiting">
                        <i class="fas fa-qrcode" style="font-size: 48px; color: #667eea;"></i>
                        <p style="margin-top: 15px;">Generating QR Code...</p>
                        <p style="font-size: 12px; color: #666;">Session ID: ${currentSessionId}</p>
                    </div>
                `;
            }
        } else {
            throw new Error(result.message || 'Failed to create session');
        }

    } catch (error) {
        console.error('❌ Error creating session:', error);
        showNotification(`Error: ${error.message}`, 'error');
        closeQRModal();
    } finally {
        isCreatingSession = false;
    }
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
        qrContainer.innerHTML = `
            <div style="text-align: center; padding: 20px;">
                <i class="fas fa-check-circle" style="font-size: 64px; color: #48bb78;"></i>
                <h3 style="color: #48bb78; margin: 15px 0;">Bot Connected!</h3>
                <p><strong>Phone:</strong> ${data.phone || 'Connected'}</p>
                <p><strong>Session ID:</strong> ${data.uniqueId || data.sessionId}</p>
                <div style="margin-top: 20px; padding: 15px; background: #f0f9ff; border-radius: 8px; border-left: 4px solid #667eea;">
                    <strong>🎯 Test your bot:</strong><br>
                    Open WhatsApp and send yourself:<br>
                    <code style="background: #e5e7eb; padding: 2px 6px; border-radius: 4px;">!ping</code>
                </div>
                <button onclick="closeQRModal()" class="btn-primary" style="margin-top: 15px;">
                    <i class="fas fa-check"></i> Continue
                </button>
            </div>
        `;
    }

    showNotification(`Bot connected successfully! Phone: ${data.phone || 'Connected'}`, 'success');
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

function loadDashboardData() {
    updateStats();
    loadRecentActivity();
}

function updateStats() {
    const activeSessions = document.getElementById('activeSessions');
    const totalUsers = document.getElementById('totalUsers');
    const messagesProcessed = document.getElementById('messagesProcessed');

    if (activeSessions) activeSessions.textContent = sessions.filter(s => s.status === 'active').length;
    if (totalUsers) totalUsers.textContent = '1,247';
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
            <div style="text-align: center; padding: 40px; color: #666;">
                <i class="fas fa-robot" style="font-size: 48px; margin-bottom: 15px;"></i>
                <h3>No Active Sessions</h3>
                <p>Click "New Session" to create your first WhatsApp bot session.</p>
                <button onclick="createNewSession()" class="btn-primary" style="margin-top: 15px;">
                    <i class="fas fa-plus"></i> Create New Session
                </button>
            </div>
        `;
        return;
    }

    sessionsGrid.innerHTML = sessions.map(session => `
        <div class="session-card ${session.status}">
            <div class="session-header">
                <div class="session-status">
                    <span class="status-indicator ${session.status}"></span>
                    <span class="status-text">${session.status.charAt(0).toUpperCase() + session.status.slice(1)}</span>
                </div>
                <div class="session-actions">
                    <button class="action-btn" onclick="viewSession('${session.id}')" title="View Details">
                        <i class="fas fa-eye"></i>
                    </button>
                    <button class="action-btn" onclick="restartSession('${session.id}')" title="Restart">
                        <i class="fas fa-redo"></i>
                    </button>
                    <button class="action-btn danger" onclick="deleteSession('${session.id}')" title="Delete">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="session-info">
                <h4>${session.user}</h4>
                <p class="session-phone">${session.phone}</p>
                <div class="session-stats">
                    <div class="stat">
                        <span class="stat-label">Uptime</span>
                        <span class="stat-value">${session.uptime}</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Messages</span>
                        <span class="stat-value">${session.messages}</span>
                    </div>
                </div>
            </div>
        </div>
    `).join('');

    // Update session count badge
    const sessionCount = document.getElementById('sessionCount');
    if (sessionCount) {
        const activeSessions = sessions.filter(s => s.status === 'active').length;
        sessionCount.textContent = activeSessions;
        sessionCount.style.display = activeSessions > 0 ? 'flex' : 'none';
    }
}

// ==================== USER MANAGEMENT ====================

function loadUsers() {
    const usersTableBody = document.getElementById('usersTableBody');
    if (!usersTableBody) return;

    usersTableBody.innerHTML = users.map(user => `
        <tr>
            <td>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <div style="width: 32px; height: 32px; background: #667eea; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-size: 12px;">
                        ${user.name.split(' ').map(n => n[0]).join('')}
                    </div>
                    <div>
                        <div style="font-weight: 600;">${user.name}</div>
                    </div>
                </div>
            </td>
            <td>${user.phone}</td>
            <td>
                <span style="padding: 4px 8px; background: ${user.type === 'Admin' ? '#667eea' : '#e5e7eb'}; color: ${user.type === 'Admin' ? 'white' : '#374151'}; border-radius: 4px; font-size: 12px;">
                    ${user.type}
                </span>
            </td>
            <td>
                <span style="color: ${user.status === 'active' ? '#48bb78' : '#9ca3af'};">
                    ${user.status === 'active' ? 'Active' : 'Inactive'}
                </span>
            </td>
            <td>${user.lastActive}</td>
            <td>
                <button class="action-btn" style="border: none; background: none; padding: 4px;" onclick="editUser(${user.id})">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="action-btn danger" style="border: none; background: none; padding: 4px;" onclick="deleteUser(${user.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        </tr>
    `).join('');
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
    }
}

function closeBroadcastModal() {
    const modal = document.getElementById('broadcastModal');
    if (modal) {
        modal.classList.remove('active');
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
        <i class="fas fa-${type === 'success' ? 'check' : type === 'error' ? 'exclamation-triangle' : 'info-circle'}"></i>
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
    `;
    
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
    if (confirm('Are you sure you want to logout?')) {
        showNotification('Logging out...', 'info');
        setTimeout(() => {
            window.location.href = 'index.html';
        }, 1000);
    }
}

// ==================== QUICK ACTION FUNCTIONS ====================

function broadcastMessage() {
    showBroadcastModal();
}

function exportData() {
    showNotification('Data export started. You will receive an email when complete.', 'info');
}

function systemRestart() {
    if (confirm('Are you sure you want to restart the bot system? This will disconnect all active sessions.')) {
        showNotification('System restart initiated...', 'warning');
        setTimeout(() => {
            showNotification('System restart completed successfully', 'success');
            refreshData();
        }, 3000);
    }
}

// ==================== SESSION ACTION FUNCTIONS ====================

function createSession() {
    createNewSession();
}

function viewSession(id) {
    showNotification(`Viewing session: ${id}`, 'info');
    console.log('View session:', id);
}

function restartSession(id) {
    if (confirm(`Are you sure you want to restart session ${id}?`)) {
        showNotification(`Restarting session: ${id}`, 'warning');
        setTimeout(() => {
            showNotification(`Session ${id} restarted successfully`, 'success');
            loadSessions();
        }, 2000);
    }
}

function deleteSession(id) {
    if (confirm(`Are you sure you want to delete session ${id}? This action cannot be undone.`)) {
        showNotification(`Deleting session: ${id}`, 'error');
        setTimeout(() => {
            sessions = sessions.filter(session => session.id !== id);
            showNotification(`Session ${id} deleted successfully`, 'success');
            loadSessions();
        }, 1500);
    }
}

// ==================== PLACEHOLDER FUNCTIONS ====================

function addUser() {
    showNotification('Add user functionality coming soon!', 'info');
}

function editUser(userId) {
    showNotification(`Edit user ${userId} functionality coming soon!`, 'info');
}

function deleteUser(userId) {
    if (confirm('Are you sure you want to delete this user?')) {
        showNotification(`User ${userId} deleted successfully!`, 'success');
    }
}

function exportUsers() {
    showNotification('Exporting users data...', 'info');
}

function sendBroadcast() {
    const message = document.getElementById('broadcastMessage')?.value;
    const target = document.getElementById('broadcastTarget')?.value;
    
    if (!message || !message.trim()) {
        showNotification('Please enter a message', 'error');
        return;
    }

    showNotification(`Broadcast sent successfully to ${target}!`, 'success');
    closeBroadcastModal();
}

// ==================== GLOBAL FUNCTION EXPORTS ====================

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