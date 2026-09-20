import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Crypto Payment Gateway',
  description: 'Merchant and admin dashboard for the crypto payment gateway.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
