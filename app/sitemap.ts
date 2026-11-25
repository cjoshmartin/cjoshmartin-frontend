import { MetadataRoute } from 'next'
import { sanityFetch } from '@/sanity/lib/live';
import { SITEMAP_QUERY } from '@/sanity/lib/queries';

const baseURL = "https://cjoshmartin.com"

/** Sitemap order: the home page, then blog posts, then projects (each newest first). */
const TYPE_ORDER: Record<string, number> = { homePage: 0, blogPost: 1, project: 2 }

/**
 * The home page and every listed blog post and project. Unlisted pages and flex pages are left
 * out. `lastModified` is the document's last edit in Sanity.
 */
export default async function sitemap() :Promise<MetadataRoute.Sitemap> {
    const { data: pages } = await sanityFetch({
        query: SITEMAP_QUERY,
        perspective: 'published',
        stega: false,
    });

    return [...pages]
        .sort((a, b) => TYPE_ORDER[a._type] - TYPE_ORDER[b._type])
        .map((page): MetadataRoute.Sitemap[number] => {
            switch (page._type) {
                case 'homePage':
                    return {
                        url: `${baseURL}/`,
                        lastModified: page._updatedAt,
                        changeFrequency: 'weekly',
                    };
                case 'blogPost':
                    return {
                        url: `${baseURL}/blog/${page.slug}`,
                        lastModified: page._updatedAt,
                        changeFrequency: 'yearly',
                    };
                case 'project':
                    return {
                        url: `${baseURL}/projects/${page.slug}`,
                        lastModified: page._updatedAt,
                        changeFrequency: 'yearly',
                    };
            }
        });
}
