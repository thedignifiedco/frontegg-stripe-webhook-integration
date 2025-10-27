import axios from 'axios';

// Get base URL from environment variables
const FRONTEGG_BASE_URL = process.env.FRONTEGG_BASE_URL || 'https://api.frontegg.com';
const FRONTEGG_CLIENT_ID = process.env.FRONTEGG_CLIENT_ID;
const FRONTEGG_API_KEY = process.env.FRONTEGG_API_KEY;

// Create an Axios instance for Frontegg API
const fronteggApi = axios.create({
  baseURL: FRONTEGG_BASE_URL,
});

/**
 * Gets a Frontegg Vendor Token
 */
export async function getFronteggToken() {
  try {
    const { data } = await axios.post(`${FRONTEGG_BASE_URL}/auth/vendor`, {
      clientId: FRONTEGG_CLIENT_ID,
      secret: FRONTEGG_API_KEY,
    });
    return data.token;
  } catch (error) {
    console.error('Error getting Frontegg token:', error.response?.data || error.message);
    throw new Error('Could not authenticate with Frontegg');
  }
}

/**
 * (1) Get user by email
 */
export async function getUserByEmail(email, token) {
  try {
    const { data } = await fronteggApi.get(`/identity/v1/users/email/${email}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // User found
    return data;
  } catch (error) {
    // Rethrow 404s to be handled by the webhook
    if (error.response && error.response.status === 404) {
      throw error;
    }
    // Log other errors
    console.error('Error looking up user:', error.response?.data || error.message);
    throw new Error('Error looking up user');
  }
}

/**
 * (2a-1) Create a new account (tenant)
 */
export async function createFronteggAccount(email, token) {
  try {
    const { data } = await fronteggApi.post(
      '/tenants/v1',
      {
        name: `${email}'s Account`, // Or use a company name if you have it
        email: email,
      },
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    return data; // Returns the new account object, including tenantId
  } catch (error) {
    console.error('Error creating Frontegg account:', error.response?.data || error.message);
    throw new Error('Error creating Frontegg account');
  }
}

/**
 * (2a-2) Create a new user in that account
 */
export async function createFronteggUser(email, name, tenantId, token) {
  try {
    const { data } = await fronteggApi.post(
      '/identity/v1/users',
      {
        email: email,
        name: name || 'New User', // Use name from Stripe if available
        tenantId: tenantId,
      },
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    return data; // Returns the new user object
  } catch (error) {
    console.error('Error creating Frontegg user:', error.response?.data || error.message);
    throw new Error('Error creating Frontegg user');
  }
}

/**
 * (3) Create an entitlement (assign subscription)
 */
export async function createEntitlement(tenantId, featureId, validUntil, token) {
  try {
    const { data } = await fronteggApi.post(
      '/entitlements/v2',
      {
        tenantId: tenantId,
        featureId: featureId, // The Frontegg feature/plan ID
        validUntil: validUntil, // ISO 8601 string
      },
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    return data;
  } catch (error) {
    console.error('Error creating entitlement:', error.response?.data || error.message);
    throw new Error('Error creating entitlement');
  }
}