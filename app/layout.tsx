import type { Metadata } from 'next'
import { IBM_Plex_Mono } from 'next/font/google'
import './globals.css'
import Nav from './components/layout/Nav';
import Footer from './components/layout/Footer';
import StoreProvider from './StoreProvider';

import styles from './layout.module.css'

const inter = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400'] })

export const metadata: Metadata = {
  title: 'Josh Martin\'s Website',
  description: 'Freelancer Josh Martin\'s website',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <StoreProvider>
      <html lang="en">
        <body className={inter.className}>
          <div className={styles.bodyContent}>
            <div className={styles.innerBodyContent}>
              <Nav />
              {children}
            </div>
            <Footer />
          </div>
        </body>
      </html>
    </StoreProvider>
  );
}
