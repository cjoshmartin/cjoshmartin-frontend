import styles from './AnimationContainer.module.css'

export default function AnimationContainer(props: any){

    return (
        <div className={styles.fadeInUp}>
            {props.children}
        </div>
    )
}
