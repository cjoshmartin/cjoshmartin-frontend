'use client'

import { DiscussionEmbed } from "disqus-react";

interface CommentsProps {
    slug: string
    /**
     * Disqus thread identifier: the Wagtail page id (as a string) for migrated pages, so existing
     * threads stay attached, and the Sanity document id for pages created in Sanity.
     */
    identifier: string
    /** Plain title (no stega characters): Disqus stores it on new threads. */
    title: string
}

export default function Comments({slug, identifier, title}: CommentsProps){
    // return <div />;

    // Both blog posts and projects have always used the /blog/<slug> URL for their Disqus thread.
    return (
          <DiscussionEmbed
            shortname={"cjoshmartin"}
            config={{
              url: `https://cjoshmartin.com/blog/${slug}`,
              identifier,
              title,
            }}
          />
    )
}
