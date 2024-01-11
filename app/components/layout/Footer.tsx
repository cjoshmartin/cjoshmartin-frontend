import styles from './layout.module.css';

export default function Footer() {
  return (
    <footer className={styles.footer}>
      <p className={styles.innerFooter}>
        <span>
          build by <a href="https://github.com/cjoshmartin" target='_blank'>@cjoshmartin</a>,
          with <a href="https://www.djangoproject.com/" target='_blank'>Django</a>, <a href='https://nextjs.org/'>Next.js</a> and{" "}
          <a href="https://wagtail.org/" target='_blank'>Wagtail</a> (©{new Date().getFullYear()})
        </span>
      </p>
    </footer>
  );
}