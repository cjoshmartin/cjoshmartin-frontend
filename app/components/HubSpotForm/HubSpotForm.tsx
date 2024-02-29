'use client'

import { useEffect } from 'react';
import styles from './styles.module.css';

export default function HubSpotForm() {
    useEffect(() => {
      const script = document.createElement('script');
      script.src = 'https://js.hsforms.net/forms/v2.js';
      document.body.appendChild(script);
 
      script.addEventListener('load', () => {
        //@ts-ignore
         if(window.hbspt) {
        //@ts-ignore
            window.hbspt.forms.create({
               portalId: '45354979',
               formId: '99285fb1-d9d6-432f-a1ca-84b976bf37ed',
               target: '#hubspotForm'
            });
         }
      });
    }, []);
 
    return (
        <div
        className={styles.container}
        >
        <div id="hubspotForm" className={styles.hubspotForm}></div>
        </div>
    );
 }