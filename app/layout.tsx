import type { Metadata } from 'next'
import { IBM_Plex_Mono } from 'next/font/google'
import './globals.css'
import Nav from './components/layout/Nav';
import Footer from './components/layout/Footer';
import { GoogleAnalytics } from '@next/third-parties/google'
import PlausibleProvider from 'next-plausible'

import styles from './layout.module.css'

import "@fortawesome/fontawesome-svg-core/styles.css";
import { config } from "@fortawesome/fontawesome-svg-core";
import AnimationContainer from './components/layout/AnimationContainer';
import LoaderContainer from './components/Loader/LoaderContainer';
import LazyAsciiFluid from './components/layout/LazyAsciiFluid';
import { draftMode } from 'next/headers';
import { VisualEditing } from 'next-sanity/visual-editing';
import { SanityLive } from '@/sanity/lib/live';
import { DisableDraftMode } from './components/DisableDraftMode/DisableDraftMode';

config.autoAddCss = false;


const inter = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["100", "200", "300", "400", "500", "600", "700"],
  display: 'swap',
});


export const metadata: Metadata = {
  title: 'Home - Josh Martin\'s Website',
  description: 'This website showcase the work of Josh Martin.\
  A Chicago based (freelance) programmer who can create your next mobile app, web application or embedded project',
  alternates: {
    canonical: "https://cjoshmartin.com",
  },
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { isEnabled: isDraftMode } = await draftMode();

  return (
    <html lang="en">
      <body className={inter.className}>
        <LazyAsciiFluid
          className="fixed inset-0 -z-10"
          theme="dark"
          color="#85ffa7"
          backgroundColor="#000000"
        />
        <PlausibleProvider
          domain="cjoshmartin.com"
          selfHosted={true}
          customDomain="https://plausible.technicalchicago.com"
        >
            <div className={styles.bodyContent}>
              <div className={styles.innerBodyContent}>
                <Nav />
              <LoaderContainer>
                <AnimationContainer>
                  {children}
                  <Footer />
                </AnimationContainer>
              </LoaderContainer>
              </div>
            </div>
        </PlausibleProvider>
        <GoogleAnalytics gaId="G-P8XH0GSQTV" />
        {/* Live Content API: published edits appear without a redeploy; in Draft Mode it also streams draft changes. */}
        <SanityLive />
        {isDraftMode && (
          <>
            <VisualEditing />
            <DisableDraftMode />
          </>
        )}
      </body>
    </html>
  );
}