// admin.js - Complete Admin Dashboard Functionality

// Global variables
let currentSection = 'dashboard';
let sessions = [];
let users = [];

// Initialize admin dashboard
document.addEventListener('DOMContentLoaded', function() {
    console.log('Admin dashboard initializing...');
    initializeAdmin();
    loadDashboardData();
    setupEventListeners();
    startRealTimeUpdates();
    
    // Set initial active section
    switchSection('dashboard');
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

function initializeSampleData() {
    // Sample sessions data
    sessions = [
        { id: 'session-001', status: 'active', user: 'Admin Bot', phone: '+1234567890', uptime: '2h 30m', messages: 145 },
        { id: 'session-002', status: 'active', user: 'Support Bot', phone: '+1234567891', uptime: '1h 15m', messages: 67 },
        { id: 'session-003', status: 'inactive', user: 'Marketing Bot', phone: '+1234567892', uptime: '0m', messages: 0 },
        { id: 'session-004', status: 'error', user: 'Sales Bot', phone: '+1234567893', uptime: '0m', messages: 0 },
        { id: 'session-005', status: 'active', user: 'Customer Bot', phone: '+1234567894', uptime: '4h 45m', messages: 289 }
    ];

    // Sample users data
    users = [
        { id: 1, name: 'John Doe', phone: '+1234567890', type: 'Admin', status: 'active', lastActive: '2 minutes ago' },
        { id: 2, name: 'Jane Smith', phone: '+1234567891', type: 'User', status: 'active', lastActive: '5 minutes ago' },
        { id: 3, name: 'Mike Johnson', phone: '+1234567892', type: 'User', status: 'inactive', lastActive: '1 hour ago' },
        { id: 4, name: 'Sarah Wilson', phone: '+1234567893', type: 'Admin', status: 'active', lastActive: '30 minutes ago' }
    ];
}

// Navigation handling
function setupEventListeners() {
    console.log('Setting up event listeners...');
    
    // Sidebar navigation
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const section = this.getAttribute('data-section');
            console.log('Navigation clicked:', section);
            switchSection(section);
            
            // Close mobile menu if open
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

    // Settings tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const tab = this.getAttribute('data-tab');
            switchTab(tab);
        });
    });

    // Schedule message toggle
    const scheduleMessage = document.getElementById('scheduleMessage');
    if (scheduleMessage) {
        scheduleMessage.addEventListener('change', function() {
            const scheduleGroup = document.getElementById('scheduleGroup');
            if (scheduleGroup) {
                scheduleGroup.style.display = this.checked ? 'block' : 'none';
            }
        });
    }

    // Session filter and search
    const sessionFilter = document.getElementById('sessionFilter');
    if (sessionFilter) {
        sessionFilter.addEventListener('change', filterSessions);
    }

    const sessionSearch = document.getElementById('sessionSearch');
    if (sessionSearch) {
        sessionSearch.addEventListener('input', filterSessions);
    }

    // Analytics timeframe
    const analyticsTimeframe = document.getElementById('analyticsTimeframe');
    if (analyticsTimeframe) {
        analyticsTimeframe.addEventListener('change', loadAnalytics);
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

    console.log('Event listeners setup complete');
}

function switchSection(sectionName) {
    console.log('🔄 Switching to section:', sectionName);
    currentSection = sectionName;

    // Remove active class from all nav items
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });

    // Add active class to current nav item
    const currentNavLink = document.querySelector(`[data-section="${sectionName}"]`);
    if (currentNavLink) {
        currentNavLink.parentElement.classList.add('active');
        console.log('✅ Nav link activated:', currentNavLink);
    } else {
        console.error('❌ Nav link not found for section:', sectionName);
    }

    // Hide all sections
    const allSections = document.querySelectorAll('.content-section');
    console.log('📋 Found sections:', allSections.length);
    allSections.forEach(section => {
        section.classList.remove('active');
        console.log('👁️ Hiding section:', section.id);
    });

    // Show current section
    const currentSectionElement = document.getElementById(`${sectionName}-section`);
    console.log('🎯 Looking for section:', `${sectionName}-section`);
    
    if (currentSectionElement) {
        currentSectionElement.classList.add('active');
        currentSectionElement.classList.add('fade-in');
        console.log('✅ Section activated:', currentSectionElement.id);
        
        // Remove animation class after animation completes
        setTimeout(() => {
            currentSectionElement.classList.remove('fade-in');
        }, 300);
    } else {
        console.error('❌ Section element not found:', `${sectionName}-section`);
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
        pageTitle.classList.add('slide-in');
        
        setTimeout(() => {
            pageTitle.classList.remove('slide-in');
        }, 300);
    }

    // Load section-specific data
    loadSectionData(sectionName);
}

