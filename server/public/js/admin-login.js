// Admin Login JavaScript
document.addEventListener('DOMContentLoaded', function() {
    console.log('🔐 Admin login page loaded');
    
    // Get DOM elements
    const form = document.getElementById('adminLoginForm');
    const emailInput = document.getElementById('adminEmail');
    const passwordInput = document.getElementById('adminPassword');
    const togglePassword = document.getElementById('togglePassword');
    const submitBtn = document.getElementById('adminLoginBtn');
    const btnText = document.querySelector('.btn-text');
    const btnLoader = document.getElementById('btnLoader');
    const rememberMe = document.getElementById('rememberMe');
    const loadingOverlay = document.getElementById('loadingOverlay');

    // Initialize
    init();

    function init() {
        setupEventListeners();
        checkExistingAuth();
        setupPasswordToggle();
        setupFormValidation();
        
        // Focus on email input
        if (emailInput) {
            emailInput.focus();
        }
    }

    function setupEventListeners() {
        // Form submission
        if (form) {
            form.addEventListener('submit', handleFormSubmit);
        }

        // Real-time validation
        if (emailInput) {
            emailInput.addEventListener('blur', () => validateField('email'));
            emailInput.addEventListener('input', () => clearError('emailError'));
        }

        if (passwordInput) {
            passwordInput.addEventListener('blur', () => validateField('password'));
            passwordInput.addEventListener('input', () => clearError('passwordError'));
        }

        // Enter key handling
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !submitBtn.disabled) {
                e.preventDefault();
                handleFormSubmit(e);
            }
        });

        // Notification close
        const notificationClose = document.querySelector('.notification-close');
        if (notificationClose) {
            notificationClose.addEventListener('click', hideNotification);
        }
    }

    function setupPasswordToggle() {
        if (togglePassword && passwordInput) {
            togglePassword.addEventListener('click', function() {
                const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
                passwordInput.setAttribute('type', type);
                
                const icon = this.querySelector('i');
                if (icon) {
                    icon.classList.toggle('fa-eye');
                    icon.classList.toggle('fa-eye-slash');
                }
            });
        }
    }

    function setupFormValidation() {
        // Add input event listeners for real-time feedback
        const inputs = form.querySelectorAll('input[required]');
        inputs.forEach(input => {
            input.addEventListener('invalid', function(e) {
                e.preventDefault();
                validateField(this.name);
            });
        });
    }

    function checkExistingAuth() {
        // Check if admin is already logged in
        const adminToken = getAdminToken();
        if (adminToken) {
            console.log('🔍 Existing admin token found, verifying...');
            verifyExistingToken(adminToken);
        }
    }

    async function verifyExistingToken(token) {
        try {
            showLoadingOverlay(true);
            
            const response = await fetch('https://whatsappbot-u5yq.onrender.com/api/auth/admin/verify-token', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            if (response.ok) {
                const data = await response.json();
                if (data.success) {
                    console.log('✅ Token valid, redirecting to admin dashboard');
                    showNotification('Already authenticated. Redirecting...', 'success');
                    setTimeout(() => {
                        window.location.href = '/admin.html';
                    }, 1000);
                    return;
                }
            }
            
            // Token invalid, clear it
            clearAdminToken();
            showLoadingOverlay(false);
            
        } catch (error) {
            console.error('❌ Token verification error:', error);
            clearAdminToken();
            showLoadingOverlay(false);
        }
    }

    async function handleFormSubmit(e) {
        e.preventDefault();
        
        if (!validateForm()) {
            return;
        }

        await submitLogin();
    }

    function validateForm() {
        let isValid = true;
        
        // Validate email
        if (!validateField('email')) {
            isValid = false;
        }
        
        // Validate password
        if (!validateField('password')) {
            isValid = false;
        }
        
        return isValid;
    }

    function validateField(fieldName) {
        const field = document.querySelector(`[name="${fieldName}"]`);
        const errorElement = document.getElementById(`${fieldName}Error`);
        
        if (!field || !errorElement) return true;
        
        let isValid = true;
        let errorMessage = '';
        
        switch (fieldName) {
            case 'email':
                const email = field.value.trim();
                if (!email) {
                    errorMessage = 'Admin email is required';
                    isValid = false;
                } else if (!isValidEmail(email)) {
                    errorMessage = 'Please enter a valid email address';
                    isValid = false;
                }
                break;
                
            case 'password':
                const password = field.value;
                if (!password) {
                    errorMessage = 'Password is required';
                    isValid = false;
                } else if (password.length < 1) {
                    errorMessage = 'Password cannot be empty';
                    isValid = false;
                }
                break;
        }
        
        if (!isValid) {
            showError(errorElement, errorMessage);
        } else {
            clearError(`${fieldName}Error`);
        }
        
        return isValid;
    }

    function isValidEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    function showError(errorElement, message) {
        if (typeof errorElement === 'string') {
            errorElement = document.getElementById(errorElement);
        }
        
        if (errorElement) {
            errorElement.textContent = message;
            errorElement.classList.add('show');
        }
    }

    function clearError(errorId) {
        const errorElement = document.getElementById(errorId);
        if (errorElement) {
            errorElement.classList.remove('show');
            errorElement.textContent = '';
        }
    }

    async function submitLogin() {
        if (!submitBtn || !btnText || !btnLoader) return;
        
        // Disable form
        setLoadingState(true);
        
        try {
            const formData = new FormData(form);
            const loginData = {
                email: formData.get('email').trim(),
                password: formData.get('password'),
                isAdmin: true // Flag to indicate admin login
            };
            
            console.log('🔐 Attempting admin login for:', loginData.email);
            
            const response = await fetch('https://whatsappbot-u5yq.onrender.com/api/auth/admin-login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(loginData)
            });

            const data = await response.json();
            
            if (data.success) {
                console.log('✅ Admin login successful');
                
                // Store admin token
                storeAdminToken(data.data.token, data.data.user, rememberMe.checked);
                
                // Show success message
                showNotification('Admin login successful! Redirecting to dashboard...', 'success');
                
                // Redirect after short delay
                setTimeout(() => {
                    window.location.href = '/admin.html';
                }, 1500);
                
            } else {
                console.error('❌ Admin login failed:', data.message);
                showNotification(data.message || 'Invalid admin credentials. Please try again.', 'error');
                
                // Focus back to email if it was the issue
                if (data.message && data.message.toLowerCase().includes('email')) {
                    emailInput.focus();
                } else {
                    passwordInput.focus();
                    passwordInput.select();
                }
            }
            
        } catch (error) {
            console.error('❌ Admin login error:', error);
            showNotification('Network error. Please check your connection and try again.', 'error');
        } finally {
            setLoadingState(false);
        }
    }

    function setLoadingState(loading) {
        if (!submitBtn || !btnText || !btnLoader) return;
        
        submitBtn.disabled = loading;
        
        if (loading) {
            btnText.style.opacity = '0';
            btnLoader.style.display = 'block';
        } else {
            btnText.style.opacity = '1';
            btnLoader.style.display = 'none';
        }
    }

    function showLoadingOverlay(show) {
        if (loadingOverlay) {
            loadingOverlay.style.display = show ? 'flex' : 'none';
        }
    }

    function storeAdminToken(token, user, remember) {
        const adminSession = {
            token: token,
            user: user,
            loginTime: new Date().toISOString(),
            isAdmin: true
        };
        
        if (remember) {
            // Store in localStorage for persistence
            localStorage.setItem('adminSession', JSON.stringify(adminSession));
            localStorage.setItem('adminToken', token);
            localStorage.setItem('authToken', token); // For compatibility
        } else {
            // Store in sessionStorage (cleared when browser closes)
            sessionStorage.setItem('adminSession', JSON.stringify(adminSession));
            sessionStorage.setItem('adminToken', token);
            sessionStorage.setItem('authToken', token); // For compatibility
        }
        
        console.log('💾 Admin session stored');
    }

    function getAdminToken() {
        return localStorage.getItem('adminToken') || 
               sessionStorage.getItem('adminToken') ||
               localStorage.getItem('authToken') ||
               sessionStorage.getItem('authToken');
    }

    function clearAdminToken() {
        localStorage.removeItem('adminSession');
        localStorage.removeItem('adminToken');
        localStorage.removeItem('authToken');
        sessionStorage.removeItem('adminSession');
        sessionStorage.removeItem('adminToken');
        sessionStorage.removeItem('authToken');
        
        console.log('🗑️ Admin tokens cleared');
    }

    function showNotification(message, type = 'success') {
        const notification = document.getElementById('notification');
        const messageElement = document.querySelector('.notification-message');
        const iconElement = document.querySelector('.notification-icon');
        
        if (!notification || !messageElement || !iconElement) return;
        
        // Set message
        messageElement.textContent = message;
        
        // Set icon and style based on type
        notification.className = `notification ${type}`;
        
        if (type === 'success') {
            iconElement.className = 'notification-icon fas fa-check-circle';
        } else if (type === 'error') {
            iconElement.className = 'notification-icon fas fa-exclamation-circle';
        } else {
            iconElement.className = 'notification-icon fas fa-info-circle';
        }
        
        // Show notification
        notification.style.display = 'flex';
        
        // Auto hide after 5 seconds
        setTimeout(() => {
            hideNotification();
        }, 5000);
    }

    function hideNotification() {
        const notification = document.getElementById('notification');
        if (notification) {
            notification.style.display = 'none';
        }
    }

    // Expose some functions globally for debugging
    window.adminLogin = {
        clearTokens: clearAdminToken,
        getToken: getAdminToken,
        showNotification: showNotification
    };
});