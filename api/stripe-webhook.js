import { Stripe } from 'stripe';
import {
  getFronteggToken,
  getUserByEmail,
  createFronteggAccount,
  createFronteggUser,
  createEntitlement,
} from '../_lib/frontegg';

// Initialize Stripe with your API key (secret key, not webhook secret)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// --- IMPORTANT ---
// 1. This maps your Stripe Price ID to your Frontegg Feature ID.
// 2. You MUST update this with your actual IDs.
//
// Example:
// 'price_1LqXyZJ...': 'my-frontegg-premium-feature-id'
//
const PLAN_MAP = {
  'price_YOUR_STRIPE_PRICE_ID_1': 'frontegg-feature-id-for-plan-1',
  'price_YOUR_STRIPE_PRICE_ID_2': 'frontegg-feature-id-for-plan-2',
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
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 2. HANDLE THE 'checkout.session.completed' EVENT
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // --- Get data from Stripe ---
    const email = session.customer_details.email;
    const name = session.customer_details.name;
    const stripePriceId = session.line_items.data[0].price.id;

    // We need the subscription object to get the expiry date
    const subscription = await stripe.subscriptions.retrieve(session.subscription);
    const expiryTimestamp = subscription.current_period_end;
    const validUntil = new Date(expiryTimestamp * 1000).toISOString();

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
      await createEntitlement(tenantId, fronteggFeatureId, validUntil, token);
      console.log(`Successfully created entitlement for tenantId: ${tenantId}`);

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