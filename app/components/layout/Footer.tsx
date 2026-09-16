import styles from './layout.module.css';

export default function Footer() {
  return (
    <footer className={styles.footer}>
      <p className={styles.innerFooter}>
        <span
        style={{
          padding: '1rem',
        }}
        >
          <span style={{ backgroundColor: 'black' }}
          >
          <s>Hand</s>made by a <a href='https://claude.com/product/claude-code'>clanker</a> and <a href="https://github.com/cjoshmartin" target='_blank'>@cjoshmartin</a>,
          with <a href="https://www.djangoproject.com/" target='_blank'>Django</a>, <a href='https://nextjs.org/' target='_blank'>Next.js</a> and{" "}
          <a href="https://wagtail.org/" target='_blank'>Wagtail</a> (©{new Date().getFullYear()})
          </span>
        </span>
      </p>
    </footer>
  );
}
