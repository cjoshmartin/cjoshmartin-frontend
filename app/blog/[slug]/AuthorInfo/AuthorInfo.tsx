import ShowImage from '@/app/blog/_compoents/ShowImage';
import styles from './styles.module.css'

export function AuthorInfo({ bio, email, first_name, last_name, job_title, location, image }: any) {
  return (
    <div
      className={styles.container}
    >
      <ShowImage url={image?.file} width={400} className={styles.authorImage} />
      <div
       className={styles.jobInfo} 
      >
        <h2>{first_name} {last_name}</h2>
        <h3>{job_title}</h3>
        <h4>{email}</h4>
        {/* <h4>{location}</h4> */}
        <div dangerouslySetInnerHTML={{__html: bio}} />
      </div>
    </div>
  );
}
