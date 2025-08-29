import ShowImage from '@/app/blog/_compoents/ShowImage/ShowImage';
import styles from './styles.module.css'

export function AuthorInfo({ bio, email, first_name, last_name, job_title, location, image, slug }: any) {
  return (
    <div className={styles.container}>
      <ShowImage url={image?.file} width={400} className={styles.authorImage} />
      <div className={styles.jobInfo}>
        <h2>
          {first_name} {last_name}
        </h2>
        <h3>{job_title}</h3>
        <h4>
          <a
            href={`mailto:${email}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "white" }}
          >
            {email}
          </a>
        </h4>
        <h4>{location}</h4>
        {slug !== "preview" && (
          <div dangerouslySetInnerHTML={{ __html: bio }} />
        )}
      </div>
    </div>
  );
}
