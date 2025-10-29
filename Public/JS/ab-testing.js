class ABTesting {
    constructor() {
        this.userId = this.getUserId();
        this.tests = {};
        this.init();
    }

    getUserId() {
        let userId = localStorage.getItem('ab_user_id');
        if (!userId) {
            userId = 'user_' + Math.random().toString(36).substr(2, 9);
            localStorage.setItem('ab_user_id', userId);
        }
        return userId;
    }

    async init() {
        try {
            const response = await fetch('/api/ab-tests/active');
            const activeTests = await response.json();
            
            for (const test of activeTests) {
                this.assignUserToVariant(test);
            }
        } catch (error) {
            console.error('AB testing initialization error:', error);
        }
    }

    assignUserToVariant(test) {
        const existingAssignment = localStorage.getItem(`ab_${test.name}`);
        
        if (existingAssignment) {
            this.tests[test.name] = existingAssignment;
            return existingAssignment;
        }

        // Hash user ID to ensure consistent assignment
        const hash = this.hashCode(this.userId + test.name);
        const bucket = Math.abs(hash) % 100;
        
        let cumulativeWeight = 0;
        let assignedVariant = test.variants[0].name; // default
        
        for (const variant of test.variants) {
            cumulativeWeight += variant.weight;
            if (bucket < cumulativeWeight) {
                assignedVariant = variant.name;
                break;
            }
        }

        this.tests[test.name] = assignedVariant;
        localStorage.setItem(`ab_${test.name}`, assignedVariant);
        
        // Track assignment
        this.trackEvent('ab_test_assigned', {
            testName: test.name,
            variant: assignedVariant,
            userId: this.userId
        });

        return assignedVariant;
    }

    getVariant(testName) {
        return this.tests[testName] || 'control';
    }

    hashCode(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return hash;
    }

    trackEvent(eventName, properties = {}) {
        fetch('/api/analytics/track', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                event: eventName,
                properties: {
                    ...properties,
                    userId: this.userId,
                    timestamp: new Date().toISOString(),
                    url: window.location.href,
                    userAgent: navigator.userAgent
                }
            })
        }).catch(error => console.error('Tracking error:', error));
    }

    trackConversion(testName, conversionType = 'signup') {
        this.trackEvent('conversion', {
            testName: testName,
            variant: this.getVariant(testName),
            conversionType: conversionType
        });
    }
}

// Initialize AB testing
const abTesting = new ABTesting();

// Pricing page A/B tests
function initPricingTests() {
    // Test 1: Pricing display format
    const pricingDisplayTest = abTesting.getVariant('pricing_display');
    
    if (pricingDisplayTest === 'annual_first') {
        // Show annual pricing by default
        document.getElementById('billingToggle').checked = true;
        document.getElementById('billingToggle').dispatchEvent(new Event('change'));
    }

    // Test 2: CTA button text
    const ctaButtonTest = abTesting.getVariant('cta_button_text');
    const ctaButtons = document.querySelectorAll('.plan-button');
    
    if (ctaButtonTest === 'urgency') {
        ctaButtons.forEach(button => {
            if (button.textContent.includes('Choose')) {
                button.innerHTML = button.innerHTML.replace('Choose', 'Get Started Now');
            }
        });
    } else if (ctaButtonTest === 'benefit') {
        ctaButtons.forEach(button => {
            if (button.textContent.includes('Choose Basic')) {
                button.innerHTML = '<i class="fas fa-rocket"></i> Start Growing';
            } else if (button.textContent.includes('Choose Premium')) {
                button.innerHTML = '<i class="fas fa-crown"></i> Go Premium';
            }
        });
    }

    // Test 3: Social proof placement
    const socialProofTest = abTesting.getVariant('social_proof_placement');
    
    if (socialProofTest === 'top') {
        const socialProofSection = document.querySelector('.social-proof-section');
        const pricingSection = document.querySelector('.pricing-section');
        if (socialProofSection && pricingSection) {
            pricingSection.parentNode.insertBefore(socialProofSection, pricingSection);
        }
    }

    // Test 4: Discount messaging
    const discountTest = abTesting.getVariant('discount_messaging');
    
    if (discountTest === 'limited_time') {
        const discountBadges = document.querySelectorAll('.discount-badge');
        discountBadges.forEach(badge => {
            badge.textContent = 'Limited Time: Save 20%';
            badge.style.animation = 'pulse 2s infinite';
        });
    }
}

// Track pricing page interactions
function trackPricingInteractions() {
    // Track plan selections
    document.addEventListener('click', function(e) {
        if (e.target.classList.contains('plan-button')) {
            const planType = e.target.closest('.pricing-card').querySelector('h3').textContent.toLowerCase();
            
            abTesting.trackEvent('plan_selected', {
                planType: planType,
                testVariants: abTesting.tests
            });
        }
    });

    // Track billing toggle
    document.getElementById('billingToggle')?.addEventListener('change', function() {
        abTesting.trackEvent('billing_toggle_changed', {
            isYearly: this.checked,
            testVariants: abTesting.tests
        });
    });

    // Track scroll depth
    let maxScrollDepth = 0;
    window.addEventListener('scroll', function() {
        const scrollDepth = Math.round((window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100);
        if (scrollDepth > maxScrollDepth) {
            maxScrollDepth = scrollDepth;
            if (maxScrollDepth % 25 === 0) { // Track at 25%, 50%, 75%, 100%
                abTesting.trackEvent('scroll_depth', {
                    depth: maxScrollDepth,
                    testVariants: abTesting.tests
                });
            }
        }
    });
}

// Initialize tests when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    if (window.location.pathname.includes('pricing')) {
        initPricingTests();
        trackPricingInteractions();
    }
});s