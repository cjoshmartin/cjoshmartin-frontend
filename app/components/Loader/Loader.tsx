import styles from './Loader.module.css'

interface LoaderProps {
    size?: 'default' | 'small'
}

export default function Loader({ size = 'default' }: LoaderProps){

    return (
        <div className={`${styles.loaderContainer} ${size === 'small' ? styles.small : ''}`}>
                <div className={styles.InnerloaderContainer}>
                    <div className={styles.loader} />
                </div>
        </div>
    )
}