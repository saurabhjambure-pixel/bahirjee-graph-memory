/**
 * Premium status utilities
 * Handles premium status calculation accounting for test/exempt clients
 */

/**
 * Check if a user should be treated as premium
 * Accounts for:
 * 1. Direct is_premium flag on profile
 * 2. Exemption from freemium limits on their client
 * 
 * @param {Object} profile - User profile object with is_premium and client info
 * @returns {boolean} - Whether user should have premium access
 */
export function isPremiumOrExempt(profile) {
  if (!profile) return false;
  
  // Direct premium flag takes priority
  if (profile.is_premium) return true;
  
  // Check if their client is exempt from freemium (e.g., test client)
  if (profile.client?.exempt_from_freemium) return true;
  
  return false;
}

/**
 * Check if user can create a new report (bypassing freemium execution guard)
 * @param {Object} profile - User profile object
 * @returns {boolean} - Whether user can create unlimited reports
 */
export function canCreateUnlimitedReports(profile) {
  if (!profile) return false;
  
  // Premium users get unlimited reports
  if (profile.is_premium) return true;
  
  // Users in exempt clients get unlimited reports
  if (profile.client?.exempt_from_freemium) return true;
  
  return false;
}

/**
 * Get the remaining reports user can create
 * @param {Object} profile - User profile with run_count
 * @returns {number|null} - Remaining reports, or null if unlimited
 */
export function getRemainingReports(profile) {
  if (!profile) return 0;
  
  if (canCreateUnlimitedReports(profile)) {
    return null; // Unlimited
  }
  
  // Free tier: 1 report allowed
  const FreeReportLimit = 1;
  return Math.max(0, FreeReportLimit - (profile.run_count || 0));
}