function loadSectionData(section) {
    console.log('Loading data for section:', section);
    
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
        case 'contacts':
            loadContacts();
            break;
        case 'messages':
            loadMessages();
            break;
        case 'reminders':
            loadReminders();
            break;
        case 'analytics':
            loadAnalytics();
            break;
        case 'settings':
            loadSettings();
            break;
    }
}

// Dashboard functions
function loadDashboardData() {
    updateStats();
    loadRecentActivity();
    updateSystemStatus();
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
        { icon: 'fas fa-exclamation-triangle', text: 'Session timeout: Session-1234', time: '10 minutes ago', type: 'warning' },
        { icon: 'fas fa-plug', text: 'New session created successfully', time: '15 minutes ago', type: 'success' },
        { icon: 'fas fa-bell', text: 'Meeting reminder sent', time: '20 minutes ago', type: 'info' }
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

function updateSystemStatus() {
    // This would typically make an API call to get system status
    console.log('System status updated');
}

// Session management functions
function loadSessions() {
    const sessionsGrid = document.getElementById('sessionsGrid');
    if (!sessionsGrid) return;

    sessionsGrid.innerHTML = sessions.map(session => `
        <div class="session-card ${session.status}">
            <div class="session-header">
                <div class="session-status">
                    <span class="status-indicator ${session.status}"></span>
                    <span class="status-text">${session.status.charAt(0).toUpperCase() + session.status.slice(1)}</span>
                </div>
                <div class="session-actions">
                    <button class="action-btn" onclick="viewSession('${session.id}')">
                        <i class="fas fa-eye"></i>
                    </button>
                    <button class="action-btn" onclick="restartSession('${session.id}')">
                        <i class="fas fa-redo"></i>
                    </button>
                    <button class="action-btn danger" onclick="deleteSession('${session.id}')">
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

function filterSessions() {
    const filterValue = document.getElementById('sessionFilter')?.value || 'all';
    const searchValue = document.getElementById('sessionSearch')?.value.toLowerCase() || '';
    
    let filteredSessions = sessions;
    
    // Apply status filter
    if (filterValue !== 'all') {
        filteredSessions = filteredSessions.filter(session => session.status === filterValue);
    }
    
    // Apply search filter
    if (searchValue) {
        filteredSessions = filteredSessions.filter(session => 
            session.user.toLowerCase().includes(searchValue) ||
            session.phone.toLowerCase().includes(searchValue) ||
            session.id.toLowerCase().includes(searchValue)
        );
    }
    
    // Re-render sessions
    const sessionsGrid = document.getElementById('sessionsGrid');
    if (sessionsGrid) {
        sessionsGrid.innerHTML = filteredSessions.map(session => `
            <div class="session-card ${session.status}">
                <div class="session-header">
                    <div class="session-status">
                        <span class="status-indicator ${session.status}"></span>
                        <span class="status-text">${session.status.charAt(0).toUpperCase() + session.status.slice(1)}</span>
                    </div>
                    <div class="session-actions">
                        <button class="action-btn" onclick="viewSession('${session.id}')">
                            <i class="fas fa-eye"></i>
                        </button>
                        <button class="action-btn" onclick="restartSession('${session.id}')">
                            <i class="fas fa-redo"></i>
                        </button>
                        <button class="action-btn danger" onclick="deleteSession('${session.id}')">
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
    }
}

// Add this function to admin.js
async function createAdminSession() {
    try {
        showNotification('Creating admin session...', 'info');
        
        // Use hardcoded admin user ID or get from localStorage
        const adminUserId = localStorage.getItem('adminUserId') || 'ADMIN_USER_ID_HERE';
        
        const response = await fetch('/api/admin/create-session', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('adminToken')}`
            },
            body: JSON.stringify({
                userId: adminUserId,
                isAdminSession: true // Flag to identify admin sessions
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showNotification('Admin session created! Scan QR to connect your WhatsApp', 'success');
            showQRModal();
            
            // Update QR modal title for admin
            const modalTitle = document.querySelector('#qrModal .modal-header h3');
            if (modalTitle) {
                modalTitle.textContent = '👑 Admin WhatsApp Connection';
            }
            
            generateQRCode(result.data.sessionId);
            loadSessions();
            
        } else {
            showNotification(result.message || 'Failed to create admin session', 'error');
        }
        
    } catch (error) {
        console.error('Error creating admin session:', error);
        showNotification('Error creating admin session: ' + error.message, 'error');
    }
}

// Quick action functions
async function createNewSession() {
    // First, ask admin which user to create session for
    const userId = prompt('Enter User ID to create session for:');
    
    if (!userId || !userId.trim()) {
        showNotification('Please enter a valid User ID', 'error');
        return;
    }
    
    try {
        showNotification('Creating session...', 'info');
        
        // Call admin API to create session for specific user
        const response = await fetch('/api/admin/create-session', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('adminToken')}`
            },
            body: JSON.stringify({
                userId: userId.trim()
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showNotification(`Session created for user ${userId}`, 'success');
            
            // Show QR modal with session info
            showQRModal();
            
            // Generate QR code for this session
            generateQRCode(result.data.sessionId);
            
            // Refresh sessions list
            loadSessions();
            
        } else {
            showNotification(result.message || 'Failed to create session', 'error');
        }
        
    } catch (error) {
        console.error('Error creating session:', error);
        showNotification('Error creating session: ' + error.message, 'error');
    }
}

// Better version with user selection dropdown
async function createNewSessionAdvanced() {
    try {
        // First, get list of users
        const usersResponse = await fetch('/api/admin/users', {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('adminToken')}`
            }
        });
        
        if (!usersResponse.ok) {
            throw new Error('Failed to fetch users');
        }
        
        const usersResult = await usersResponse.json();
        const users = usersResult.data.users;
        
        if (users.length === 0) {
            showNotification('No users found to create session for', 'warning');
            return;
        }
        
        // Show user selection modal
        showUserSelectionModal(users);
        
    } catch (error) {
        console.error('Error fetching users:', error);
        showNotification('Error fetching users: ' + error.message, 'error');
    }
}

// Show modal to select user
function showUserSelectionModal(users) {
    const modal = document.createElement('div');
    modal.className = 'modal active';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>Create Session for User</h3>
                <button class="modal-close" onclick="this.closest('.modal').remove()">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label for="userSelect">Select User:</label>
                    <select id="userSelect" class="form-control">
                        <option value="">-- Select User --</option>
                        ${users.map(user => `
                            <option value="${user._id}">
                                ${user.fullName || user.email} (${user.email})
                            </option>
                        `).join('')}
                    </select>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" onclick="this.closest('.modal').remove()">
                    Cancel
                </button>
                <button class="btn-primary" onclick="createSessionForSelectedUser()">
                    Create Session
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
}

// Create session for selected user
async function createSessionForSelectedUser() {
    const userSelect = document.getElementById('userSelect');
    const userId = userSelect.value;
    
    if (!userId) {
        showNotification('Please select a user', 'error');
        return;
    }
    
    // Close selection modal
    document.querySelector('.modal').remove();
    
    try {
        showNotification('Creating session...', 'info');
        
        const response = await fetch('/api/admin/create-session', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('adminToken')}`
            },
            body: JSON.stringify({ userId })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showNotification(`Session created successfully!`, 'success');
            showQRModal();
            generateQRCode(result.data.sessionId);
            loadSessions();
        } else {
            showNotification(result.message || 'Failed to create session', 'error');
        }
        
    } catch (error) {
        console.error('Error creating session:', error);
        showNotification('Error creating session: ' + error.message, 'error');
    }
}

