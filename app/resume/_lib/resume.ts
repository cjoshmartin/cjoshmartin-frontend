const RESUME_URL = 'https://raw.githubusercontent.com/cjoshmartin-com/resume/refs/heads/master/index.html'

const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">'

/*
 * The resume HTML links `font/charter-font.css`, which its repository no longer contains, so the
 * Charter fonts never loaded (404 on /font/... and /resume/font/...). The same fonts are served
 * from public/fonts/charter. Its favicon link is http://, which is mixed content on this HTTPS
 * site; the site's own favicon is the same icon.
 */
const ASSET_LINK_FIXES: ReadonlyArray<readonly [string, string]> = [
    ['href="font/charter-font.css"', 'href="/fonts/charter/charter-font.css"'],
    ['href="http://www.cjoshmartin.com/favicon.ico"', 'href="/favicon.ico"'],
]

function removePhoneNumber(html: string): string {
    return html.replace(
        /\s*<span>•<\/span>\s*<a href="tel:[^"]*">[^<]*<\/a>/i,
        ''
    )
}

function fixAssetLinks(html: string): string {
    return ASSET_LINK_FIXES.reduce((result, [from, to]) => result.split(from).join(to), html)
}

function injectViewportMeta(html: string): string {
    if (html.includes('name="viewport"')) {
        return html
    }
    if (html.includes('<head>')) {
        return html.replace('<head>', `<head>\n${VIEWPORT_META}`)
    }
    return html.replace('<head', `${VIEWPORT_META}\n<head`)
}

export async function getCleanResumeHtml(): Promise<string> {
    const res = await fetch(RESUME_URL, {
        next: { revalidate: 3600 },
    })

    if (!res.ok) {
        throw new Error(`Failed to fetch resume: ${res.status}`)
    }

    const html = await res.text()
    return injectViewportMeta(fixAssetLinks(removePhoneNumber(html)))
}

export function injectBeforeBodyEnd(html: string, snippet: string): string {
    if (html.includes('</body>')) {
        return html.replace('</body>', `${snippet}</body>`)
    }
    return html + snippet
}
