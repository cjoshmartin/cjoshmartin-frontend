'use client'

import styles from './PersonalPortfolioPreview.module.css'

import ledHat from '@/public/personal_projects/hat.gif'
import nerf_gun from '@/public/personal_projects/gun.gif'
import miata_key from '@/public/personal_projects/miata_key.jpg'
import power_badge from '@/public/personal_projects/power_badge2.gif'


// Gifs have to be smaller then 10Mb is the requirement from the backend.
// you can create and edit your gifs in photoshop
/// Clips mostly should be under 2 seconds so that you can get high qulity gifs
export default function PortfolioPreview(){
    return (
      <div className={styles.container}>
        <div>
          <h2> Recent (Personal) Projects</h2>
          <p>These are the projects I have done for myself as a learning exercise and keep me going in the morning</p>
        </div>
        <br />
        <div className={styles.profileContainer}>
          <div
            style={{
              width: "200px",
            }}
          >
            <div
              className={styles.profileImage}
              style={{
                backgroundImage: `url(${nerf_gun.src})`,
              }}
            />
            <div
              style={{
                padding: "1rem",
              }}
            >
              <h3>Squid Games Nerf Gun</h3>
              <small>Media: Web, and IoT</small>
              <br />
              <small>
                <i>Technologies: Django, OpenCV, Python, Raspiberry Pi</i>
              </small>
            </div>
          </div>
          <div
            style={{
              width: "200px",
            }}
          >
            <div
              className={styles.profileImage}
              style={{
                backgroundImage: `url(${ledHat.src})`,
              }}
            />
            <div
              style={{
                padding: "1rem",
              }}
            >
              <h3>Venmo me @ Graduation</h3>
              <small>Media: IoT</small>
              <br />
              <small>
                <i>Technologies: javascript, Puppeter, Firebase, Python, Pillow, Raspiberry Pi</i>
              </small>
            </div>
          </div>
          <div
            style={{
              width: "200px",
            }}
          >
            <div
              className={styles.profileImage}
              style={{
                backgroundImage: `url(${miata_key.src})`,
              }}
            />
            <div
              style={{
                padding: "1rem",
              }}
            >
              <h3>Mazda Key Holder</h3>
              <small>Media: 3D printing and CAD</small>
              <br />
              <small>
                <i>Technologies: Fusion 360 </i>
              </small>
            </div>
          </div>
          <div
            style={{
              width: "200px",
            }}
          >
            <div
              className={styles.profileImage}
              style={{
                backgroundImage: `url(${power_badge.src})`,
              }}
            />
            <div
              style={{
                padding: "1rem",
              }}
            >
              <h3>SBA Power Badge</h3>
              <small>Media: Circuit Board Design </small>
              <br />
              <small>
                <i>Technologies: React Native, Redux toolkit, UI Kitten</i>
              </small>
            </div>
          </div>
        </div>
      </div>
    );
}