function broadcastMessage() {
    showBroadcastModal();
}

function exportData() {
    showNotification('Data export started. You will receive an email when complete.', 'info');
}

function systemRestart() {
    if (confirm('Are you sure you want to restart the bot system? This will disconnect all active sessions.')) {
        showNotification('System restart initiated...', 'warning');
        // Simulate restart process
        setTimeout(() => {
            showNotification('System restart completed successfully', 'success');
            refreshData();
        }, 3000);
    }
}

// Modal functions
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

function showQRModal() {
    const modal = document.getElementById('qrModal');
    if (modal) {
        modal.classList.add('active');
        generateQRCode();
    }
}

function closeQRModal() {
    const modal = document.getElementById('qrModal');
    if (modal) {
        modal.classList.remove('active');
    }
}

function generateQRCode() {
    const qrContainer = document.getElementById('qrCode');
    if (!qrContainer) return;

    // Show loading state
    qrContainer.innerHTML = `
        <i class="fas fa-spinner fa-spin"></i>
        <p>Generating QR Code...</p>
    `;

    // Simulate QR code generation
    setTimeout(() => {
        qrContainer.innerHTML = `
            <div class="qr-code-image">
                <!-- In a real app, this would be a real QR code image -->
                <div style="width: 200px; height: 200px; background: #f0f0f0; display: flex; align-items: center; justify-content: center; border-radius: 8px;">
                    <div style="text-align: center;">
                        <i class="fas fa-qrcode" style="font-size: 48px; color: #667eea;"></i>
                        <p style="margin-top: 10px; font-size: 12px; color: #666;">Simulated QR Code</p>
                    </div>
                </div>
            </div>
            <p>Scan this code with WhatsApp</p>
        `;
    }, 2000);
}

