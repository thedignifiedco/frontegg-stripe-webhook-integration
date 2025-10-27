import { Stripe } from 'stripe';
import {
  getFronteggToken,
  getUserByEmail,
  createFronteggAccount,
  createFronteggUser,
  createEntitlement,
} from '../_lib/frontegg.js';

// Initialize Stripe with your API key (secret key, not webhook secret)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// --- IMPORTANT ---
// 1. This maps your Stripe Price ID to your Frontegg Feature ID.
// 2. You MUST update this with your actual IDs.
// 3. This webhook handles 'subscription_schedule.created' events.
//
// Example:
// 'price_1SMf0eS4gem0F368v4m5Ty7k': 'my-frontegg-premium-feature-id'
//
const PLAN_MAP = {
  'price_1SMf0eS4gem0F368v4m5Ty7k': 'f5fec7df-c09f-40c7-a68e-6905f7ec9574'
};
// -----------------

// Helper function to buffer the raw request body
// This is required by Stripe to verify the signature
async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Tell Vercel to disable the default body parser
// We need the raw body for Stripe's verification
export const config = {
  api: {
    bodyParser: false,
  },
};

// The main webhook handler
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'];
  let event;

  // 1. VERIFY THE STRIPE EVENT
  try {
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.warn(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send('Webhook Error: Signature verification failed');
  }

  // 2. HANDLE THE 'subscription_schedule.created' EVENT
  if (event.type === 'subscription_schedule.created') {
    const schedule = event.data.object;

    // --- Get data from Stripe ---
    // Retrieve customer information using customer ID
    const customer = await stripe.customers.retrieve(schedule.customer);
    const email = customer.email;
    const name = customer.name;
    
    // Extract price ID from the first phase of the schedule
    if (!schedule.phases || schedule.phases.length === 0) {
      console.error('No phases found in subscription schedule');
      return res.status(200).json({ received: true, error: 'No phases found' });
    }
    
    const firstPhase = schedule.phases[0];
    if (!firstPhase.items || firstPhase.items.length === 0) {
      console.error('No items found in schedule phase');
      return res.status(200).json({ received: true, error: 'No items found in phase' });
    }
    
    const stripePriceId = firstPhase.items[0].price;

    // Get the expiry date from the subscription schedule
    // Priority: cancel_at > canceled_at > current_phase.end_date
    let expiryTimestamp = schedule.current_period_end;
    
    if (!expiryTimestamp) {
      console.error('No expiration timestamp found in subscription schedule');
      return res.status(200).json({ received: true, error: 'No expiration date found' });
    }
    
    const validUntil = new Date(expiryTimestamp * 1000).toISOString();
    console.log(`Using expiration date: ${validUntil} (from ${schedule.cancel_at ? 'cancel_at' : schedule.canceled_at ? 'canceled_at' : 'current_phase.end_date'})`);

    // --- Map Stripe Price ID to Frontegg Feature ID ---
    const fronteggFeatureId = PLAN_MAP[stripePriceId];

    if (!fronteggFeatureId) {
      console.error(`No Frontegg feature ID found for Stripe price ID: ${stripePriceId}`);
      // Return 200 to Stripe so it doesn't retry, but log the error
      return res.status(200).json({ received: true, error: 'Internal mapping error' });
    }

    if (!email) {
      console.error('No email found in Stripe session.');
      return res.status(200).json({ received: true, error: 'No email provided' });
    }

    // --- START FRONTEGG FLOW ---
    try {
      // Authenticate with Frontegg
      const token = await getFronteggToken();

      let userId;
      let tenantId;

      // (1) Look up user in Frontegg
      try {
        const existingUser = await getUserByEmail(email, token);
        console.log(`User ${email} found.`);
        // (2b) User exists
        userId = existingUser.id;
        tenantId = existingUser.tenantId;
      } catch (error) {
        // (2a) User does not exist (HTTP 404)
        if (error.response && error.response.status === 404) {
          console.log(`User ${email} not found, creating new account...`);

          // Create Account
          const newAccount = await createFronteggAccount(email, token);
          tenantId = newAccount.tenantId;
          console.log(`Created account with tenantId: ${tenantId}`);

          // Create User
          const newUser = await createFronteggUser(email, name, tenantId, token);
          userId = newUser.id;
          console.log(`Created user with userId: ${userId}`);
        } else {
          // Other error during lookup
          throw error;
        }
      }

      // (3) Update/Create the entitlement (subscription)
      await createEntitlement(tenantId, userId, fronteggFeatureId, validUntil, token);
      console.log(`Successfully created entitlement for tenantId: ${tenantId}, userId: ${userId}`);

      // --- END FRONTEGG FLOW ---
    } catch (error) {
      // If ANY Frontegg step fails, log it and return 500
      // Stripe will retry sending the webhook
      console.error('--- FRONTEGG SYNC FAILED ---');
      console.error(error);
      console.error('-----------------------------');
      return res.status(500).json({ error: 'Failed to sync with Frontegg' });
    }
  }

  // Acknowledge receipt to Stripe
  res.status(200).json({ received: true });
}