'use client'

import { DiscussionEmbed } from "disqus-react";

export default function Comments({slug, id, title}: any){
    return (
          <DiscussionEmbed
            shortname={slug}
            config={{
              url: `https://cjoshmartin.com/blog/${slug}`,
              identifier: `blog-${id}`,
              title: title,
            }}
          />
    )
}