function sendBroadcast() {
    const message = document.getElementById('broadcastMessage')?.value;
    const target = document.getElementById('broadcastTarget')?.value;
    const scheduled = document.getElementById('scheduleMessage')?.checked;
    const scheduleTime = document.getElementById('scheduleTime')?.value;
    
    if (!message || !message.trim()) {
        showNotification('Please enter a message', 'error');
        return;
    }

    // Simulate broadcast sending
    showNotification(`Broadcast ${scheduled ? 'scheduled' : 'sent'} successfully to ${target}!`, 'success');
    closeBroadcastModal();
}

// Settings functions
function switchTab(tabName) {
    // Update active tab button
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    
    const activeBtn = document.querySelector(`[data-tab="${tabName}"]`);
    const activeTab = document.getElementById(`${tabName}-settings`);
    
    if (activeBtn) activeBtn.classList.add('active');
    if (activeTab) activeTab.classList.add('active');
}

function saveSettings() {
    // Get settings values
    const maxSessions = document.getElementById('maxSessions')?.value;
    const commandPrefix = document.getElementById('commandPrefix')?.value;
    const autoSaveContacts = document.getElementById('autoSaveContacts')?.checked;
    
    // In a real app, you would send these to your backend
    console.log('Saving settings:', { maxSessions, commandPrefix, autoSaveContacts });
    
    showNotification('Settings saved successfully!', 'success');
}

function addAdmin() {
    showNotification('Add admin functionality coming soon!', 'info');
}

// Utility functions
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
    
    document.body.appendChild(notification);
    
    // Animate in
    setTimeout(() => notification.classList.add('show'), 100);
    
    // Auto remove after 5 seconds
    setTimeout(() => {
        if (notification.parentElement) {
            notification.remove();
        }
    }, 5000);
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
        
        // Update toggle icon
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
            updateConnectionStatus();
        }
    }, 30000);

    // Update uptime every minute
    setInterval(updateUptime, 60000);
}

function updateConnectionStatus() {
    const status = document.getElementById('connectionStatus');
    if (!status) return;

    // Simulate connection check (90% chance of being connected)
    const isConnected = Math.random() > 0.1;
    
    if (isConnected) {
        status.innerHTML = '<div class="status-indicator online"></div><span>Connected</span>';
    } else {
        status.innerHTML = '<div class="status-indicator offline"></div><span>Disconnected</span>';
        showNotification('Connection lost. Attempting to reconnect...', 'warning');
    }
}

function logout() {
    if (confirm('Are you sure you want to logout?')) {
        showNotification('Logging out...', 'info');
        setTimeout(() => {
            window.location.href = 'index.html';
        }, 1000);
    }
}

// User management functions
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

function addUser() {
    showNotification('Add user functionality coming soon!', 'info');
}

function editUser(userId) {
    showNotification(`Edit user ${userId} functionality coming soon!`, 'info');
}

function deleteUser(userId) {
    if (confirm('Are you sure you want to delete this user?')) {
        showNotification(`User ${userId} deleted successfully!`, 'success');
        // In real app, remove from array and re-render
    }
}

