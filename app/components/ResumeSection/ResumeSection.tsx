import { Button } from "@/components/ui/button";
import styles from './styles.module.css'

export default function ResumeSection() {
    return (
        <div className={styles.container}>
            <h2>Want the Full Story?</h2>
            <Button
                size="lg"
                className="text-lg capitalize"
                nativeButton={false}
                render={
                    <a href="/resume" target="_blank" rel="noopener noreferrer" />
                }
            >
                View / Download Resume
            </Button>
        </div>
    )
}
