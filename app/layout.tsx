import type { Metadata } from 'next'
import { IBM_Plex_Mono } from 'next/font/google'
import './globals.css'
import Nav from './components/layout/Nav';
import Footer from './components/layout/Footer';
import { PostHogProvider } from './components/PostHogProvider';
import { GoogleAnalytics } from '@next/third-parties/google'
import PlausibleProvider from 'next-plausible'

import styles from './layout.module.css'

import "@fortawesome/fontawesome-svg-core/styles.css";
import { config } from "@fortawesome/fontawesome-svg-core";
import AnimationContainer from './components/layout/AnimationContainer';
import LoaderContainer from './components/Loader/LoaderContainer';
config.autoAddCss = false;


const inter = IBM_Plex_Mono({ subsets: ['latin'], weight: ["100","200","300",'400',"500","600","700"] })


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
  return (
    <html lang="en">
      <body className={inter.className}>
        <PlausibleProvider
          domain="cjoshmartin.com"
          selfHosted={true}
          customDomain="https://plausible.technicalchicago.com"
        >
          <PostHogProvider>
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
          </PostHogProvider>
        </PlausibleProvider>
        <GoogleAnalytics gaId="G-P8XH0GSQTV" />
      </body>
    </html>
  );
}