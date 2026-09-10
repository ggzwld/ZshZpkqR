import type { Request, RequestHandler } from "express";

const flutterwaveBaseUrl = "https://api.flutterwave.com/v3";
const flutterwaveReturnPath = "/checkout/flutterwave-return";

const getFlutterwaveReturnUrl = (req: Request) => {
  const configuredReturnUrl = process.env.FLUTTERWAVE_RETURN_URL;
  if (configuredReturnUrl) return configuredReturnUrl;

  if (process.env.NODE_ENV !== "production") {
    return process.env.FLUTTERWAVE_LOCAL_RETURN_URL || `${req.protocol}://${req.get("host")}${flutterwaveReturnPath}`;
  }

  throw new Error("Flutterwave return URL is not configured");
};

type MenuOrder = {
  id: string;
  order_number: string;
  payment_method: string;
  payment_status: string;
  currency?: string | null;
  payment_reference?: string | null;
  flutterwave_transaction_id?: string | null;
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
  const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const defaultCurrency = process.env.FLUTTERWAVE_CURRENCY || "USD";

  if (
    !secretKey ||
    !secretHash ||
    !supabaseUrl ||
    !supabaseAnonKey ||
    !supabaseServiceRoleKey
  ) {
    throw new Error("Flutterwave payment configuration is incomplete");
  }

  return {
    secretKey,
    secretHash,
    supabaseUrl,
    supabaseAnonKey,
    supabaseServiceRoleKey,
    defaultCurrency,
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

const getOrderByPaymentReference = async (paymentReference: string) => {
  const { supabaseUrl, supabaseAnonKey, supabaseServiceRoleKey } = getConfiguration();
  const response = await fetch(
    `${supabaseUrl}/rest/v1/menu_orders?payment_reference=eq.${encodeURIComponent(paymentReference)}&select=*`,
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
  order: MenuOrder,
) => {
  const metadataOrderId = transaction.meta?.order_id;
  if (metadataOrderId !== order.id) {
    throw new Error("Payment metadata does not match the order");
  }

  const { defaultCurrency } = getConfiguration();
  const currency = String(order.currency || defaultCurrency).toUpperCase();

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
    payment_reference: transactionReference,
    flutterwave_transaction_id: String(transaction.id),
  });

  return { order, paymentStatus: "paid" as const };
};

export const createFlutterwaveHostedSession: RequestHandler = async (req, res) => {
  try {
    const { orderId } = req.body as { orderId?: string };
    if (!orderId) return res.status(400).json({ error: "Order ID is required" });

    const order = await getAuthenticatedOrder(orderId, req.headers.authorization);
    if (order.payment_status === "paid") {
      return res.status(409).json({ error: "This order has already been paid" });
    }

    const { defaultCurrency, secretKey } = getConfiguration();
    const currency = String(order.currency || defaultCurrency).toUpperCase();
    const amount = Number(order.total_amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Order total is invalid" });
    }

    const txRef = `sheraton-${order.order_number}-${crypto.randomUUID()}`;
    const paymentOptions = getPaymentOptions(order.payment_method, currency);
    const returnUrl = getFlutterwaveReturnUrl(req);
    const response = await fetch(`${flutterwaveBaseUrl}/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tx_ref: txRef,
        amount,
        currency,
        payment_options: paymentOptions,
        redirect_url: returnUrl,
        customer: {
          email: order.email,
          name: `${order.first_name} ${order.last_name}`.trim(),
          phonenumber: order.phone,
        },
        meta: { order_id: order.id },
        customizations: {
          title: "Sheraton Special",
          description: `Order ${order.order_number}`,
        },
      }),
    });
    const payload = (await response.json()) as {
      status?: string;
      data?: { link?: string };
    };
    if (!response.ok || payload.status !== "success" || !payload.data?.link) {
      throw new Error("Unable to create secure payment page");
    }

    await updateOrderAsService(order.id, {
      payment_reference: txRef,
      payment_status: "pending",
    });

    return res.json({
      paymentUrl: payload.data.link,
      txRef,
      orderId: order.id,
    });
  } catch (error) {
    console.error("Flutterwave hosted session error", error);
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

    const order = await getOrderByPaymentReference(txRef);
    await getAuthenticatedOrder(order.id, req.headers.authorization);
    const transaction = await verifyTransaction(String(transactionId));
    const result = await confirmPayment(transaction, txRef, order);

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
    const order = await getOrderByPaymentReference(payload.data.tx_ref);
    await confirmPayment(
      await verifyTransaction(String(payload.data.id)),
      payload.data.tx_ref,
      order,
    );
    return res.status(200).end();
  } catch (error) {
    console.error("Flutterwave webhook processing error", error);
    return res.status(500).end();
  }
};
