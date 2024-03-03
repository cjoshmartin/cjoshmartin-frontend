'use client';
import styles from './styles.module.css'

import HubSpotForm from "../components/HubSpotForm/HubSpotForm";
import TypeIt from 'typeit-react';

export default function Page(){

    return (
      <div className={styles.container}>
        <div className={styles.introSection}>
          <h1> Start A Project</h1>
          <div
            style={{
              padding: "0.5rem 1rem",
            }}
          >
            <span>Josh Martin</span>
            <br />
            <span>Chicago, IL</span>
            <br />
            <span>contact@cjoshmartin.com</span>
          </div>
          <div
            style={{
              maxWidth: '500px',
              padding: '1rem 2rem'
            }}
          >
            <TypeIt>
              Lets gather a little info about your project so we can better help
              you and get this process started!
            </TypeIt>
          </div>
          <HubSpotForm />
        </div>
      </div>
    );
}