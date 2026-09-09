export interface FlutterwavePayment {
  transaction_id: number | string;
  tx_ref: string;
  status: string;
}

interface FlutterwaveCheckoutOptions {
  public_key: string;
  tx_ref: string;
  amount: number;
  currency: string;
  payment_options: string;
  customer: {
    email: string;
    name?: string;
    phone_number?: string;
  };
  meta?: Record<string, string>;
  customizations: {
    title: string;
    description: string;
  };
  callback: (payment: FlutterwavePayment) => void;
  onclose: (incomplete: boolean) => void;
}

export interface FlutterwaveCheckoutInstance {
  close: () => void;
}

declare global {
  interface Window {
    FlutterwaveCheckout?: (
      options: FlutterwaveCheckoutOptions,
    ) => FlutterwaveCheckoutInstance;
  }
}

let checkoutScript: Promise<void> | undefined;

export const loadFlutterwaveCheckout = () => {
  if (window.FlutterwaveCheckout) return Promise.resolve();
  if (checkoutScript) return checkoutScript;

  checkoutScript = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.flutterwave.com/v3.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Unable to load secure checkout."));
    document.head.appendChild(script);
  });

  return checkoutScript;
};
