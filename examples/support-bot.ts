/**
 * Agent handoffs — a triage agent routes to specialists, each with its own
 * scoped tool set. ShippingBot literally cannot call `processPayment`; the ACL
 * is enforced by which tools each agent was given.
 *
 *   OPENAI_API_KEY=sk-... npx tsx support-bot.ts
 */
import { tool, agent, workflow, AxlRuntime } from '@axlsdk/axl';
import { z } from 'zod';

// ── Tools (mock implementations) ──────────────────────────────────────
const getInvoice = tool({
  name: 'get_invoice',
  description: 'Look up an invoice by order id',
  input: z.object({ orderId: z.string() }),
  handler: ({ orderId }) => ({ orderId, total: 49.99, status: 'unpaid' }),
});

const processPayment = tool({
  name: 'process_payment',
  description: 'Charge the customer for an unpaid invoice',
  input: z.object({ orderId: z.string(), amount: z.number() }),
  handler: ({ orderId, amount }) => ({ orderId, charged: amount, status: 'paid' }),
});

const trackPackage = tool({
  name: 'track_package',
  description: 'Get the current delivery status for an order',
  input: z.object({ orderId: z.string() }),
  handler: ({ orderId }) => ({ orderId, status: 'in_transit', eta: '2 days' }),
});

// ── Specialists — each only sees its own tools ────────────────────────
const billingBot = agent({
  name: 'BillingBot',
  model: 'openai-responses:gpt-5.5',
  system: 'You handle billing and payment questions.',
  tools: [getInvoice, processPayment],
});

const shippingBot = agent({
  name: 'ShippingBot',
  model: 'openai-responses:gpt-5.5',
  system: 'You handle shipping, delivery, and tracking questions.',
  tools: [trackPackage],
});

// ── Triage — a cheap model whose only job is to route ─────────────────
const triageBot = agent({
  name: 'TriageBot',
  model: 'openai-responses:gpt-5-mini',
  system: `Route the customer to the right specialist:
- BillingBot: billing, payments, invoices, credits
- ShippingBot: shipping, delivery, tracking, addresses`,
  handoffs: [{ agent: billingBot }, { agent: shippingBot }],
});

const customerSupport = workflow({
  name: 'customer-support',
  input: z.object({ message: z.string() }),
  handler: async (ctx) => ctx.ask(triageBot, ctx.input.message),
});

const runtime = new AxlRuntime();
runtime.register(customerSupport);

const reply = await runtime.execute('customer-support', {
  message: 'Where is my order ORD-1234? It was supposed to arrive yesterday.',
});
console.log(reply);

await runtime.shutdown();
