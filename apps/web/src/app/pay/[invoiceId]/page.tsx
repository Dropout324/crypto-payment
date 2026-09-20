import { apiRequest, ApiError } from '@/lib/api';
import type { PublicInvoiceResponse } from '@/lib/types';
import { PaymentStatus } from '@/components/PaymentStatus';

export default async function PayInvoicePage({ params }: { params: Promise<{ invoiceId: string }> }) {
  const { invoiceId } = await params;

  let invoice: PublicInvoiceResponse;
  try {
    invoice = await apiRequest<PublicInvoiceResponse>(`/v1/public/invoices/${invoiceId}`);
  } catch (err) {
    const message = err instanceof ApiError && err.status === 404 ? "This invoice doesn't exist." : 'Something went wrong loading this invoice.';
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
        <h1 className="text-lg font-semibold">Payment page unavailable</h1>
        <p className="max-w-sm text-sm text-zinc-400">{message}</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4">
      <PaymentStatus invoiceId={invoiceId} initial={invoice} />
    </main>
  );
}
