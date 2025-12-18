/**
 * =====================================================
 * SUBSCRIPTION PLANS (SHARED CONFIG)
 * =====================================================
 * - Used by BOTH server and worker
 * - NO Express
 * - NO database
 * - NO side effects
 * =====================================================
 */

const subscriptionPlans = {
  free: {
    name: 'Free Plan',
    maxSessions: 1,
    amount: 0,
    allowedCommands: ['ping', 'help', 'list', 'tag', 'status'],
    features: ['basic_messaging', 'limited_commands'],
    description: 'Perfect for trying out the bot',
    limits: {
      dailyMessages: 50,
      monthlyMessages: 1000,
      groupsPerSession: 5
    }
  },

  starter: {
    name: 'Starter Plan',
    maxSessions: 1,
    amount: 700,
    allowedCommands: [
      'ping',
      'help',
      'status',
      'broadcast',
      'auto_reply',
      'tag',
      'tagexcept'
    ],
    features: ['basic_messaging', 'broadcast', 'auto_reply', 'group_tagging'],
    description: 'Essential features for small businesses',
    limits: {
      dailyMessages: 500,
      monthlyMessages: 10000,
      groupsPerSession: 10
    }
  },

  professional: {
    name: 'Professional Plan',
    maxSessions: 1,
    amount: 1500,
    allowedCommands: [
      'ping',
      'help',
      'status',
      'broadcast',
      'auto_reply',
      'analytics',
      'scheduler',
      'tag',
      'tagexcept',
      'list'
    ],
    features: [
      'basic_messaging',
      'broadcast',
      'auto_reply',
      'analytics',
      'scheduling',
      'group_tagging',
      'advanced_commands'
    ],
    description: 'Advanced features for growing businesses',
    limits: {
      dailyMessages: 2000,
      monthlyMessages: 50000,
      groupsPerSession: 50
    }
  },

  business: {
    name: 'Business Plan',
    maxSessions: 1,
    amount: 2200,
    allowedCommands: [
      'ping',
      'help',
      'status',
      'broadcast',
      'auto_reply',
      'analytics',
      'scheduler',
      'custom_commands',
      'tag',
      'tagexcept',
      'list',
      'export',
      'dmall',
      'tagfew',
      'forward'
    ],
    features: [
      'basic_messaging',
      'broadcast',
      'auto_reply',
      'analytics',
      'scheduling',
      'custom_commands',
      'group_tagging',
      'advanced_commands',
      'priority_support',
      'data_export'
    ],
    description: 'Comprehensive solution for established businesses',
    limits: {
      dailyMessages: 10000,
      monthlyMessages: 250000,
      groupsPerSession: 200
    }
  },

  enterprise: {
    name: 'Enterprise Plan',
    maxSessions: -1,
    amount: 3800,
    allowedCommands: 'all',
    features: [
      'all_features',
      'unlimited_messaging',
      'dedicated_support',
      'custom_integrations',
      'white_label',
      'api_access',
      'advanced_analytics',
      'multi_user_access'
    ],
    description: 'Full-featured solution for large organizations',
    limits: {
      dailyMessages: -1,
      monthlyMessages: -1,
      groupsPerSession: -1
    }
  }
};

module.exports = subscriptionPlans;


// // Subscription tiers and their features
// const subscriptionPlans = {
//   free: {
//     name: 'Free Plan',
//     maxSessions: 1, // ✅ 1 session only
//     amount: 0, // Free
//     allowedCommands: ['ping', 'help','list','tag', 'status'],
//     features: ['basic_messaging','limited_commands'],
//     description: 'Perfect for trying out the bot',
//     limits: {
//       dailyMessages: 50,
//       monthlyMessages: 1000,
//       groupsPerSession: 5
//     }
//   },
//   starter: {
//     name: 'Starter Plan',
//     maxSessions: 1, // ✅ Changed from 5 to 1
//     amount: 700, // $7/month (in cents)
//     allowedCommands: ['ping', 'help', 'status', 'broadcast', 'auto_reply', 'tag', 'tagexcept'],
//     features: ['basic_messaging', 'broadcast', 'auto_reply', 'group_tagging'],
//     description: 'Essential features for small businesses',
//     limits: {
//       dailyMessages: 500,
//       monthlyMessages: 10000,
//       groupsPerSession: 10
//     }
//   },
//   professional: {
//     name: 'Professional Plan',
//     maxSessions: 1, // ✅ Changed from 25 to 1
//     amount: 1500, // $15/month (in cents)
//     allowedCommands: ['ping', 'help', 'status', 'broadcast', 'auto_reply', 'analytics', 'scheduler', 'tag', 'tagexcept', 'list'],
//     features: ['basic_messaging', 'broadcast', 'auto_reply', 'analytics', 'scheduling', 'group_tagging', 'advanced_commands'],
//     description: 'Advanced features for growing businesses',
//     limits: {
//       dailyMessages: 2000,
//       monthlyMessages: 50000,
//       groupsPerSession: 50
//     }
//   },
//   business: {
//     name: 'Business Plan',
//     maxSessions: 1, // ✅ Changed from 100 to 1
//     amount: 2200, // $22/month (in cents)
//     allowedCommands: ['ping', 'help', 'status', 'broadcast', 'auto_reply', 'analytics', 'scheduler', 'custom_commands', 'tag', 'tagexcept', 'list', 'export', 'dmall', 'tagfew', 'forward'],
//     features: ['basic_messaging', 'broadcast', 'auto_reply', 'analytics', 'scheduling', 'custom_commands', 'group_tagging', 'advanced_commands', 'priority_support', 'data_export'],
//     description: 'Comprehensive solution for established businesses',
//     limits: {
//       dailyMessages: 10000,
//       monthlyMessages: 250000,
//       groupsPerSession: 200
//     }
//   },
//   enterprise: {
//     name: 'Enterprise Plan',
//     maxSessions: -1, // ✅ Unlimited (unchanged)
//     amount: 3800, // $38/month (in cents)
//     allowedCommands: 'all', // All commands available
//     features: ['all_features', 'unlimited_messaging', 'dedicated_support', 'custom_integrations', 'white_label', 'api_access', 'advanced_analytics', 'multi_user_access'],
//     description: 'Full-featured solution for large organizations',
//     limits: {
//       dailyMessages: -1, // Unlimited
//       monthlyMessages: -1, // Unlimited
//       groupsPerSession: -1 // Unlimited
//     }
//   }
// };