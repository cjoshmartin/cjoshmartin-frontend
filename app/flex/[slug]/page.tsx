import { Metadata } from "next";
import { notFound } from "next/navigation";
import seo from '@/app/components/SEO'
import PortableTextBody from "@/app/components/PortableTextBody/PortableTextBody";
import { sanityFetch } from "@/sanity/lib/live";
import { FLEX_PAGE_QUERY, FLEX_PAGE_SEO_QUERY } from "@/sanity/lib/queries";
import styles from './flexPage.module.css'

type Props = { params: Promise<{ slug: string }> }

export async function generateMetadata(props: Props): Promise<Metadata> {
    const params = await props.params;
    const { data: page } = await sanityFetch({
        query: FLEX_PAGE_SEO_QUERY,
        params: { slug: params.slug },
        stega: false,
    })

    if (!page) {
        notFound()
    }

    return {
        title: `${page.seo?.title || page.title} - ${seo.sitename}`,
        // Without an SEO description the root layout's site description applies.
        ...(page.seo?.description ? { description: page.seo.description } : {}),
        alternates: {
            canonical: `https://cjoshmartin.com/flex/${params.slug}`,
        },
    }
}

export default async function Page(props: Props) {
    const params = await props.params;
    const { data: page } = await sanityFetch({
        query: FLEX_PAGE_QUERY,
        params: { slug: params.slug },
    })

    if (!page) {
        notFound()
    }

    const {title, body} = page;
    return (
        <div className={styles.container}>
            <h1>{title}</h1>
            <PortableTextBody value={body}/>
        </div>
    )
}