function exportUsers() {
    showNotification('Exporting users data...', 'info');
}

// Update the loadContacts function in admin.js
async function loadContacts() {
    const contactsGrid = document.getElementById('contactsGrid');
    if (!contactsGrid) return;
    
    try {
        showNotification('Loading contacts...', 'info');
        
        const response = await fetch('/api/admin/contacts', {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('adminToken')}`
            }
        });
        
        const result = await response.json();
        
        if (result.success) {
            const contactGroups = result.data.contacts;
            
            if (contactGroups.length === 0) {
                contactsGrid.innerHTML = `
                    <div class="empty-state">
                        <i class="fas fa-address-book" style="font-size: 48px; color: #667eea; margin-bottom: 16px;"></i>
                        <h3>No Contacts Found</h3>
                        <p>Contacts will appear here when users connect their WhatsApp sessions</p>
                    </div>
                `;
                return;
            }
            
            contactsGrid.innerHTML = contactGroups.map(group => `
                <div class="contact-group-card">
                    <div class="group-header">
                        <h3>👤 User: ${group.userInfo.email || group.userId}</h3>
                        <p>Session: ${group.sessionId}</p>
                        <span class="contact-count">${group.contacts.length} contacts</span>
                    </div>
                    <div class="contacts-list">
                        ${group.contacts.slice(0, 5).map(contact => `
                            <div class="contact-item ${contact.type}">
                                <div class="contact-avatar">
                                    ${contact.isGroup ? '👥' : '👤'}
                                </div>
                                <div class="contact-info">
                                    <h4>${contact.name}</h4>
                                    <p>${contact.phone || contact.whatsappId}</p>
                                    <span class="contact-type">${contact.type}</span>
                                    ${contact.hasMessagedBot ? '<span class="messaged-badge">✓ Messaged</span>' : ''}
                                </div>
                            </div>
                        `).join('')}
                        ${group.contacts.length > 5 ? `
                            <div class="show-more">
                                <button onclick="showAllContacts('${group.sessionId}')" class="btn-secondary">
                                    Show all ${group.contacts.length} contacts
                                </button>
                            </div>
                        ` : ''}
                    </div>
                </div>
            `).join('');
            
            showNotification(`Loaded ${result.data.total} contacts`, 'success');
            
        } else {
            throw new Error(result.message);
        }
        
    } catch (error) {
        console.error('Error loading contacts:', error);
        contactsGrid.innerHTML = `
            <div class="error-state">
                <i class="fas fa-exclamation-triangle" style="font-size: 48px; color: #f56565; margin-bottom: 16px;"></i>
                <h3>Error Loading Contacts</h3>
                <p>${error.message}</p>
                <button onclick="loadContacts()" class="btn-primary">Try Again</button>
            </div>
        `;
    }
}

function addContact() {
    showNotification('Add contact functionality coming soon!', 'info');
}

function editContact(contactId) {
    showNotification(`Edit contact ${contactId} functionality coming soon!`, 'info');
}

function deleteContact(contactId) {
    if (confirm('Are you sure you want to delete this contact?')) {
        showNotification(`Contact ${contactId} deleted successfully!`, 'success');
    }
}

function importContacts() {
    showNotification('Import contacts functionality coming soon!', 'info');
}

// Message management functions
function loadMessages() {
    const messageLogs = document.getElementById('messageLogs');
    if (!messageLogs) return;

    // Sample message logs
    const messages = [
        { id: 1, type: 'sent', content: 'Meeting reminder: Team meeting at 3 PM', target: 'All Users', time: '2 minutes ago', status: 'delivered' },
        { id: 2, type: 'received', content: 'Hello, I need help with my account', target: '+1234567890', time: '5 minutes ago', status: 'read' },
        { id: 3, type: 'sent', content: 'Weekly newsletter', target: 'Newsletter Group', time: '1 hour ago', status: 'sent' },
        { id: 4, type: 'received', content: 'Thank you for your support!', target: '+1234567891', time: '2 hours ago', status: 'read' }
    ];

    messageLogs.innerHTML = messages.map(message => `
        <div class="activity-item ${message.type === 'sent' ? 'info' : 'success'}">
            <div class="activity-icon">
                <i class="fas fa-${message.type === 'sent' ? 'paper-plane' : 'inbox'}"></i>
            </div>
            <div class="activity-content">
                <p><strong>${message.type === 'sent' ? 'To' : 'From'}:</strong> ${message.target}</p>
                <p>${message.content}</p>
                <span class="activity-time">${message.time} • ${message.status}</span>
            </div>
        </div>
    `).join('');
}

// Reminder management functions
function loadReminders() {
    const remindersList = document.getElementById('remindersList');
    if (!remindersList) return;

    // Sample reminders
    const reminders = [
        { id: 1, title: 'Team Meeting', description: 'Weekly team sync meeting', time: 'Today, 3:00 PM', recurring: 'Weekly' },
        { id: 2, title: 'Payment Reminder', description: 'Send payment reminders to clients', time: 'Tomorrow, 10:00 AM', recurring: 'Monthly' },
        { id: 3, title: 'System Backup', description: 'Perform system backup', time: 'Friday, 2:00 AM', recurring: 'Daily' }
    ];

    remindersList.innerHTML = reminders.map(reminder => `
        <div class="session-card active">
            <div class="session-header">
                <div class="session-status">
                    <span class="status-indicator active"></span>
                    <span class="status-text">${reminder.recurring}</span>
                </div>
                <div class="session-actions">
                    <button class="action-btn" onclick="editReminder(${reminder.id})">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="action-btn danger" onclick="deleteReminder(${reminder.id})">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="session-info">
                <h4>${reminder.title}</h4>
                <p>${reminder.description}</p>
                <div class="session-stats">
                    <div class="stat">
                        <span class="stat-label">Time</span>
                        <span class="stat-value">${reminder.time}</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Status</span>
                        <span class="stat-value" style="color: #48bb78;">Active</span>
                    </div>
                </div>
            </div>
        </div>
    `).join('');
}

function createReminder() {
    showNotification('Create reminder functionality coming soon!', 'info');
}

function editReminder(reminderId) {
    showNotification(`Edit reminder ${reminderId} functionality coming soon!`, 'info');
}

function deleteReminder(reminderId) {
    if (confirm('Are you sure you want to delete this reminder?')) {
        showNotification(`Reminder ${reminderId} deleted successfully!`, 'success');
    }
}

// Analytics functions
function loadAnalytics() {
    const timeframe = document.getElementById('analyticsTimeframe')?.value || 'week';
    showNotification(`Loading analytics for ${timeframe}...`, 'info');
    
    // In a real app, you would fetch analytics data based on timeframe
    console.log('Loading analytics for timeframe:', timeframe);
}

// Settings functions
function loadSettings() {
    // Load current settings (in a real app, this would come from an API)
    console.log('Loading settings...');
}

// Session action functions
function createSession() {
    showQRModal();
}

function viewSession(id) {
    showNotification(`Viewing session: ${id}`, 'info');
    console.log('View session:', id);
}

function restartSession(id) {
    if (confirm(`Are you sure you want to restart session ${id}?`)) {
        showNotification(`Restarting session: ${id}`, 'warning');
        // Simulate restart
        setTimeout(() => {
            showNotification(`Session ${id} restarted successfully`, 'success');
            loadSessions(); // Refresh the sessions list
        }, 2000);
    }
}

function deleteSession(id) {
    if (confirm(`Are you sure you want to delete session ${id}? This action cannot be undone.`)) {
        showNotification(`Deleting session: ${id}`, 'error');
        // Simulate deletion
        setTimeout(() => {
            sessions = sessions.filter(session => session.id !== id);
            showNotification(`Session ${id} deleted successfully`, 'success');
            loadSessions(); // Refresh the sessions list
        }, 1500);
    }
}

// Make functions globally available
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
window.editContact = editContact;
window.deleteContact = deleteContact;
window.importContacts = importContacts;
window.createReminder = createReminder;
window.editReminder = editReminder;
window.deleteReminder = deleteReminder;
window.saveSettings = saveSettings;
window.addAdmin = addAdmin;

// In admin.js - User-specific dashboard
const userSession = JSON.parse(localStorage.getItem('userSession'));

// Initialize user session check
function initializeUserSession() {
    const userSession = JSON.parse(localStorage.getItem('userSession'));
    
    if (!userSession) {
        window.location.href = '/index.html';
        return false;
    }
    
    // Connect to user's specific namespace
    const socket = io('/user-' + userSession.user.id);
    
    // User can only see their own sessions
    socket.on('userSessions', (sessions) => {
        // Only show this user's sessions
        renderUserSessions(sessions);
    });
    
    return true;
}

// Call the function
initializeUserSession();
// Connect to user's specific namespace
const socket = io('/user-' + userSession.user.id);

// User can only see their own sessions
socket.on('userSessions', (sessions) => {
    // Only show this user's sessions
    renderUserSessions(sessions);
});


// Add this to your admin dashboard JS file
async function loadOwnerInfo() {
    try {
        const response = await fetch('/api/admin/owner-info', {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('adminToken')}`
            }
        });
        
        const result = await response.json();
        
        if (result.success) {
            document.getElementById('ownerNumber').textContent = result.data.ownerNumber || 'Not configured';
            document.getElementById('ownerStatus').textContent = result.data.isOwnerConfigured ? '✅ Configured' : '❌ Not configured';
        }
    } catch (error) {
        console.error('Error loading owner info:', error);
    }
}

