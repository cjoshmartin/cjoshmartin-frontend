import styles from './PortfolioPreview.module.css'

import badIdeas from '@/public/preview/bad_ideas.png'
import sandbox from '@/public/preview/sandbox_carbon.png'
import simon from '@/public/preview/simon1.jpg'
import documentor from '@/public/preview/documentor.jpeg'


export default function PortfolioPreview(){
    return (
      <div className={styles.container}>
        <div>
          <h2> Recent (Client) Projects</h2>
          <p>These are the projects I have found to pay my bills so far and you can look at the kind of work I can help you with in the future</p>
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
                backgroundImage: `url(${badIdeas.src})`,
              }}
            />
            <div
              style={{
                padding: "1rem",
              }}
            >
              <h3>Bad Ideas (Online Card Game)</h3>
              <small>Design Concentric</small>
              <br />
              <small>Media: Web</small>
              <br />
              <small>
                <i>Technologies: Next.js(React.js), Framer Motion, Sanity CMS</i>
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
                backgroundImage: `url(${sandbox.src})`,
              }}
            />
            <div
              style={{
                padding: "1rem",
              }}
            >
              <h3>Device Data collection</h3>
              <small>Sandbox Carbon</small>
              <br />
              <small>Media: IoT</small>
              <br />
              <small>
                <i>Technologies: Arduino and Ubidots</i>
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
                backgroundImage: `url(${simon.src})`,
              }}
            />
            <div
              style={{
                padding: "1rem",
              }}
            >
              <h3>SIMON - Malls, Mills & Outlets</h3>
              <small>Simon Property Group</small>
              <br />
              <small>Media: Moblie</small>
              <br />
              <small>
                <i>Technologies: React Native, Redux, Firebase, Nativebase </i>
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
                backgroundImage: `url(${documentor.src})`,
              }}
            />
            <div
              style={{
                padding: "1rem",
              }}
            >
              <h3>Documentor (Mobile App)</h3>
              <small>Documentor</small>
              <br />
              <small>Media: Moblie</small>
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
