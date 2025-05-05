import styles from './UnlistedBanner.module.css';

export default function UnlistedBanner() {
  return (
    <div className={styles.container}>
      <b>
        <p>
          This page is unlisted. It is not publically available, and only viewable
          with link shared.
        </p>
      </b>
    </div>
  );
}