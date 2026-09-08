import type { RequestHandler } from "express";

const flutterwaveBaseUrl = "https://api.flutterwave.com/v3";

type MenuOrder = {
  id: string;
  order_number: string;
  payment_method: string;
  payment_status: string;
  total_amount: number | string;
  email: string;
  first_name: string;
  last_name: string;
  phone: string;
};

type FlutterwaveTransaction = {
  id: number | string;
  tx_ref: string;
  status: string;
  amount: number | string;
  currency: string;
  meta?: Record<string, unknown>;
};

const getConfiguration = () => {
  const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
  const publicKey = process.env.VITE_FLUTTERWAVE_PUBLIC_KEY;
  const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const currency = process.env.FLUTTERWAVE_CURRENCY || "USD";

  if (
    !secretKey ||
    !publicKey ||
    !secretHash ||
    !supabaseUrl ||
    !supabaseAnonKey ||
    !supabaseServiceRoleKey
  ) {
    throw new Error("Flutterwave payment configuration is incomplete");
  }

  return {
    secretKey,
    publicKey,
    secretHash,
    supabaseUrl,
    supabaseAnonKey,
    supabaseServiceRoleKey,
    currency,
  };
};

const getAuthenticatedOrder = async (orderId: string, authorization?: string) => {
  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("Missing authenticated session");
  }

  const { supabaseUrl, supabaseAnonKey } = getConfiguration();
  const response = await fetch(
    `${supabaseUrl}/rest/v1/menu_orders?id=eq.${encodeURIComponent(orderId)}&select=*`,
    {
      headers: {
        apikey: supabaseAnonKey,
        authorization,
      },
    },
  );

  if (!response.ok) throw new Error("Unable to retrieve this order");

  const [order] = (await response.json()) as MenuOrder[];
  if (!order) throw new Error("Order not found");
  return order;
};

const getOrderAsService = async (orderId: string) => {
  const { supabaseUrl, supabaseAnonKey, supabaseServiceRoleKey } = getConfiguration();
  const response = await fetch(
    `${supabaseUrl}/rest/v1/menu_orders?id=eq.${encodeURIComponent(orderId)}&select=*`,
    {
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
      },
    },
  );

  if (!response.ok) throw new Error("Unable to retrieve payment order");

  const [order] = (await response.json()) as MenuOrder[];
  if (!order) throw new Error("Payment order not found");
  return order;
};

const updateOrderAsService = async (orderId: string, values: Record<string, unknown>) => {
  const { supabaseUrl, supabaseAnonKey, supabaseServiceRoleKey } = getConfiguration();
  const response = await fetch(
    `${supabaseUrl}/rest/v1/menu_orders?id=eq.${encodeURIComponent(orderId)}`,
    {
      method: "PATCH",
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify(values),
    },
  );

  if (!response.ok) throw new Error("Unable to update payment order");
};

const getPaymentOptions = (paymentMethod: string, currency: string) => {
  if (paymentMethod !== "mobile-money") return "card";
  if (currency !== "UGX") {
    throw new Error("Mobile Money is available only when checkout prices are configured in UGX.");
  }
  return "mobilemoneyuganda";
};

const verifyTransaction = async (transactionId: string) => {
  const { secretKey } = getConfiguration();
  const response = await fetch(
    `${flutterwaveBaseUrl}/transactions/${encodeURIComponent(transactionId)}/verify`,
    { headers: { Authorization: `Bearer ${secretKey}` } },
  );
  const payload = await response.json();

  if (!response.ok || payload.status !== "success" || !payload.data) {
    throw new Error("Payment could not be verified");
  }

  return payload.data as FlutterwaveTransaction;
};

const confirmPayment = async (
  transaction: FlutterwaveTransaction,
  transactionReference: string,
) => {
  const orderId = transaction.meta?.order_id;
  if (typeof orderId !== "string") {
    throw new Error("Payment is missing its order reference");
  }

  const [order, { currency }] = await Promise.all([
    getOrderAsService(orderId),
    Promise.resolve(getConfiguration()),
  ]);

  if (
    transaction.status !== "successful" ||
    transaction.tx_ref !== transactionReference ||
    Number(transaction.amount) !== Number(order.total_amount) ||
    transaction.currency !== currency
  ) {
    throw new Error("Payment verification data does not match the order");
  }

  if (order.payment_status === "paid") return { order, paymentStatus: "paid" as const };

  await updateOrderAsService(order.id, {
    status: "confirmed",
    payment_status: "paid",
  });

  return { order, paymentStatus: "paid" as const };
};

export const createFlutterwaveInlineSession: RequestHandler = async (req, res) => {
  try {
    const { orderId } = req.body as { orderId?: string };
    if (!orderId) return res.status(400).json({ error: "Order ID is required" });

    const order = await getAuthenticatedOrder(orderId, req.headers.authorization);
    if (order.payment_status === "paid") {
      return res.status(409).json({ error: "This order has already been paid" });
    }

    const { publicKey, currency } = getConfiguration();
    const amount = Number(order.total_amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Order total is invalid" });
    }

    const txRef = `sheraton-${order.order_number}-${crypto.randomUUID()}`;
    const paymentOptions = getPaymentOptions(order.payment_method, currency);

    return res.json({
      publicKey,
      txRef,
      orderId: order.id,
      amount,
      currency,
      paymentOptions,
      customer: {
        email: order.email,
        name: `${order.first_name} ${order.last_name}`.trim(),
        phoneNumber: order.phone,
      },
    });
  } catch (error) {
    console.error("Flutterwave Inline session error", error);
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to prepare payment",
    });
  }
};

export const verifyFlutterwavePayment: RequestHandler = async (req, res) => {
  try {
    const { transactionId, txRef } = req.body as {
      transactionId?: string | number;
      txRef?: string;
    };
    if (!transactionId || !txRef) {
      return res.status(400).json({ error: "Payment verification details are required" });
    }

    const transaction = await verifyTransaction(String(transactionId));
    const orderId = transaction.meta?.order_id;
    if (typeof orderId !== "string") {
      return res.status(400).json({ error: "Payment is missing its order reference" });
    }

    await getAuthenticatedOrder(orderId, req.headers.authorization);
    const result = await confirmPayment(transaction, txRef);

    return res.json({
      orderId: result.order.id,
      orderNumber: result.order.order_number,
      paymentStatus: result.paymentStatus,
    });
  } catch (error) {
    console.error("Flutterwave payment verification error", error);
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to verify payment",
    });
  }
};

export const handleFlutterwaveWebhook: RequestHandler = async (req, res) => {
  const signature = req.headers["verif-hash"];
  const { secretHash } = getConfiguration();

  if (!signature || signature !== secretHash) {
    return res.status(401).end();
  }

  const payload = req.body as {
    event?: string;
    data?: { id?: string | number; tx_ref?: string };
  };

  if (payload.event !== "charge.completed" || !payload.data?.id || !payload.data.tx_ref) {
    return res.status(200).end();
  }

  try {
    await confirmPayment(
      await verifyTransaction(String(payload.data.id)),
      payload.data.tx_ref,
    );
    return res.status(200).end();
  } catch (error) {
    console.error("Flutterwave webhook processing error", error);
    return res.status(500).end();
  }
};