async function loadUsersExemptionStatus() {
    try {
        const response = await fetch('/api/admin/users-exemption-status', {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('adminToken')}`
            }
        });
        
        const result = await response.json();
        
        if (result.success) {
            const tbody = document.getElementById('usersExemptionTableBody');
            tbody.innerHTML = '';
            
            result.data.users.forEach(user => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${user.email}</td>
                    <td>${user.whatsappNumber || 'N/A'}</td>
                    <td>${user.exemptFromPayment ? '✅ Yes' : '❌ No'}</td>
                    <td>${user.exemptionReason || 'N/A'}</td>
                    <td>${user.exemptedAt ? new Date(user.exemptedAt).toLocaleDateString() : 'N/A'}</td>
                    <td>
                        <button onclick="exemptUserById('${user._id}', ${!user.exemptFromPayment})">
                            ${user.exemptFromPayment ? 'Remove Exemption' : 'Exempt User'}
                        </button>
                    </td>
                `;
                tbody.appendChild(row);
            });
        }
    } catch (error) {
        console.error('Error loading users exemption status:', error);
    }
}

async function exemptUser(exempt) {
    const userId = document.getElementById('exemptUserId').value;
    const reason = document.getElementById('exemptReason').value;
    
    if (!userId) {
        alert('Please enter a User ID');
        return;
    }
    
    await exemptUserById(userId, exempt, reason);
}

