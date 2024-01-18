import bad_idea from '@/public/projects_list_items/bad_ideas.png'
import ShowImage from "@/app/blog/_compoents/ShowImage";
import styles from './projectPage.module.css';
import Link from 'next/link';

export default function Page({ params }: { params: { slug: string } }){
    return (
      <div className={styles.container}>
        <Link href="/projects">
          <u>{"<<< Go back"}</u>
        </Link>
        <ShowImage
          width={772}
          height={360}
          url={bad_idea.src}
          className={styles.headerImage}
        />
        <div className={styles.projectInfo}>
          <h2>Bad Ideas (Online Card Game)</h2>
          <h3 style={{ fontWeight: "400" }}>Client: Design Concentric</h3>
          <h4>Media: Web</h4>
          <h5>Technologies: Next.js(React.js), Framer Motion, Sanity CMS</h5>
        </div>
        <div className={styles.contentArea}>
          <p>
            ging can seem like an unregulated process: As time marches along,
            our cells and bodies inevitably accumulate dings and dents that
            cause dysfunctions, failures, and ultimately death. However, in 1993
            a discovery upended that interpretation of events. Researchers found
            a mutation in a single gene that doubled a worm’s life span;
            subsequent work showed that related genes, all involved in the
            response to insulin, are key regulators of aging in a host of
            animals, from worms and flies to humans. The discovery suggested
            that aging is not a random process—indeed, specific genes regulate
            it—and opened the door to further research into how aging proceeds
            at a molecular level. Recently, a set of papers documented a new
            biochemical pathway that regulates aging, one based on signals
            passed between mitochondria, the organelles best known as the
            powerhouse of the cell. Working with worms, the researchers found
            that damage to mitochondria in brain cells triggered a repair
            response that was then amplified, setting off similar reactions in
            mitochondria throughout the worm’s body. The effect of this repair
            activity was to extend the organism’s life span: The worms with
            repaired mitochondrial damage lived 50 percent longer. The
            mitochondria function as cellular walkie-talkies, sending messages
            throughout the body. What’s more, cells in the germline—the cells
            that produce eggs and sperm—were central to this anti-aging
            communication system. It’s a finding that adds new dimensions to the
            fertility concerns implied when people talk about aging and their
            “biological clock.” Some of the findings were reported in Science
            Advances and others were posted on the scientific preprint server
            biorxiv.org in the fall. The research builds on a recent body of
            work that suggests that mitochondria are social organelles that can
            talk to one another even when they are in different tissues. In
            essence, the mitochondria function as cellular walkie-talkies,
            sending messages throughout the body that influence the survival and
            life span of the entire organism. “The important thing here is that
            in addition to genetic programs, there is also a very important
            factor to regulate aging, which is the communication between
            tissues,” said David Vilchez, who studies aging at the University of
            Cologne and was not involved in the new research. The cell biologist
            Andrew Dillin discovered the first hints of this novel pathway that
            regulates life span about a decade ago. He was hunting for
            life-extending genes in Caenorhabditis elegans worms when he found
            that genetically damaging the mitochondria extended the worms’ lives
            by 50 percent. That was unexpected. Dillin had assumed that
            defective mitochondria would hasten death rather than prolong
            life—after all, mitochondria are central to cell functioning. Yet
            for some reason, gumming up the smooth functioning of the
            mitochondria compelled the worms to live longer. More intriguing was
            the fact that damaged mitochondria in the worms’ nervous system
            seemed to be driving the effect. “It really says that some
            mitochondria are more important than others,” said Dillin, who is
            now a professor at the University of California, Berkeley. “The
            neurons dictate this over the rest of the organism, and that was
            really surprising.”
          </p>
        </div>
      </div>
    );
}