async function exemptUserById(userId, exempt, reason = null) {
    try {
        const response = await fetch('/api/admin/exempt-user', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('adminToken')}`
            },
            body: JSON.stringify({
                userId,
                exempt,
                reason: reason || (exempt ? 'Admin exemption' : null)
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            alert(result.message);
            loadUsersExemptionStatus(); // Refresh the table
            
            // Clear form
            document.getElementById('exemptUserId').value = '';
            document.getElementById('exemptReason').value = '';
        } else {
            alert('Error: ' + result.message);
        }
    } catch (error) {
        console.error('Error exempting user:', error);
        alert('Error exempting user');
    }
}

// Load data when page loads
document.addEventListener('DOMContentLoaded', function() {
    loadOwnerInfo();
    loadUsersExemptionStatus();
});


// Payment Exemptions Functions
function refreshExemptions() {
    console.log('🔄 Refreshing exemptions data...');
    showNotification('Refreshing exemption data...', 'info');
    
    try {
        // Reload owner info if function exists
        if (typeof loadOwnerInfo === 'function') {
            loadOwnerInfo();
        } else {
            console.warn('loadOwnerInfo function not available');
        }
        
        // Reload users exemption status if function exists
        if (typeof loadUsersExemptionStatus === 'function') {
            loadUsersExemptionStatus();
        } else {
            console.warn('loadUsersExemptionStatus function not available');
        }
        
        // Show success message
        setTimeout(() => {
            showNotification('Exemption data refreshed successfully!', 'success');
        }, 1500);
        
    } catch (error) {
        console.error('Error refreshing exemptions:', error);
        showNotification('Error refreshing exemption data', 'error');
    }
}

// Add any other missing exemption-related functions
function exemptUser(shouldExempt) {
    console.log('Exempt user function called:', shouldExempt);
    showNotification('Exemption function not fully implemented yet', 'warning');
}

// Make functions globally available
window.refreshExemptions = refreshExemptions;
window.exemptUser = exemptUser;

